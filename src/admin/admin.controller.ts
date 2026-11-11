import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { Roles } from '../common/auth.decorators';
import { JwtAuthGuard } from '../common/guards';
import { NotificationsService } from '../notifications/notifications.service';
import { PostLifecycleService } from '../posts/post-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { ThemesService } from '../themes/themes.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const uuid = new ParseUUIDPipe();

class ThemeDto {
  @IsIn(['weekly', 'monthly'])
  period!: 'weekly' | 'monthly';

  /** N'importe quelle date de la semaine / du mois visé. */
  @IsDateString()
  date!: string;

  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(140)
  subject!: string;
}

class SubjectDto {
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(140)
  subject!: string;
}

class ResolveDto {
  @IsIn(['RESOLVED', 'DISMISSED'])
  status!: 'RESOLVED' | 'DISMISSED';
}

class ReasonDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  reason?: string;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: PostLifecycleService,
    private readonly notifications: NotificationsService,
  ) {}

  async removePost(postId: string, reason?: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { status: true, authorId: true },
    });
    if (!post) throw new NotFoundException('Post introuvable');
    await this.prisma.post.update({
      where: { id: postId },
      data: {
        status: 'REMOVED',
        moderationReason:
          reason ?? 'Contenu contraire aux règles de la communauté',
      },
    });
    if (post.status === 'PUBLISHED')
      await this.lifecycle.onUnpublished(postId, post.authorId);
    await this.prisma.report.updateMany({
      where: { targetType: 'POST', targetId: postId, status: 'OPEN' },
      data: { status: 'RESOLVED' },
    });
    await this.notifications.notify({
      userId: post.authorId,
      type: 'MODERATION',
      postId,
      text: 'Une de tes publications a été retirée par la modération. Tu peux contester depuis les paramètres.',
    });
    return { ok: true };
  }

  /** Accepter une contestation : le post refusé ou retiré est republié. */
  async restorePost(postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { status: true, mode: true },
    });
    if (!post || !['REMOVED', 'REJECTED'].includes(post.status))
      throw new NotFoundException('Post introuvable');
    await this.prisma.post.update({
      where: { id: postId },
      data: {
        status: 'PUBLISHED',
        moderationReason: null,
        publishedAt: new Date(),
      },
    });
    await this.lifecycle.onPublished(postId);
    return { ok: true };
  }

  async ban(userId: string, on: boolean) {
    await this.prisma.user.update({
      where: { id: userId },
      data: on
        ? { status: 'BANNED', tokenVersion: { increment: 1 } }
        : { status: 'ACTIVE' },
    });
    if (on)
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    JwtAuthGuard.invalidate(userId);
    return { ok: true };
  }
}

/** Back-office : réservé aux comptes `ADMIN` (à attribuer en base, voir README). */
@Controller('admin')
@Roles('ADMIN')
export class AdminController {
  constructor(
    private readonly themes: ThemesService,
    private readonly admin: AdminService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('themes')
  listThemes(@Query('status') status?: string) {
    return this.themes.list(status);
  }

  @Post('themes')
  upsertTheme(@Body() dto: ThemeDto) {
    return this.themes.upsertForPeriod(
      dto.period === 'weekly' ? 'WEEKLY' : 'MONTHLY',
      new Date(dto.date),
      dto.subject,
    );
  }

  @Patch('themes/:id')
  updateTheme(@Param('id', uuid) id: string, @Body() dto: SubjectDto) {
    return this.themes.updateSubject(id, dto.subject);
  }

  @Post('themes/:id/regenerate')
  @HttpCode(200)
  regenerate(@Param('id', uuid) id: string) {
    return this.themes.regenerate(id);
  }

  @Get('reports')
  reports(@Query('status') status = 'OPEN') {
    return this.prisma.report.findMany({
      where: {
        status: ['OPEN', 'RESOLVED', 'DISMISSED'].includes(status)
          ? (status as 'OPEN')
          : 'OPEN',
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { reporter: { select: { id: true, username: true } } },
    });
  }

  @Patch('reports/:id')
  resolveReport(@Param('id', uuid) id: string, @Body() dto: ResolveDto) {
    return this.prisma.report.update({
      where: { id },
      data: { status: dto.status },
    });
  }

  @Get('appeals')
  appeals() {
    return this.prisma.appeal.findMany({
      where: { status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { user: { select: { id: true, username: true } } },
    });
  }

  @Patch('appeals/:id')
  resolveAppeal(@Param('id', uuid) id: string, @Body() dto: ResolveDto) {
    return this.prisma.appeal.update({
      where: { id },
      data: { status: dto.status },
    });
  }

  @Post('posts/:id/remove')
  @HttpCode(200)
  removePost(@Param('id', uuid) id: string, @Body() dto: ReasonDto) {
    return this.admin.removePost(id, dto.reason);
  }

  @Post('posts/:id/restore')
  @HttpCode(200)
  restorePost(@Param('id', uuid) id: string) {
    return this.admin.restorePost(id);
  }

  @Post('users/:id/ban')
  @HttpCode(200)
  ban(@Param('id', uuid) id: string) {
    return this.admin.ban(id, true);
  }

  @Post('users/:id/unban')
  @HttpCode(200)
  unban(@Param('id', uuid) id: string) {
    return this.admin.ban(id, false);
  }
}
