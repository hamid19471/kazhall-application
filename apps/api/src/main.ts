import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { SWAGGER_PATH, swaggerConfig } from './configs/swagger.config';
import {
  ClassSerializerInterceptor,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RequestHandler } from 'express';
import * as cookieParser from 'cookie-parser';
import { ResponseFormatInterceptor } from './common/interceptors/response-format.interceptor';
import { ENV_DEFAULTS, parseCorsOrigins } from './configs/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.useGlobalInterceptors(
    new ResponseFormatInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector)),
  );

  // `@types/cookie-parser` is not installed, so the import is implicitly any.
  app.use((cookieParser as unknown as () => RequestHandler)());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Auth is cookie-based, so `credentials: true` is mandatory -- without it the
  // browser will not send access_token/refresh_token cross-origin. An empty
  // CORS_ORIGINS means same-origin only, which is the safe default and the one
  // the recommended Next.js BFF/proxy topology relies on.
  const origins = parseCorsOrigins(config.get<string>('CORS_ORIGINS'));
  if (origins.length > 0) {
    app.enableCors({ origin: origins, credentials: true });
    logger.log(`CORS enabled for: ${origins.join(', ')}`);
  } else {
    logger.log(
      'CORS_ORIGINS is empty - cross-origin browser requests are not allowed.',
    );
  }

  // Lets the reservation sweeper and fulfilment recovery worker run their
  // onApplicationShutdown hooks on SIGTERM.
  app.enableShutdownHooks();

  const docsMounted = swaggerConfig(app);

  const port = config.get<number>('PORT') ?? ENV_DEFAULTS.PORT;
  await app.listen(port, () => {
    logger.log(`Server is running on port ${port}`);
    if (docsMounted) {
      logger.log(
        `Swagger is running on http://localhost:${port}/${SWAGGER_PATH}`,
      );
    }
  });
}
void bootstrap();
