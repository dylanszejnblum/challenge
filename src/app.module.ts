import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from './db/database';
import { HealthController } from './health.controller';
import { InstrumentsModule } from './instruments/instruments.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    // forRootAsync: config is read at bootstrap, not when the module is imported.
    LoggerModule.forRootAsync({
      useFactory: () => ({
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
    }),
    DatabaseModule,
    InstrumentsModule,
    PortfolioModule,
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
