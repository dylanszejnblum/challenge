// Money and percentages are decimal strings, rounded to 2 decimals only here.

export class PositionDto {
  /** @example 47 */
  instrumentId!: number;
  /** @example PAMP */
  ticker!: string;
  /** @example "Pampa Holding S.A." */
  name!: string;
  /** Shares held. Negative only if the data has an oversold position. @example 40 */
  quantity!: number;
  /** Latest close; null when the instrument has no market data. @example "925.85" */
  lastPrice!: string | null;
  /** quantity × lastPrice. @example "37034.00" */
  marketValue!: string | null;
  /** Average cost per share held. @example "930.00" */
  averageCost!: string | null;
  /** Market value vs. average-cost basis, in %. @example "-0.45" */
  totalReturnPct!: string | null;
  /** close vs. previousClose of the latest market data, in %. @example "0.44" */
  dailyReturnPct!: string | null;
}

export class PortfolioDto {
  /** @example 1 */
  userId!: number;
  /** @example 10001 */
  accountNumber!: string;
  /** Cash (including what NEW orders reserve) + market value of positions. @example 889756.00 */
  totalValue!: string;
  /** Pesos available to trade: cash minus NEW buy orders. @example 627500.00 */
  availableCash!: string;
  /** Pesos committed to NEW buy orders. @example 125500.00 */
  reservedCash!: string;
  positions!: PositionDto[];
}
