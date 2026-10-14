# cocos-challenge-backend

API REST para consultar el portfolio de un usuario, buscar activos y enviar órdenes al mercado.

NestJS 11 · Node 24 · TypeScript · PostgreSQL 18 · Kysely · decimal.js · Jest + Testcontainers

## Cómo correrlo

Requisitos: Docker. Para desarrollo local también Node 24 (`nvm use`) y pnpm (`corepack enable`).

```bash
docker compose up --build
```

Esto levanta Postgres con los datos del challenge más la migración, y la API en `http://localhost:3000`. Swagger queda en `http://localhost:3000/docs` y hay ejemplos listos en [`requests.http`](requests.http) (REST Client de VS Code o el HTTP Client de JetBrains). Si el 3000 o el 5432 están ocupados: `API_PORT=3001 DB_PORT=5433 docker compose up --build`.

Desarrollo local:

```bash
pnpm install
pnpm db:up          # solo Postgres
cp .env.example .env
pnpm start:dev
```

Tests:

```bash
pnpm test           # unitarios: dinero (property test) y ledger
pnpm test:e2e       # funcionales contra Postgres real (necesita Docker)
pnpm lint
```

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/instruments?q=` | Busca por ticker y/o nombre |
| `GET` | `/users/:userId/portfolio` | Valor total, pesos disponibles y posiciones |
| `POST` | `/orders` | Envía una orden (`BUY`/`SELL` `MARKET`/`LIMIT`, `CASH_IN`/`CASH_OUT`) |
| `POST` | `/orders/:id/cancel` | Cancela una orden `NEW` |

### `POST /orders`

```json
{ "userId": 1, "instrumentId": 47, "side": "BUY", "type": "LIMIT", "size": 10, "price": "930.50" }
```

- Se manda `size` (cantidad de acciones) **o** `amount` (pesos a invertir), nunca los dos. Con `amount` se calcula la máxima cantidad de acciones enteras que cubre.
- `price` es obligatorio en `LIMIT` y no se acepta en `MARKET`, que se ejecuta al último `close`.
- Header opcional `Idempotency-Key`: si se reintenta con la misma key se devuelve la orden original con `200` en lugar de crear otra.

| Resultado | HTTP | ¿Se guarda? |
|---|---|---|
| `MARKET` ejecutada | 201, `FILLED` | Sí |
| `LIMIT` aceptada | 201, `NEW` | Sí |
| Sin pesos o acciones suficientes | 201, `REJECTED` | Sí, como pide el enunciado |
| Payload inválido, usuario o instrumento inexistente | 400 / 404 | No |
| `MARKET` sobre un activo sin precio, o un monto que no alcanza para 1 acción | 422 | No |

La distinción es intencional: `REJECTED` es una decisión de negocio sobre una orden bien formada, y queda en el historial del usuario. Un request mal formado no es una orden y no tiene sentido persistirlo.

Todos los errores salen como [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`.

### `GET /users/:userId/portfolio`

```json
{
  "userId": 1,
  "accountNumber": "10001",
  "totalValue": "889756.00",
  "availableCash": "627500.00",
  "reservedCash": "125500.00",
  "positions": [
    {
      "instrumentId": 47, "ticker": "PAMP", "name": "Pampa Holding S.A.",
      "quantity": 40, "lastPrice": "925.85", "marketValue": "37034.00",
      "averageCost": "930.00", "totalReturnPct": "-0.45", "dailyReturnPct": "0.44"
    }
  ]
}
```

## Arquitectura

![Arquitectura](docs/architecture.svg)

El diagrama editable está en [`docs/architecture.excalidraw`](docs/architecture.excalidraw) (se abre en excalidraw.com). A la izquierda está lo que hay en este repo; a la derecha, cómo evolucionaría en producción sin tirar nada de lo construido.

```
src/
  common/money.ts          contexto decimal único y división truncada exacta
  common/problem.filter.ts errores RFC 9457
  db/database.ts           Kysely, tipos de las tablas y parsers de pg
  instruments/             búsqueda
  portfolio/ledger.ts      cálculo de cash y posiciones (fuente única de verdad)
  portfolio/               endpoint de portfolio
  orders/                  envío y cancelación de órdenes
db/migrations/             cambios sobre database.sql
test/api.e2e-spec.ts       tests funcionales
```

No hay capa de repositorios: cada service usa Kysely directo. Con una sola base y sin planes de cambiarla, una interfaz por repositorio sería indirección sin beneficio.

## Decisiones técnicas

**NestJS.** Módulos, inyección de dependencias y `ValidationPipe` dan una estructura conocida sin tener que inventarla. El plugin de Swagger genera la documentación a partir de los DTOs, así que la doc no se desincroniza del código.

