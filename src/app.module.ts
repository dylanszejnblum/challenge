import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from './db/database';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // Reuse the caller's request id (gateway, client) or mint one; echoed back for tracing.
        genReqId: (req, res) => {
          const id = req.headers['x-request-id'] ?? randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
      },
    }),
    DatabaseModule,
  ],
})
export class AppModule {}
