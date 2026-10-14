import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
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
        return new Kysely<DB>({
          dialect: new PostgresDialect({
            pool: new Pool({ connectionString }),
          }),
        });
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
