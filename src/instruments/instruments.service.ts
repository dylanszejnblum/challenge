import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DB, InjectDb } from '../db/database';

const SEARCH_LIMIT = 20;

@Injectable()
export class InstrumentsService {
  constructor(@InjectDb() private readonly db: Kysely<DB>) {}

  /**
   * Case-insensitive substring match on ticker or name (trigram-indexed).
   * Ranking: exact ticker, then ticker prefix, then alphabetical.
   * Cash (MONEDA) is not a tradable asset, so it is excluded.
   */
  search(q: string) {
    const term = q.replace(/[\\%_]/g, '\\$&'); // user input is literal, not a LIKE pattern
    return this.db
      .selectFrom('instruments')
      .select(['id', 'ticker', 'name', 'type'])
      .where('type', '<>', 'MONEDA')
      .where((eb) =>
        eb.or([
          eb('ticker', 'ilike', `%${term}%`),
          eb('name', 'ilike', `%${term}%`),
        ]),
      )
      .orderBy(sql`upper(ticker) = upper(${q})`, 'desc')
      .orderBy(sql`ticker ilike ${`${term}%`}`, 'desc')
      .orderBy('ticker')
      .limit(SEARCH_LIMIT)
      .execute();
  }
}
