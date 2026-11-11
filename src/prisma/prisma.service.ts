import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/** `sslmode=require` est traité comme `verify-full` par pg : on l'écrit explicitement. */
function connectionString(url: string) {
  const parsed = new URL(url);
  parsed.searchParams.delete('channel_binding');
  parsed.searchParams.set('sslmode', 'verify-full');
  return parsed.toString();
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: connectionString(env().DATABASE_URL),
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      }),
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
