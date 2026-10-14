import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Response } from 'express';
import { CreateOrderDto } from './create-order.dto';
import { OrdersService, toOrderResponse } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Send a BUY/SELL (MARKET or LIMIT) or a CASH_IN/CASH_OUT order.
   * 201 with the stored order (FILLED, NEW or REJECTED); 200 when an
   * Idempotency-Key is replayed.
   */
  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Retries with the same key return the original order',
  })
  async create(
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (idempotencyKey !== undefined && !/^[\w-]{1,64}$/.test(idempotencyKey))
      throw new BadRequestException(
        'Idempotency-Key must be 1-64 characters: letters, digits, _ or -',
      );
    const { order, replayed } = await this.orders.create(dto, idempotencyKey);
    res.status(replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return toOrderResponse(order);
  }
}