**Kysely en lugar de un ORM.** El dominio es chico pero sensible: transacciones explícitas, un advisory lock, `DISTINCT ON` para el último precio y columnas `numeric`. Kysely tipa las queries contra el esquema sin esconder el SQL. TypeORM o Prisma agregan una capa de mapeo que acá no aporta y complica justo las partes delicadas (numeric, locks).

**Plata en decimal, nunca en `number`.** `0.1 + 0.2` en float no da `0.3`, y en un broker eso no es aceptable.
- El driver convierte `numeric` directo a `decimal.js` (`db/database.ts`), así que un monto nunca pasa por float.
- Toda la aritmética usa un único contexto (`common/money.ts`) con `ROUND_HALF_UP`, la misma semántica que `round()` de Postgres.
- Se redondea una sola vez, al armar la respuesta. Los montos viajan como string en el JSON para que el cliente tampoco los convierta a float.
- La cantidad de acciones para un monto usa `divToInt`, que trunca exacto. `div().floor()` redondea el cociente antes de truncar y en un caso borde puede dar una acción de más. Hay un property test (fast-check) que verifica `qty × price ≤ amount < (qty + 1) × price` para miles de combinaciones.
- La API rechaza precios y montos con más de 2 decimales en lugar de aceptarlos: `orders.price` es `numeric(10,2)` y Postgres los redondearía en silencio.

**Un solo cálculo de saldos (`portfolio/ledger.ts`).** El portfolio y la validación de órdenes usan la misma función pura, que recorre las órdenes del usuario en orden cronológico. Si fueran dos implementaciones, tarde o temprano el portfolio mostraría un saldo distinto del que se valida al operar.

**Costo promedio ponderado para el rendimiento.** Las compras suman costo, y las ventas sacan costo al promedio vigente. Esto necesita recorrer las órdenes en orden: un `SUM(costo) / SUM(cantidad)` en SQL da mal en cuanto se cierra y se reabre una posición (hay un test unitario con ese caso).

**Órdenes `NEW` reservan saldo.** Una `LIMIT` de compra pendiente compromete sus pesos y una de venta compromete sus acciones. Si no, un usuario podría dejar varias órdenes límite que juntas superan lo que tiene. `availableCash` ya descuenta lo reservado, y cancelar libera la reserva.

**Concurrencia: `pg_advisory_xact_lock(userId)`.** Cada orden corre en una transacción que primero toma un lock por usuario. Sin eso, dos órdenes simultáneas leen el mismo saldo, pasan las dos la validación y el usuario gasta dos veces la misma plata.
- Es por usuario, así que no bloquea a los demás.
- Es transaccional: se libera solo con el commit o el rollback y funciona detrás de poolers en modo transacción (PgBouncer, el pooler de Neon), donde un lock de sesión no sería confiable.
- El test de concurrencia es determinístico: bloquea la tabla hasta que todas las requests están esperando y las libera juntas. Lo verifiqué sacando el lock: el test falla con 5 de 5 órdenes `FILLED` teniendo plata para una sola.

**Cancelación sin lock.** `UPDATE ... WHERE id = $1 AND status = 'NEW'` es atómico: si dos requests compiten, solo una cambia la fila.

**Idempotency-Key.** Si un cliente hace timeout y reintenta un `POST /orders`, sin esto compra dos veces. La key se guarda con la orden con un índice único parcial `(userid, idempotencykey)`, y como la verificación ocurre dentro del lock del usuario no hay carrera entre el reintento y el original.

**Caché solo donde no puede dañar.** `GET /instruments` responde con `Cache-Control: public, max-age=300` y Express agrega el ETag, así que el cliente o un CDN pueden cachear el catálogo sin infraestructura extra. Saldos, posiciones y portfolio **no se cachean nunca**: un saldo viejo en el camino de una orden es exactamente el doble gasto que evita el lock. No agregué Redis porque no hay un problema medido que lo justifique; con los índices, las queries tardan menos de un milisegundo.

**Tests funcionales contra Postgres real.** Testcontainers levanta Postgres 18 con el mismo `database.sql` y la misma migración que `docker compose`. No hay mocks de base: los locks, los constraints y el tipo `numeric` son justamente lo que hay que probar. Cada test crea su propio usuario, así no dependen del orden ni entre sí.

**Node 24.** Testcontainers 12 requiere Node ≥ 22.22, y Kysely 0.29 y `@nestjs/swagger` 12 se publican solo como ESM. Node 24 (LTS activa) los carga desde CommonJS, y Jest lo soporta con `--experimental-vm-modules`, que está en los scripts de test. Preferí eso a fijar versiones viejas.

**Extras.** Logs estructurados con pino y `x-request-id` (se respeta el que manda el cliente o el gateway, y si no se genera uno). CI en GitHub Actions corre lint, build, tests unitarios y e2e.

## Base de datos

`database.sql` es un `pg_dump` de la base provista, sin modificaciones. Los cambios están en [`db/migrations/001_integrity_and_indexes.sql`](db/migrations/001_integrity_and_indexes.sql), que `docker compose` aplica después del seed:

