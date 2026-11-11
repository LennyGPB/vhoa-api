import './load-env';

import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { env, loadEnv } from './config/env';

async function bootstrap() {
  loadEnv(); // échoue tout de suite si la configuration est incomplète

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger:
      env().NODE_ENV === 'production'
        ? ['log', 'warn', 'error']
        : ['log', 'warn', 'error', 'debug'],
  });

  // Derrière le proxy Railway : l'IP réelle sert à la limitation de débit.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  // Réponses JSON compressées (le feed passe d'environ 40 Ko à 6 Ko).
  // Sauf sur /auth : les jetons de session ne passent jamais par la compression (attaque BREACH).
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) =>
        !req.url.startsWith('/v1/auth') && compression.filter(req, res),
    }),
  );
  app.useBodyParser('json', { limit: '64kb' });

  app.setGlobalPrefix('v1', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  // Version web de l'app : seules les origines listées dans CORS_ORIGINS peuvent appeler l'API.
  // (L'app mobile n'est pas concernée par le CORS.)
  if (env().CORS_ORIGINS.length) {
    app.enableCors({
      origin: env().CORS_ORIGINS,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
      maxAge: 600,
    });
  }
  app.enableShutdownHooks();

  await app.listen(env().PORT, '0.0.0.0');
  new Logger('VHOA').log(`API prête sur le port ${env().PORT}`);
}

void bootstrap();
