import { BadRequestException, PipeTransform } from '@nestjs/common';
import { INT4_MAX } from '../db/database';

/** Path ids are Postgres `serial`: a positive int4. Anything else is a 400, not an overflow 500. */
export class ParseIdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const id = /^\d{1,10}$/.test(value) ? Number(value) : NaN;
    if (!(id >= 1 && id <= INT4_MAX))
      throw new BadRequestException(
        `id must be an integer between 1 and ${INT4_MAX}`,
      );
    return id;
  }
}
