import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';

/** Every error leaves the API as RFC 9457 `application/problem+json`. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(err: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<Request>();
    const res = host.switchToHttp().getResponse<Response>();
    const status = err instanceof HttpException ? err.getStatus() : 500;
    if (status >= 500) this.logger.error(err);

    const body = err instanceof HttpException ? err.getResponse() : undefined;
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? body.message
        : err instanceof HttpException
          ? err.message
          : 'Internal server error';
    const errors = Array.isArray(message) ? (message as string[]) : undefined;

    res
      .status(status)
      .type('application/problem+json')
      .json({
        type: 'about:blank',
        title: STATUS_CODES[status] ?? 'Error',
        status,
        detail: errors ? 'Validation failed' : String(message),
        ...(errors && { errors }),
        instance: req.originalUrl,
      });
  }
}
