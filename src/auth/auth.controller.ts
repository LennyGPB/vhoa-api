import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { type AuthUser, CurrentUser, Public } from '../common/auth.decorators';
import {
  AppleAuthDto,
  ChangePasswordDto,
  GoogleAuthDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
} from './auth.dto';
import { AuthService } from './auth.service';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

class LogoutDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  pushToken?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('username-available')
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  usernameAvailable(@Query('username') username = '') {
    return this.auth.usernameAvailable(username.slice(0, 40));
  }

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: HOUR } })
  register(@Body() dto: RegisterDto, @Headers('user-agent') ua?: string) {
    return this.auth.register(dto, ua);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  login(@Body() dto: LoginDto, @Headers('user-agent') ua?: string) {
    return this.auth.login(dto, ua);
  }

  @Public()
  @Post('apple')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 5 * MINUTE } })
  apple(@Body() dto: AppleAuthDto, @Headers('user-agent') ua?: string) {
    return this.auth.apple(dto, ua);
  }

  @Public()
  @Post('google')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 5 * MINUTE } })
  google(@Body() dto: GoogleAuthDto, @Headers('user-agent') ua?: string) {
    return this.auth.google(dto, ua);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  refresh(@Body() dto: RefreshDto, @Headers('user-agent') ua?: string) {
    return this.auth.refresh(dto.refreshToken, ua);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@CurrentUser() user: AuthUser, @Body() dto: LogoutDto) {
    return this.auth.logout(user.id, dto.refreshToken, dto.pushToken);
  }

  @Post('logout-all')
  @HttpCode(200)
  logoutAll(@CurrentUser() user: AuthUser) {
    return this.auth.logoutAll(user.id);
  }

  @Post('password')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: HOUR } })
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Headers('user-agent') ua?: string,
  ) {
    return this.auth.changePassword(user.id, dto, ua);
  }
}
