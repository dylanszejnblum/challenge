import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ParseIdPipe } from '../common/parse-id.pipe';
import { ProblemDto } from '../common/problem.dto';
import type { Response } from 'express';
import { CreateOrderDto } from './create-order.dto';
import { OrderDto } from './order.dto';
import { OrdersService, toOrderResponse } from './orders.service';

@ApiTags('orders')
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
  @ApiCreatedResponse({
    type: OrderDto,
    description:
      'Stored as FILLED (MARKET), NEW (LIMIT) or REJECTED (not enough cash or shares)',
  })
  @ApiOkResponse({
    type: OrderDto,
    description: 'Idempotency-Key replay: the original order',
  })
  @ApiBadRequestResponse({ type: ProblemDto, description: 'Invalid payload' })
  @ApiNotFoundResponse({
    type: ProblemDto,
    description: 'Unknown user or instrument',
  })
  @ApiUnprocessableEntityResponse({
    type: ProblemDto,
    description:
      'MARKET order without market data, amount outside the tradable range, or Idempotency-Key reused with a different request',
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

  /** Cancel a NEW order. 409 if the order is in any other status. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OrderDto, description: 'The order, now CANCELLED' })
  @ApiNotFoundResponse({ type: ProblemDto })
  @ApiConflictResponse({ type: ProblemDto, description: 'Order is not NEW' })
  async cancel(@Param('id', ParseIdPipe) id: number) {
    return toOrderResponse(await this.orders.cancel(id));
  }
}
