import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Equals, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import type { Request } from 'express';

import { type AuthUser, CurrentUser, Public } from '../common/auth.decorators';
import { type Plan, StripeBillingService } from './stripe.service';

export class CheckoutDto {
  @IsIn(['monthly', 'yearly'])
  plan!: Plan;

  /** Demande d'accès immédiat et renonciation au droit de rétractation (obligatoire). */
  @Equals(true, {
    message: 'Confirme l’accès immédiat pour continuer',
  })
  acceptWaiver!: boolean;
}

export class ConfirmDto {
  @IsOptional()
  @IsString()
  @Matches(/^cs_[A-Za-z0-9_]{10,250}$/)
  sessionId?: string;
}

@Controller()
export class StripeController {
  constructor(private readonly stripe: StripeBillingService) {}

  /** Tarifs de la page Premium (public). */
  @Public()
  @Get('billing/offer')
  offer() {
    return this.stripe.offer();
  }

  @Get('me/subscription')
  status(@CurrentUser() user: AuthUser) {
    return this.stripe.status(user);
  }

  @Post('me/subscription/checkout')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  checkout(@CurrentUser() user: AuthUser, @Body() dto: CheckoutDto) {
    return this.stripe.checkout(user, dto.plan);
  }

  @Post('me/subscription/confirm')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  confirm(@CurrentUser() user: AuthUser, @Body() dto: ConfirmDto) {
    return this.stripe.confirm(user, dto.sessionId);
  }

  @Post('me/subscription/cancel')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  cancel(@CurrentUser() user: AuthUser) {
    return this.stripe.setCancel(user, true);
  }

  @Post('me/subscription/resume')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resume(@CurrentUser() user: AuthUser) {
    return this.stripe.setCancel(user, false);
  }

  @Post('me/subscription/portal')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  portal(@CurrentUser() user: AuthUser) {
    return this.stripe.portal(user);
  }

  /** Webhook Stripe : authentifié par la signature de l'en-tête `stripe-signature`. */
  @Public()
  @SkipThrottle()
  @Post('webhooks/stripe')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    await this.stripe.webhook(req.rawBody, signature);
    return { received: true };
  }
}
