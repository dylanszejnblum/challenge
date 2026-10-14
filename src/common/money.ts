import Decimal from 'decimal.js';

/**
 * Single decimal context for every money/price/percentage value in the app.
 * ROUND_HALF_UP matches Postgres `round()` on numeric, so app and DB never disagree.
 * Rounding only happens when formatting a response (`ars`, `pct`), never mid-calculation.
 */
export const D = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

/**
 * Max whole shares `amount` can buy at `price`.
 * `divToInt` truncates exactly; `div().floor()` would round the quotient first
 * and could hand out one share more than the money covers.
 */
export const maxShares = (amount: Decimal, price: Decimal): number =>
  amount.divToInt(price).toNumber();

export const ars = (d: Decimal): string => d.toFixed(2);
export const pct = (d: Decimal): string => d.toFixed(2);
