import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { Express } from 'express';
import { ProblemFilter } from './common/problem.filter';

/** Shared by main.ts and the e2e tests, so tests exercise the real pipeline. */
export function configureApp(app: INestApplication) {
  (app.getHttpAdapter().getInstance() as Express).disable('x-powered-by');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
}
