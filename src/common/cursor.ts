import { BadRequestException } from '@nestjs/common';

/**
 * Pagination par curseur (keyset) : stable et rapide, contrairement à OFFSET.
 * Le curseur est opaque pour l'app (base64url d'un petit JSON).
 */
export function encodeCursor(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(
  cursor?: string,
): T | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 300) throw new BadRequestException('Curseur invalide');
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as T;
  } catch {
    throw new BadRequestException('Curseur invalide');
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const clampLimit = (
  limit: number | undefined,
  fallback = 20,
  max = 50,
) => Math.min(max, Math.max(1, Math.floor(Number(limit) || fallback)));
