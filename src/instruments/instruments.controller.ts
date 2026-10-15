import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';
import { ProblemDto } from '../common/problem.dto';
import { InstrumentDto } from './instrument.dto';
import { InstrumentsService } from './instruments.service';

export class SearchInstrumentsQuery {
  /** Ticker and/or name fragment, e.g. `PAMP` or `pampa` */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 50)
  q!: string;
}

@ApiTags('instruments')
@Controller('instruments')
export class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  /** Search instruments by ticker and/or name. */
  @Get()
  @ApiOkResponse({ type: [InstrumentDto] })
  @ApiBadRequestResponse({ type: ProblemDto })
  // The catalog rarely changes: let clients/CDNs cache it. Express adds the ETag (→ 304).
  @Header('Cache-Control', 'public, max-age=300')
  search(@Query() { q }: SearchInstrumentsQuery) {
    return this.instruments.search(q);
  }
}