| Cambio | Por qué |
|---|---|
| `NOT NULL` y `CHECK` en `orders` (side, type, status, `size > 0`, `price > 0`) | La base rechaza lo que la app nunca debería escribir, aunque haya un bug |
| `orders.datetime` con default `now() AT TIME ZONE 'utc'` | La columna no tiene zona horaria; se guarda siempre en UTC |
| `orders.idempotencykey` + índice único parcial `(userid, idempotencykey)` | Reintentos idempotentes de `POST /orders` |
| Índice `orders (userid, datetime, id)` | Es exactamente el acceso del ledger: órdenes de un usuario en orden cronológico |
| `UNIQUE marketdata (instrumentid, date)` | Un precio por activo por día; también sirve para buscar el último precio |
| `UNIQUE instruments (ticker)` y `NOT NULL` | El ticker es un identificador |
| `pg_trgm` + índices GIN en ticker y nombre | `ILIKE '%q%'` no usa un btree; con trigramas sí usa índice |

Con 66 activos y 11 órdenes todo esto parece de más, pero los constraints son sobre todo de integridad y los índices son los que haría falta con datos reales.

No modifiqué la base compartida de Neon: todo corre sobre el Postgres local.

## Suposiciones e interpretación del enunciado

- **Pesos disponibles** = cash por movimientos `FILLED` menos lo reservado por compras `NEW`. **Valor total** = cash (incluido lo reservado, que sigue siendo del usuario) más el valor de mercado de las posiciones.
- **Rendimiento total** = valor de mercado contra costo promedio de las acciones en cartera. Además devuelvo el **rendimiento diario** (`close` contra `previousClose`), que el enunciado menciona aparte.
- **Cash.** Se identifica por `type = 'MONEDA'` (ARS, id 66), no por un id fijo. `CASH_IN`/`CASH_OUT` usan ese instrumento, son `MARKET` y van por el mismo `POST /orders`. Como `orders.size` es `integer` y guarda los pesos, las transferencias son en pesos enteros: un monto con centavos se rechaza en vez de truncarse.
- **Las órdenes `LIMIT` quedan `NEW`.** No simulo el mercado, como indica el enunciado, así que nunca pasan solas a `FILLED`.
- **`MARKET` sobre un activo sin precio** (PGR e IRCP no tienen `marketdata`) responde 422: no hay precio con el cual ejecutar ni con el cual registrarla.
- **La búsqueda** excluye MONEDA, prioriza ticker exacto y después prefijo, y devuelve como máximo 20 resultados. Los `%` y `_` del input se toman como texto literal.
- **Sin autenticación**, como indica el enunciado: el usuario viaja en la ruta o en el body, y cualquiera puede cancelar cualquier orden por id.
- **Idempotency-Key** devuelve la orden original sin comparar el body. Guardar un hash del request permitiría responder 422 si se reutiliza la key con otro contenido.

## Lo que encontré en los datos

- `marketdata` tiene la columna `date`, no `datetime` como dice el enunciado, y todas las columnas están en minúscula (`instrumentid`, `previousclose`).
- `price` y los precios de `marketdata` son `numeric(10,2)`; `size` es `integer`.
- **El seed tiene una venta en descubierto:** el usuario 1 compra 20 BMA y vende 30, ambas `FILLED`, y queda en −10. El portfolio lo muestra tal cual porque es lo que dice el ledger (sin costo promedio ni rendimiento, porque no aplican), y el flujo actual rechaza esa venta.

## Producción

Lo que agregaría en un entorno real, en el orden en que lo haría falta:

1. **Auth y rate limiting** en el gateway; el `userId` sale del token y no del request.
2. **Réplicas de la API.** Es stateless, así que escala horizontalmente sin cambios.
3. **Proyección de posiciones.** Hoy el ledger recorre todas las órdenes del usuario en cada request (O(n)). Con volumen real, una tabla `positions` actualizada en la misma transacción que cada ejecución. No es event sourcing, es una tabla derivada que nunca se desincroniza.
4. **Precios en vivo.** Un market data feed que escribe en Redis (la API solo lee). Saldos y posiciones siguen leyéndose del primary dentro de la transacción.
5. **Mercado real.** Las órdenes se escriben en una tabla outbox en la misma transacción; un relay las envía al mercado y un consumer aplica los fills (`NEW → FILLED`). El outbox evita el dual-write: no puede quedar una orden guardada sin enviar ni enviada sin guardar.
6. **Read replica** para la búsqueda y el historial, que toleran unos milisegundos de atraso. Lo que toca plata va siempre al primary.

Lo que **no** haría todavía: CQRS, event sourcing, microservicios o una caché de saldos. Cada uno resuelve un problema que este sistema no tiene, y lo pagaría en complejidad desde el primer día.
