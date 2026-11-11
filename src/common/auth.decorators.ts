import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';

import type { Role } from '../generated/prisma/enums';

export const IS_PUBLIC = 'isPublic';
/** Route accessible sans être connecté. Toutes les autres demandent un jeton valide. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export interface AuthUser {
  id: string;
  role: Role;
  isPremium: boolean;
}

export type AuthedRequest = Request & { user?: AuthUser };

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user!,
);
