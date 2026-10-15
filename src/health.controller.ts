import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Kysely, sql } from 'kysely';
import { ProblemDto } from './common/problem.dto';
import { DB, InjectDb } from './db/database';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@InjectDb() private readonly db: Kysely<DB>) {}

  /**
   * Readiness: 200 when the API can reach Postgres, 503 otherwise.
   * Used by the docker-compose healthcheck; a load balancer would use it the same way.
   */
  @Get()
  @ApiOkResponse({ schema: { example: { status: 'ok', database: 'up' } } })
  @ApiServiceUnavailableResponse({ type: ProblemDto })
  async check() {
    try {
      await sql`select 1`.execute(this.db);
    } catch (err) {
      this.logger.warn(err, 'Health check: database unreachable');
      throw new ServiceUnavailableException('Database unreachable');
    }
    return { status: 'ok', database: 'up' };
  }
}
