import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { SkipThrottle, ThrottlerModule } from '@nestjs/throttler';

import { AdminController, AdminService } from './admin/admin.controller';
import { OpenAiService } from './ai/openai.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SocialVerifierService } from './auth/social-verifier.service';
import { ACCESS_TTL_SECONDS, TokensService } from './auth/tokens.service';
import {
  BillingController,
  BillingService,
} from './billing/billing.controller';
import { StripeController } from './billing/stripe.controller';
import { StripeBillingService } from './billing/stripe.service';
import { CoachService } from './coach/coach.service';
import { Public } from './common/auth.decorators';
import { JwtAuthGuard, RolesGuard, UserThrottlerGuard } from './common/guards';
import { env } from './config/env';
import { JobsModule } from './jobs/jobs.service';
import { StorageService } from './media/storage.service';
import { NotificationsService } from './notifications/notifications.service';
import { WebPushService } from './notifications/web-push.service';
import { FeedService } from './posts/feed.service';
import { MediaProcessor } from './posts/media.processor';
import { PostLifecycleService } from './posts/post-lifecycle.service';
import { PostsController } from './posts/posts.controller';
import { PostsService } from './posts/posts.service';
import { SocialService } from './posts/social.service';
import { PrismaModule } from './prisma/prisma.service';
import { ProgressService } from './progress/progress.service';
import { MediaCleanup } from './scheduler/media-cleanup';
import { SchedulerService } from './scheduler/scheduler.service';
import { ThemesController } from './themes/themes.controller';
import { ThemesService } from './themes/themes.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Controller()
class HealthController {
  /** Utilisé par Railway pour savoir si l'instance est prête. */
  @Public()
  @SkipThrottle()
  @Get('health')
  health() {
    return { ok: true };
  }
}

@Module({
  imports: [
    PrismaModule,
    JobsModule,
    ScheduleModule.forRoot(),
    JwtModule.register({
      secret: env().JWT_ACCESS_SECRET,
      signOptions: {
        algorithm: 'HS256',
        expiresIn: ACCESS_TTL_SECONDS,
        issuer: 'vhoa-api',
        audience: 'vhoa-app',
      },
      verifyOptions: {
        algorithms: ['HS256'],
        issuer: 'vhoa-api',
        audience: 'vhoa-app',
      },
    }),
    // Limite globale par défaut ; les routes sensibles ont leurs propres limites (@Throttle).
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    UsersController,
    PostsController,
    ThemesController,
    BillingController,
    StripeController,
    AdminController,
  ],
  providers: [
    // Ordre important : on identifie l'utilisateur avant de compter ses requêtes.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    OpenAiService,
    StorageService,
    NotificationsService,
    WebPushService,
    ProgressService,
    CoachService,
    SocialService,
    PostLifecycleService,
    PostsService,
    FeedService,
    MediaProcessor,
    TokensService,
    SocialVerifierService,
    AuthService,
    UsersService,
    ThemesService,
    BillingService,
    StripeBillingService,
    AdminService,
    MediaCleanup,
    SchedulerService,
  ],
})
export class AppModule {}
