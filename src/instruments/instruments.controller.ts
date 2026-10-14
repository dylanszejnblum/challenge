import { Controller, Get, Header, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';
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

@Controller('instruments')
export class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  /** Search instruments by ticker and/or name. */
  @Get()
  // The catalog rarely changes: let clients/CDNs cache it. Express adds the ETag (→ 304).
  @Header('Cache-Control', 'public, max-age=300')
  search(@Query() { q }: SearchInstrumentsQuery) {
    return this.instruments.search(q);
  }
}
