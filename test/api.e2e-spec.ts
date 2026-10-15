import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

// Seed data (database.sql)
const ARS = 66;
const PAMP = 47; // latest close 925.85
const PGR = 3; // no market data
const CHEAP = 30; // CARC, latest close 7.00

let container: StartedPostgreSqlContainer;
let app: INestApplication<App>;
let pg: Client;

beforeAll(async () => {
  // Real Postgres, seeded exactly like docker-compose: provided data + our migration.
  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withCopyFilesToContainer([
      {
        source: resolve(__dirname, '../database.sql'),
        target: '/docker-entrypoint-initdb.d/01-database.sql',
      },
      {
        source: resolve(
          __dirname,
          '../db/migrations/001_integrity_and_indexes.sql',
        ),
        target: '/docker-entrypoint-initdb.d/02-migration.sql',
      },
    ])
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.LOG_LEVEL = 'silent';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  pg = new Client({ connectionString: container.getConnectionUri() });
  await pg.connect();
});

afterAll(async () => {
  await app?.close();
  await pg?.end();
  await container?.stop();
});

const http = () => request(app.getHttpServer());

const postOrder = (body: object, idempotencyKey?: string) => {
  const req = http().post('/orders').send(body);
  return idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req;
};

const buy = (userId: number, fields: object = {}) => ({
  userId,
  instrumentId: PAMP,
  side: 'BUY',
  type: 'MARKET',
  ...fields,
});

/** A fresh user per test keeps tests independent of each other and of order. */
async function userWithCash(pesos: number) {
  const { rows } = await pg.query<{ id: number }>(
    'INSERT INTO users (email, accountnumber) VALUES ($1, $2) RETURNING id',
    [`${randomUUID()}@test.com`, '99999'],
  );
  const userId = rows[0].id;
  if (pesos > 0)
    await postOrder({
      userId,
      instrumentId: ARS,
      side: 'CASH_IN',
      type: 'MARKET',
      size: pesos,
    }).expect(201);
  return userId;
}

const storedOrders = async (userId: number) =>
  (
    await pg.query<{ side: string; status: string }>(
      'SELECT side, status FROM orders WHERE userid = $1 ORDER BY id',
      [userId],
    )
  ).rows;

