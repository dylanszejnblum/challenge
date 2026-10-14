import Decimal from 'decimal.js';
import { Kysely } from 'kysely';
import { D } from '../common/money';
import { DB, OrderSide, OrderStatus } from '../db/database';

export interface LedgerOrder {
  instrumentid: number;
  side: OrderSide;
  status: OrderStatus;
  size: number;
  price: Decimal;
}

export interface Position {
  quantity: number;
  /** Shares committed to NEW sell orders. */
  reservedQuantity: number;
  /** Average-cost basis of the shares currently held. */
  costBasis: Decimal;
}

export interface Holdings {
  cash: Decimal;
  /** Pesos committed to NEW buy orders. */
  reservedCash: Decimal;
  positions: Map<number, Position>;
}

/**
 * Single source of truth for cash and positions, used both by the portfolio
 * and by order validation. Replays the user's FILLED orders in chronological
 * order and accumulates what NEW orders reserve.
 *
 * Cost basis uses the average-cost method: buys add their cost, sells remove
 * cost at the current average, so the average only changes on buys. This needs
 * the chronological replay; a single SQL aggregate would get it wrong as soon
 * as a position is sold and bought again.
 *
 * ponytail: O(orders of the user) per call. Upgrade path is a `positions` table
 * updated in the same transaction as each fill.
 */
export function computeHoldings(orders: LedgerOrder[]): Holdings {
  const h: Holdings = {
    cash: new D(0),
    reservedCash: new D(0),
    positions: new Map(),
  };
  const position = (id: number) => {
    let p = h.positions.get(id);
    if (!p) {
      p = { quantity: 0, reservedQuantity: 0, costBasis: new D(0) };
      h.positions.set(id, p);
    }
    return p;
  };

  for (const o of orders) {
    const notional = o.price.times(o.size);

    if (o.status === 'NEW') {
      if (o.side === 'BUY') h.reservedCash = h.reservedCash.plus(notional);
      if (o.side === 'SELL')
        position(o.instrumentid).reservedQuantity += o.size;
      continue;
    }
    if (o.status !== 'FILLED') continue;

    switch (o.side) {
      case 'CASH_IN':
        h.cash = h.cash.plus(o.size);
        break;
      case 'CASH_OUT':
        h.cash = h.cash.minus(o.size);
        break;
      case 'BUY': {
        const p = position(o.instrumentid);
        h.cash = h.cash.minus(notional);
        p.quantity += o.size;
        p.costBasis = p.costBasis.plus(notional);
        break;
      }
      case 'SELL': {
        const p = position(o.instrumentid);
        h.cash = h.cash.plus(notional);
        // Remove the sold shares at average cost. Selling everything (or more,
        // which the seed data does once) leaves no cost basis.
        p.costBasis =
          o.size >= p.quantity
            ? new D(0)
            : p.costBasis.minus(p.costBasis.times(o.size).div(p.quantity));
        p.quantity -= o.size;
        break;
      }
    }
  }
  return h;
}

/** FILLED and NEW orders of a user, oldest first: the input of `computeHoldings`. */
export function loadLedger(db: Kysely<DB>, userId: number) {
  return db
    .selectFrom('orders')
    .select(['instrumentid', 'side', 'status', 'size', 'price'])
    .where('userid', '=', userId)
    .where('status', 'in', ['FILLED', 'NEW'])
    .orderBy('datetime')
    .orderBy('id')
    .execute();
}

/** Latest close and previous close per instrument. */
export async function latestPrices(db: Kysely<DB>, instrumentIds: number[]) {
  const rows =
    instrumentIds.length === 0 // `IN ()` is invalid SQL
      ? []
      : await db
          .selectFrom('marketdata')
          .distinctOn('instrumentid')
          .select(['instrumentid', 'close', 'previousclose'])
          .where('instrumentid', 'in', instrumentIds)
          .orderBy('instrumentid')
          .orderBy('date', 'desc')
          .execute();
  return new Map(rows.map((r) => [r.instrumentid, r]));
}
