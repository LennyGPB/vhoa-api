import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { Prisma } from '../generated/prisma/client';

const isClientHttpError = (e: unknown): e is { status: number } => {
  const status = (e as { status?: unknown; expose?: unknown })?.status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    (e as { expose?: unknown }).expose === true
  );
};

/**
 * Réponses d'erreur uniformes `{ statusCode, code, message }`.
 * Les erreurs inattendues sont journalisées côté serveur mais jamais détaillées au client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message: string | string[] = 'Une erreur est survenue';

    if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      code = 'RATE_LIMITED';
      message = 'Trop de requêtes, réessaie dans un instant';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as { message?: string | string[]; code?: string };
        message = b.message ?? message;
        if (b.code) code = b.code;
      }
      if (code === 'INTERNAL_ERROR') code = HttpStatus[status] ?? 'ERROR';
    } else if (isClientHttpError(exception)) {
      // Erreurs du lecteur de corps de requête (JSON invalide, trop volumineux…).
      status = exception.status;
      code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
      message =
        status === 413 ? 'Requête trop volumineuse' : 'Requête invalide';
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      // Paramètre mal formé (ex. curseur trafiqué) : erreur du client, pas du serveur.
      status = HttpStatus.BAD_REQUEST;
      code = 'BAD_REQUEST';
      message = 'Requête invalide';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'CONFLICT';
        message = 'Cette ressource existe déjà';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'NOT_FOUND';
        message = 'Introuvable';
      } else {
        this.logger.error(
          `${req.method} ${req.path} → Prisma ${exception.code}`,
          exception.stack,
        );
      }
    } else {
      this.logger.error(
        `${req.method} ${req.path}`,
        (exception as Error)?.stack ?? String(exception),
      );
    }

    if (status >= 500 && exception instanceof HttpException) {
      this.logger.error(
        `${req.method} ${req.path} → ${status}`,
        exception.stack,
      );
    }

    res.status(status).json({ statusCode: status, code, message });
  }
}
