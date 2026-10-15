import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  Matches,
  Max,
} from 'class-validator';
import {
  INT4_MAX,
  ORDER_SIDES,
  ORDER_TYPES,
  type OrderSide,
  type OrderType,
} from '../db/database';

// Money travels as decimal strings. JSON numbers are accepted for convenience,
// converted to string before validation, and never used for arithmetic.
const toDecimalString = ({ value }: { value: unknown }) =>
  typeof value === 'number' ? String(value) : value;

/** Mirrors orders.price numeric(10,2): rejected instead of silently rounded by Postgres. */
const PRICE = /^\d{1,8}(\.\d{1,2})?$/;
const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;

export class CreateOrderDto {
  @IsInt()
  @IsPositive()
  @Max(INT4_MAX)
  userId!: number;

  @IsInt()
  @IsPositive()
  @Max(INT4_MAX)
  instrumentId!: number;

  @ApiProperty({ enum: ORDER_SIDES })
  @IsIn(ORDER_SIDES)
  side!: OrderSide;

  @ApiProperty({ enum: ORDER_TYPES })
  @IsIn(ORDER_TYPES)
  type!: OrderType;

  /** Number of shares (or pesos for CASH_IN/CASH_OUT). Send `size` or `amount`, not both. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(INT4_MAX)
  size?: number;

  /** Pesos to invest; converted to the max whole number of shares. Send `size` or `amount`, not both. */
  @ApiPropertyOptional({ type: String, example: '10000.50' })
  @IsOptional()
  @Transform(toDecimalString)
  @Matches(AMOUNT, {
    message: 'amount must be a positive decimal with up to 2 decimals',
  })
  amount?: string;

  /** Limit price in pesos. Required for LIMIT, not allowed for MARKET. */
  @ApiPropertyOptional({ type: String, example: '930.50' })
  @IsOptional()
  @Transform(toDecimalString)
  @Matches(PRICE, {
    message:
      'price must be a positive decimal with up to 2 decimals and below 100000000',
  })
  price?: string;
}
