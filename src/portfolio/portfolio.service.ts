import { Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Kysely } from 'kysely';
import { ars, D, pct } from '../common/money';
import { DB, InjectDb } from '../db/database';
import { computeHoldings, latestPrices, loadLedger } from './ledger';
import { PortfolioDto } from './portfolio.dto';

const HUNDRED = new D(100);
/** (a - b) / b as a percentage; null when there is no base. */
const returnPct = (a: Decimal, b: Decimal) =>
  b.isZero() ? null : pct(a.minus(b).div(b).times(HUNDRED));

@Injectable()
export class PortfolioService {
  constructor(@InjectDb() private readonly db: Kysely<DB>) {}

  async getPortfolio(userId: number): Promise<PortfolioDto> {
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'accountnumber'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const holdings = computeHoldings(await loadLedger(this.db, userId));
    const held = [...holdings.positions].filter(([, p]) => p.quantity !== 0);
    const ids = held.map(([id]) => id);

    const [instruments, prices] = await Promise.all([
      ids.length
        ? this.db
            .selectFrom('instruments')
            .select(['id', 'ticker', 'name'])
            .where('id', 'in', ids)
            .execute()
        : [],
      latestPrices(this.db, ids),
    ]);
    const byId = new Map(instruments.map((i) => [i.id, i]));

    let positionsValue = new D(0);
    const positions = held.map(([id, p]) => {
      const price = prices.get(id);
      const marketValue = price?.close.times(p.quantity);
      if (marketValue) positionsValue = positionsValue.plus(marketValue);
      const hasCost = p.quantity > 0 && !p.costBasis.isZero();
      return {
        instrumentId: id,
        ticker: byId.get(id)!.ticker,
        name: byId.get(id)!.name,
        quantity: p.quantity,
        lastPrice: price ? ars(price.close) : null,
        marketValue: marketValue ? ars(marketValue) : null,
        averageCost: hasCost ? ars(p.costBasis.div(p.quantity)) : null,
        /** Market value vs. average-cost basis of the shares held. */
        totalReturnPct:
          marketValue && hasCost ? returnPct(marketValue, p.costBasis) : null,
        /** close vs. previousClose of the latest market data. */
        dailyReturnPct: price
          ? returnPct(price.close, price.previousclose)
          : null,
      };
    });
    positions.sort((a, b) => a.ticker.localeCompare(b.ticker));

    return {
      userId: user.id,
      accountNumber: user.accountnumber,
      /** Cash (including what NEW orders reserve) + market value of positions. */
      totalValue: ars(holdings.cash.plus(positionsValue)),
      /** Pesos available to trade: cash minus NEW buy orders. */
      availableCash: ars(holdings.cash.minus(holdings.reservedCash)),
      reservedCash: ars(holdings.reservedCash),
      positions,
    };
  }
}
