import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { ColumnType, Generated, Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import { D } from '../common/money';

// numeric → Decimal at the driver boundary: money never becomes a JS float.
types.setTypeParser(types.builtins.NUMERIC, (v) => new D(v));
// `timestamp without time zone` holds UTC; pg would otherwise read it as server-local time.
types.setTypeParser(
  types.builtins.TIMESTAMP,
  (v) => new Date(`${v.replace(' ', 'T')}Z`),
);
// Keep `date` as 'YYYY-MM-DD'; a JS Date would shift it by the process offset.
types.setTypeParser(types.builtins.DATE, (v) => v);

/** Max value of a Postgres `integer` (ids, orders.size). Validated at the edge so it never reaches the DB as an overflow. */
export const INT4_MAX = 2_147_483_647;

// Mirrors the CHECK constraints in db/migrations/001_integrity_and_indexes.sql.
export const ORDER_SIDES = ['BUY', 'SELL', 'CASH_IN', 'CASH_OUT'] as const;
export const ORDER_TYPES = ['MARKET', 'LIMIT'] as const;
export const ORDER_STATUSES = [
  'NEW',
  'FILLED',
  'REJECTED',
  'CANCELLED',
] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];
export type OrderType = (typeof ORDER_TYPES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Read as Decimal, written as a decimal string. */
type Numeric = ColumnType<Decimal, string, string>;

export interface DB {
  users: {
    id: Generated<number>;
    email: string;
    accountnumber: string;
  };
  instruments: {
    id: Generated<number>;
    ticker: string;
    name: string;
    type: string;
  };
  orders: {
    id: Generated<number>;
    instrumentid: number;
    userid: number;
    size: number;
    price: Numeric;
    type: OrderType;
    side: OrderSide;
    status: OrderStatus;
    datetime: ColumnType<Date, never, never>;
    idempotencykey: string | null;
    idempotencyhash: string | null;
  };
  marketdata: {
    id: Generated<number>;
    instrumentid: number;
    high: Numeric;
    low: Numeric;
    open: Numeric;
    close: Numeric;
    previousclose: Numeric;
    date: string;
  };
}

const logger = new Logger('Database');

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (starting up / recovery)
  '53300', // too_many_connections
  '57014', // query_canceled (statement_timeout)
]);

/**
 * True when the error means "the database can't serve us right now", as opposed
 * to a bug or a bad query. Those become 503 + Retry-After. Usually the transaction
 * rolled back, but if the connection drops during COMMIT the outcome is unknown:
 * an order must be retried with the same Idempotency-Key, which makes it safe.
 */
export function isDbUnavailable(err: unknown): boolean {
  // Duck-typed: errors from node's net/dns may come from another realm, where
  // `instanceof Error` is false.
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === 'string')
    return UNAVAILABLE_CODES.has(code) || code.startsWith('08'); // class 08: connection exception
  // pg-pool timeouts and dropped connections carry no code.
  return (
    typeof message === 'string' &&
    /timeout exceeded when trying to connect|Connection terminated/i.test(
      message,
    )
  );
}

const DB_TOKEN = Symbol('DB');
export const InjectDb = () => Inject(DB_TOKEN);

@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: () => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) throw new Error('DATABASE_URL is not set');
        const pool = new Pool({
          connectionString,
          max: Number(process.env.DB_POOL_MAX ?? 10),
          // Fail fast with a 503 instead of hanging the request when the DB is unreachable.
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          // A stuck query would hold the user's advisory lock; cap it server-side.
          statement_timeout: 10_000,
        });
        // An idle client losing its connection (DB restart, network blip) emits
        // 'error' on the pool; unhandled, that crashes the process. The pool drops
        // the client and opens a new one on the next query.
        pool.on('error', (err) =>
          logger.error(err, 'Idle Postgres client error'),
        );
        return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
      },
    },
  ],
  exports: [DB_TOKEN],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@InjectDb() private readonly db: Kysely<DB>) {}

  onApplicationShutdown() {
    return this.db.destroy();
  }
}
