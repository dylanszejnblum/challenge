import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ParseIdPipe } from '../common/parse-id.pipe';
import { ProblemDto } from '../common/problem.dto';
import { PortfolioDto } from './portfolio.dto';
import { PortfolioService } from './portfolio.service';

@ApiTags('portfolio')
@Controller('users/:userId/portfolio')
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  /** Account value, available pesos and positions of a user. */
  @Get()
  @ApiOkResponse({ type: PortfolioDto })
  @ApiBadRequestResponse({ type: ProblemDto })
  @ApiNotFoundResponse({ type: ProblemDto, description: 'User not found' })
  get(@Param('userId', ParseIdPipe) userId: number) {
    return this.portfolio.getPortfolio(userId);
  }
}
