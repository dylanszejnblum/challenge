import { ApiProperty } from '@nestjs/swagger';
import {
  ORDER_SIDES,
  ORDER_STATUSES,
  ORDER_TYPES,
  type OrderSide,
  type OrderStatus,
  type OrderType,
} from '../db/database';

export class OrderDto {
  /** @example 12 */
  id!: number;
  /** @example 1 */
  userId!: number;
  /** @example 47 */
  instrumentId!: number;
  @ApiProperty({ enum: ORDER_SIDES })
  side!: OrderSide;
  @ApiProperty({ enum: ORDER_TYPES })
  type!: OrderType;
  /** Shares, or pesos for CASH_IN/CASH_OUT. @example 10 */
  size!: number;
  /** Execution price (MARKET) or limit price (LIMIT). @example 925.85 */
  price!: string;
  @ApiProperty({ enum: ORDER_STATUSES })
  status!: OrderStatus;
  /** UTC. */
  datetime!: Date;
}
