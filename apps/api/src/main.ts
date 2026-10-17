import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig } from './core/config';

export async function createApp(config = loadConfig()) {
  // rawBody: Paystack signatures are computed over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { rawBody: true, logger: config.env === 'test' ? false : undefined });
  // Production lists its origins. In development any localhost port works, so preview servers can move off 3000/3001.
  const origins = process.env.CORS_ORIGINS?.split(',') ?? (config.env === 'production' ? [] : [/^http:\/\/localhost:\d+$/]);
  app.enableCors({ origin: origins, credentials: false });
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}

if (require.main === module) {
  void (async () => {
    const app = await createApp();
    const port = Number(process.env.PORT ?? 4000);
    await app.listen(port);
    console.log(`api listening on http://localhost:${port}`);
  })();
}