/** Waits until `n` queries are blocked on a lock (table or advisory). */
async function waitForBlockedQueries(n: number) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pg.query<{ count: string }>(
      'SELECT count(*) FROM pg_locks WHERE NOT granted',
    );
    if (Number(rows[0].count) >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Expected ${n} blocked queries`);
}

const portfolio = async (userId: number) =>
  (await http().get(`/users/${userId}/portfolio`).expect(200)).body as {
    availableCash: string;
    reservedCash: string;
    positions: { ticker: string; quantity: number }[];
  };

describe('POST /orders', () => {
  it('fills a MARKET buy at the last close and debits cash', async () => {
    const userId = await userWithCash(10_000);

    const { body } = await postOrder(buy(userId, { size: 10 })).expect(201);

    expect(body).toMatchObject({
      status: 'FILLED',
      size: 10,
      price: '925.85',
    });
    const p = await portfolio(userId);
    expect(p.availableCash).toBe('741.50'); // 10000 - 10 * 925.85
    expect(p.positions).toEqual([
      expect.objectContaining({ ticker: 'PAMP', quantity: 10 }),
    ]);
  });

  it('turns an amount into the max whole shares it covers', async () => {
    const userId = await userWithCash(10_000);

    const { body } = await postOrder(buy(userId, { amount: '5000' })).expect(
      201,
    );

    expect(body).toMatchObject({ status: 'FILLED', size: 5 }); // 5000 / 925.85 = 5.4
  });

  it('rejects an amount below one share without storing anything', async () => {
    const userId = await userWithCash(10_000);

    await postOrder(buy(userId, { amount: '900' })).expect(422);

    expect(await storedOrders(userId)).toHaveLength(1); // just the CASH_IN
  });

  it('stores a LIMIT order as NEW and reserves its cash', async () => {
    const userId = await userWithCash(1_000);

    const { body } = await postOrder(
      buy(userId, { type: 'LIMIT', size: 1, price: '900' }),
    ).expect(201);
    expect(body).toMatchObject({ status: 'NEW', price: '900.00' });

    // 100 pesos left to trade: a market buy at 925.85 no longer fits.
    const second = await postOrder(buy(userId, { size: 1 })).expect(201);
    expect(second.body.status).toBe('REJECTED');
    expect(await portfolio(userId)).toMatchObject({
      availableCash: '100.00',
      reservedCash: '900.00',
    });
  });

  it('stores a buy above the available cash as REJECTED', async () => {
    const userId = await userWithCash(100);

    const { body } = await postOrder(buy(userId, { size: 1 })).expect(201);

    expect(body.status).toBe('REJECTED');
    expect(await storedOrders(userId)).toEqual([
      { side: 'CASH_IN', status: 'FILLED' },
      { side: 'BUY', status: 'REJECTED' },
    ]);
    expect((await portfolio(userId)).availableCash).toBe('100.00');
  });

  it('stores a sell above the available shares as REJECTED, counting NEW sells', async () => {
    const userId = await userWithCash(10_000);
    await postOrder(buy(userId, { size: 2 })).expect(201);
    await postOrder(
      buy(userId, { side: 'SELL', type: 'LIMIT', size: 2, price: '1000' }),
    ).expect(201);

    const { body } = await postOrder(
      buy(userId, { side: 'SELL', size: 1 }),
    ).expect(201);

    expect(body.status).toBe('REJECTED');
  });

  it('stores a CASH_OUT above the available cash as REJECTED', async () => {
    const userId = await userWithCash(500);

    const { body } = await postOrder({
      userId,
      instrumentId: ARS,
      side: 'CASH_OUT',
      type: 'MARKET',
      size: 501,
    }).expect(201);

    expect(body.status).toBe('REJECTED');
  });

  it('does not let concurrent orders spend the same cash twice', async () => {
    const userId = await userWithCash(1_000); // covers exactly one share
    const N = 5;

    // Deterministic race: hold the orders table so every request blocks right
    // before reading the ledger, then release them all at once. Without the
    // per-user lock they all see the same balance and several get FILLED.
    const blocker = new Client({
      connectionString: container.getConnectionUri(),
    });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE orders IN ACCESS EXCLUSIVE MODE');

    const pending = Promise.all(
      Array.from({ length: N }, () => postOrder(buy(userId, { size: 1 }))),
    );
    await waitForBlockedQueries(N);
    await blocker.query('COMMIT');
    await blocker.end();
    const results = await pending;

    const statuses = results.map((r) => r.body.status as string);
    expect(statuses.filter((s) => s === 'FILLED')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'REJECTED')).toHaveLength(N - 1);
    expect((await portfolio(userId)).availableCash).toBe('74.15');
  });

  it('replays the original order for a repeated Idempotency-Key', async () => {
    const userId = await userWithCash(10_000);
    const key = randomUUID();

    const first = await postOrder(buy(userId, { size: 1 }), key).expect(201);
    const retry = await postOrder(buy(userId, { size: 1 }), key).expect(200);

    expect(retry.body).toEqual(first.body);
    expect(await storedOrders(userId)).toHaveLength(2); // CASH_IN + one BUY
  });

  it('refuses an Idempotency-Key reused with a different request', async () => {
    const userId = await userWithCash(10_000);
    const key = randomUUID();
    await postOrder(buy(userId, { size: 1 }), key).expect(201);

    await postOrder(buy(userId, { size: 2 }), key).expect(422);

    expect(await storedOrders(userId)).toHaveLength(2);
  });

  it('treats a price sent as number or string as the same request', async () => {
    const userId = await userWithCash(10_000);
    const key = randomUUID();
    const limit = { type: 'LIMIT', size: 1 };
    await postOrder(buy(userId, { ...limit, price: '900.50' }), key).expect(
      201,
    );

    await postOrder(buy(userId, { ...limit, price: 900.5 }), key).expect(200);
    await postOrder(buy(userId, { ...limit, price: '900.5' }), key).expect(200);
  });

  it('stamps datetime when the order executes, not when it started waiting', async () => {
    const userId = await userWithCash(10_000);

    // Hold the user's order lock, so the request waits inside its transaction.
    await pg.query('SELECT pg_advisory_lock(1, $1)', [userId]);
    const pending = Promise.resolve(postOrder(buy(userId, { size: 1 })));
    await waitForBlockedQueries(1);
    const { rows } = await pg.query<{ releasedAt: Date }>(
      `SELECT clock_timestamp() AT TIME ZONE 'utc' AS "releasedAt"`,
    );
    await pg.query('SELECT pg_advisory_unlock(1, $1)', [userId]);
    const { body } = await pending;

    // With now() (transaction start) it would be stamped before the release,
    // and the ledger could replay it before an order that actually ran first.
    expect(new Date(body.datetime as string).getTime()).toBeGreaterThanOrEqual(
      rows[0].releasedAt.getTime(),
    );
  });

  describe('invalid requests fail with problem+json and store nothing', () => {
    it.each([
      ['size and amount', { size: 1, amount: '1' }, 400],
      ['neither size nor amount', {}, 400],
      ['LIMIT without price', { type: 'LIMIT', size: 1 }, 400],
      ['MARKET with price', { size: 1, price: '1' }, 400],
      [
        'price with 3 decimals',
        { type: 'LIMIT', size: 1, price: '1.005' },
        400,
      ],
      ['fractional size', { size: 1.5 }, 400],
      ['BUY of the cash instrument', { instrumentId: ARS, size: 1 }, 400],
      ['unknown instrument', { instrumentId: 99_999, size: 1 }, 404],
      ['MARKET without market data', { instrumentId: PGR, size: 1 }, 422],
      [
        'instrumentId above int4',
        { instrumentId: 3_000_000_000, size: 1 },
        400,
      ],
      // 9999999999999 / 7.00 (CAPX... any cheap close) > int4 shares
      [
        'amount that buys more than int4 shares',
        { instrumentId: CHEAP, amount: '9999999999999' },
        422,
      ],
    ])('%s → %i', async (_, fields, status) => {
      const userId = await userWithCash(10_000);

      const res = await postOrder(buy(userId, fields)).expect(status);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({ status });
      expect(await storedOrders(userId)).toHaveLength(1);
    });

    it('unknown user → 404', async () => {
      await postOrder(buy(99_999, { size: 1 })).expect(404);
    });

    it('userId above int4 → 400', async () => {
      await postOrder(buy(3_000_000_000, { size: 1 })).expect(400);
    });

    it('body above the size limit → 413', async () => {
      await postOrder({ padding: 'x'.repeat(200_000) }).expect(413);
    });
  });
});

describe('POST /orders/:id/cancel', () => {
  it('cancels a NEW order and releases its reservation', async () => {
    const userId = await userWithCash(1_000);
    const { body: order } = await postOrder(
      buy(userId, { type: 'LIMIT', size: 1, price: '900' }),
    ).expect(201);

    const { body } = await http()
      .post(`/orders/${order.id}/cancel`)
      .expect(200);

    expect(body.status).toBe('CANCELLED');
    expect((await portfolio(userId)).availableCash).toBe('1000.00');
  });

  it('refuses to cancel an order that is not NEW', async () => {
    const userId = await userWithCash(10_000);
    const { body: order } = await postOrder(buy(userId, { size: 1 })).expect(
      201,
    );

    await http().post(`/orders/${order.id}/cancel`).expect(409);
  });
});

describe('GET /users/:id/portfolio', () => {
  it('derives the seeded user from the orders ledger', async () => {
    const { body } = await http().get('/users/1/portfolio').expect(200);

    expect(body).toMatchObject({
      totalValue: '889756.00',
      availableCash: '627500.00', // 753000 cash - 125500 in NEW limit buys
      reservedCash: '125500.00',
    });
    expect(body.positions).toContainEqual(
      expect.objectContaining({
        ticker: 'PAMP',
        quantity: 40,
        averageCost: '930.00',
        totalReturnPct: '-0.45',
      }),
    );
  });
});

describe('GET /instruments', () => {
  it('rejects a NUL byte with 400, and never lets an error be cached', async () => {
    const res = await http().get('/instruments?q=a%00b').expect(400);

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('finds by name, case-insensitively, and never returns cash', async () => {
    const pampa = await http().get('/instruments?q=pampa').expect(200);
    const pesos = await http().get('/instruments?q=pesos').expect(200);

    expect(pampa.body[0]).toMatchObject({ ticker: 'PAMP' });
    expect(pesos.body).toEqual([]);
  });
});

describe('GET /health', () => {
  it('is up when the database is reachable', async () => {
    await http().get('/health').expect(200, { status: 'ok', database: 'up' });
  });
});

describe('database unavailable', () => {
  let downApp: INestApplication<App>;

  beforeAll(async () => {
    // Same app, pointed at a port nobody listens on.
    const url = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://cocos:cocos@127.0.0.1:1/cocos';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    downApp = moduleRef.createNestApplication();
    configureApp(downApp);
    await downApp.init();
    process.env.DATABASE_URL = url;
  });

  afterAll(() => downApp?.close());

  it('reports unhealthy', async () => {
    await request(downApp.getHttpServer()).get('/health').expect(503);
  });

  it('answers 503 problem+json with Retry-After instead of a 500', async () => {
    const res = await request(downApp.getHttpServer())
      .get('/users/1/portfolio')
      .expect(503)
      .expect('Content-Type', /application\/problem\+json/)
      .expect('Retry-After', '5');
    expect(res.body.detail).toBe('Database unavailable, retry later');
  });
});
