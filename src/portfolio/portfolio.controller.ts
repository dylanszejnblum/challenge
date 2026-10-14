import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';

@Controller('users/:userId/portfolio')
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  /** Account value, available pesos and positions of a user. */
  @Get()
  get(@Param('userId', ParseIntPipe) userId: number) {
    return this.portfolio.getPortfolio(userId);
  }
}
