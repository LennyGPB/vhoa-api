import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { type AuthUser, CurrentUser } from '../common/auth.decorators';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AppealDto,
  AvatarConfirmDto,
  AvatarUploadDto,
  DeleteAccountDto,
  PushTokenDto,
  SettingsDto,
  UpdateMeDto,
} from './users.dto';
import { UsersService } from './users.service';

const uuid = new ParseUUIDPipe();
const optionalInt = new ParseIntPipe({ optional: true });
const HOUR = 3_600_000;

@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
  ) {}

  /* ---------- Mon compte ---------- */

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.id);
  }

  @Patch('me')
  @Throttle({ default: { limit: 20, ttl: HOUR } })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(user.id, dto);
  }

  @Patch('me/settings')
  settings(@CurrentUser() user: AuthUser, @Body() dto: SettingsDto) {
    return this.users.updateSettings(user.id, dto);
  }

  @Post('me/avatar/upload-url')
  @Throttle({ default: { limit: 10, ttl: HOUR } })
  avatarUrl(@CurrentUser() user: AuthUser, @Body() dto: AvatarUploadDto) {
    return this.users.avatarUploadUrl(user.id, dto);
  }

  @Post('me/avatar')
  @Throttle({ default: { limit: 10, ttl: HOUR } })
  confirmAvatar(@CurrentUser() user: AuthUser, @Body() dto: AvatarConfirmDto) {
    return this.users.confirmAvatar(user.id, dto);
  }

  @Get('me/drafts')
  drafts(
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: string,
    @Query('limit', optionalInt) limit?: number,
  ) {
    return this.users.drafts(user.id, cursor, limit);
  }

  @Get('me/saved')
  saved(
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: string,
    @Query('limit', optionalInt) limit?: number,
  ) {
    return this.users.saved(user.id, cursor, limit);
  }

  @Get('me/blocked')
  blocked(@CurrentUser() user: AuthUser) {
    return this.users.blockedList(user.id);
  }

  @Post('me/push-tokens')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: HOUR } })
  pushToken(@CurrentUser() user: AuthUser, @Body() dto: PushTokenDto) {
    return this.users.addPushToken(user.id, dto);
  }

  @Post('me/appeals')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 24 * HOUR } })
  appeal(@CurrentUser() user: AuthUser, @Body() dto: AppealDto) {
    return this.users.appeal(user.id, dto);
  }

  @Delete('me')
  @Throttle({ default: { limit: 5, ttl: HOUR } })
  deleteAccount(@CurrentUser() user: AuthUser, @Body() dto: DeleteAccountDto) {
    return this.users.deleteAccount(user, dto.password);
  }

  /* ---------- Alertes ---------- */

  @Get('notifications')
  listNotifications(
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: string,
    @Query('group') group?: string,
    @Query('limit', optionalInt) limit?: number,
  ) {
    const g = ['interactions', 'themes', 'progress'].includes(group ?? '')
      ? group
      : undefined;
    return this.notifications.list(user.id, { cursor, limit, group: g });
  }

  @Get('notifications/unread-count')
  async unread(@CurrentUser() user: AuthUser) {
    return { count: await this.notifications.unreadCount(user.id) };
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  async readAll(@CurrentUser() user: AuthUser) {
    await this.notifications.markAllRead(user.id);
    return { ok: true };
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  async read(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    await this.notifications.markRead(user.id, id);
    return { ok: true };
  }

  /* ---------- Profils ---------- */

  @Get('users/:id')
  profile(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.users.profile(user.id, id);
  }

  @Get('users/:id/posts')
  posts(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query('cursor') cursor?: string,
    @Query('limit', optionalInt) limit?: number,
  ) {
    return this.users.userPosts(user.id, id, cursor, limit);
  }

  @Put('users/:id/follow')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  follow(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.users.follow(user.id, id, true);
  }

  @Delete('users/:id/follow')
  unfollow(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.users.follow(user.id, id, false);
  }

  @Put('users/:id/block')
  block(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.users.block(user.id, id, true);
  }

  @Delete('users/:id/block')
  unblock(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.users.block(user.id, id, false);
  }
}
