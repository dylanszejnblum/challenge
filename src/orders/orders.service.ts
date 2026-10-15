import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import { Kysely, Selectable, sql } from 'kysely';
import { ars, D, maxShares } from '../common/money';
import { DB, INT4_MAX, InjectDb, OrderStatus } from '../db/database';
import { computeHoldings, latestPrices, loadLedger } from '../portfolio/ledger';
import { CreateOrderDto } from './create-order.dto';
import { OrderDto } from './order.dto';

/** Namespace for pg_advisory_xact_lock(namespace, userId), so other locks can't collide. */
const ORDERS_LOCK = 1;

export type OrderRow = Selectable<DB['orders']>;

export const toOrderResponse = (o: OrderRow): OrderDto => ({
  id: o.id,
  userId: o.userid,
  instrumentId: o.instrumentid,
  side: o.side,
  type: o.type,
  size: o.size,
  price: ars(o.price),
  status: o.status,
  datetime: o.datetime,
});

@Injectable()
export class OrdersService {
  constructor(@InjectDb() private readonly db: Kysely<DB>) {}

  /**
   * Validation errors (bad payload, unknown user/instrument, nothing to buy)
   * throw and persist nothing. Business rejections (not enough cash/shares)
   * are persisted as REJECTED, as the challenge requires.
   *
   * Returns `replayed: true` when the Idempotency-Key was already used.
   */
  async create(dto: CreateOrderDto, idempotencyKey?: string) {
    assertShape(dto);
    const requestHash = idempotencyKey ? hashRequest(dto) : null;

    return this.db.transaction().execute(async (trx) => {
      // Serialize orders per user: two concurrent orders can't both pass the
      // balance check. Transaction-scoped, so it is released on commit/rollback
      // and is safe behind a transaction-mode pooler (PgBouncer, Neon).
      await sql`select pg_advisory_xact_lock(${ORDERS_LOCK}, ${dto.userId})`.execute(
        trx,
      );

      if (idempotencyKey) {
        const existing = await trx
          .selectFrom('orders')
          .selectAll()
          .where('userid', '=', dto.userId)
          .where('idempotencykey', '=', idempotencyKey)
          .executeTakeFirst();
        if (existing) {
          // Same key, different request: almost surely a client bug. Replaying the
          // old order would hide it (draft-ietf-httpapi-idempotency-key-header → 422).
          if (existing.idempotencyhash !== requestHash)
            throw new UnprocessableEntityException(
              'Idempotency-Key was already used with a different request',
            );
          return { order: existing, replayed: true };
        }
      }

      const [user, instrument] = await Promise.all([
        trx
          .selectFrom('users')
          .select('id')
          .where('id', '=', dto.userId)
          .executeTakeFirst(),
        trx
          .selectFrom('instruments')
          .select(['id', 'type'])
          .where('id', '=', dto.instrumentId)
          .executeTakeFirst(),
      ]);
      if (!user) throw new NotFoundException(`User ${dto.userId} not found`);
      if (!instrument)
        throw new NotFoundException(`Instrument ${dto.instrumentId} not found`);

      const isCash = dto.side === 'CASH_IN' || dto.side === 'CASH_OUT';
      if (isCash !== (instrument.type === 'MONEDA'))
        throw new BadRequestException(
          isCash
            ? 'CASH_IN/CASH_OUT orders must use the cash (MONEDA) instrument'
            : 'BUY/SELL orders cannot use the cash (MONEDA) instrument',
        );

      const price = await this.priceFor(trx, dto, isCash);
      const size = sizeFor(dto, price, isCash);

      const holdings = computeHoldings(await loadLedger(trx, dto.userId));
      const availableCash = holdings.cash.minus(holdings.reservedCash);
      const position = holdings.positions.get(dto.instrumentId);
      const availableShares = position
        ? position.quantity - position.reservedQuantity
        : 0;

      const affordable =
        dto.side === 'BUY'
          ? price.times(size).lte(availableCash)
          : dto.side === 'CASH_OUT'
            ? availableCash.gte(size)
            : dto.side === 'SELL'
              ? size <= availableShares
              : true; // CASH_IN
      const status: OrderStatus = !affordable
        ? 'REJECTED'
        : dto.type === 'LIMIT'
          ? 'NEW'
          : 'FILLED';

      const order = await trx
        .insertInto('orders')
        .values({
          userid: dto.userId,
          instrumentid: dto.instrumentId,
          side: dto.side,
          type: dto.type,
          size,
          price: price.toFixed(2),
          status,
          idempotencykey: idempotencyKey ?? null,
          idempotencyhash: requestHash,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { order, replayed: false };
    });
  }

  /**
   * Only NEW orders can be cancelled. The conditional UPDATE is atomic, so a
   * concurrent cancel/fill can't both win; no lock needed.
   */
  async cancel(id: number) {
    const cancelled = await this.db
      .updateTable('orders')
      .set({ status: 'CANCELLED' })
      .where('id', '=', id)
      .where('status', '=', 'NEW')
      .returningAll()
      .executeTakeFirst();
    if (cancelled) return cancelled;

    const order = await this.db
      .selectFrom('orders')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    throw new ConflictException(
      `Only NEW orders can be cancelled; order ${id} is ${order.status}`,
    );
  }

  private async priceFor(
    trx: Kysely<DB>,
    dto: CreateOrderDto,
    isCash: boolean,
  ): Promise<Decimal> {
    if (isCash) return new D(1); // cash is modeled as an instrument priced at 1 peso
    if (dto.type === 'LIMIT') return new D(dto.price!);
    const md = (await latestPrices(trx, [dto.instrumentId])).get(
      dto.instrumentId,
    );
    if (!md)
      throw new UnprocessableEntityException(
        `Instrument ${dto.instrumentId} has no market data; MARKET orders need a last price`,
      );
    return md.close;
  }
}

/** Rules between fields that class-validator decorators can't express cleanly. */
function assertShape(dto: CreateOrderDto) {
  if ((dto.size === undefined) === (dto.amount === undefined))
    throw new BadRequestException('Send exactly one of size or amount');
  if (dto.type === 'LIMIT' && dto.price === undefined)
    throw new BadRequestException('LIMIT orders require a price');
  if (dto.type === 'MARKET' && dto.price !== undefined)
    throw new BadRequestException(
      'MARKET orders execute at the last price; do not send price',
    );
  if (dto.price !== undefined && new D(dto.price).isZero())
    throw new BadRequestException('price must be greater than 0');
  if (
    (dto.side === 'CASH_IN' || dto.side === 'CASH_OUT') &&
    dto.type !== 'MARKET'
  )
    throw new BadRequestException('Cash transfers are MARKET orders');
}

function sizeFor(dto: CreateOrderDto, price: Decimal, isCash: boolean) {
  if (dto.size !== undefined) return dto.size;
  const amount = new D(dto.amount!);
  if (isCash && !amount.isInteger())
    // orders.size is an integer column and holds the pesos of a transfer.
    throw new BadRequestException(
      'Cash transfers must be whole pesos (orders.size is an integer)',
    );
  const size = maxShares(amount, price);
  if (size < 1)
    throw new UnprocessableEntityException(
      `amount ${ars(amount)} does not cover one share at ${ars(price)}`,
    );
  if (size > INT4_MAX)
    // orders.size is an integer column.
    throw new UnprocessableEntityException(
      `amount ${ars(amount)} buys more than ${INT4_MAX} units at ${ars(price)}`,
    );
  return size;
}

/**
 * Fingerprint of the validated request. Field order is fixed and money is normalized
 * to 2 decimals, so `930.5`, `"930.5"` and `"930.50"` are the same request.
 */
function hashRequest(dto: CreateOrderDto) {
  const money = (v?: string) => (v === undefined ? null : new D(v).toFixed(2));
  const canonical = [
    dto.userId,
    dto.instrumentId,
    dto.side,
    dto.type,
    dto.size ?? null,
    money(dto.amount),
    money(dto.price),
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
