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
import { IsBoolean, IsOptional } from 'class-validator';

import { CoachService } from '../coach/coach.service';
import { type AuthUser, CurrentUser } from '../common/auth.decorators';
import { FeedService } from './feed.service';
import {
  CommentDto,
  InitUploadDto,
  PostDetailsDto,
  ReportDto,
  SubmitPostDto,
  ViewsDto,
} from './posts.dto';
import { PostsService } from './posts.service';

const uuid = new ParseUUIDPipe({ version: undefined });
const optionalInt = new ParseIntPipe({ optional: true });
const HOUR = 3_600_000;

class PublishDto {
  @IsOptional()
  @IsBoolean()
  joinTheme?: boolean;
}

@Controller()
export class PostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly feed: FeedService,
    private readonly coach: CoachService,
  ) {}

  /* ---------- Feed & Explorer ---------- */

  @Get('feed')
  getFeed(
    @CurrentUser() user: AuthUser,
    @Query('tab') tab?: string,
    @Query('cursor') cursor?: string,
    @Query('limit', optionalInt) limit?: number,
  ) {
    return tab === 'following'
      ? this.feed.following(user.id, cursor, limit)
      : this.feed.forYou(user.id, cursor, limit);
  }

  @Get('explore')
  explore(@CurrentUser() user: AuthUser) {
    return this.feed.explore(user);
  }

  /* ---------- Création ---------- */

  @Post('posts')
  @Throttle({ default: { limit: 30, ttl: HOUR } })
  initUpload(@CurrentUser() user: AuthUser, @Body() dto: InitUploadDto) {
    return this.posts.initUpload(user, dto);
  }

  @Post('posts/:id/submit')
  @Throttle({ default: { limit: 30, ttl: HOUR } })
  submit(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: SubmitPostDto,
  ) {
    return this.posts.submit(user, id, dto);
  }

  @Get('posts/:id/status')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  status(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.status(user.id, id);
  }

  /* ---------- Post ---------- */

  @Get('posts/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.get(user.id, id);
  }

  @Patch('posts/:id')
  @Throttle({ default: { limit: 30, ttl: HOUR } })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: PostDetailsDto,
  ) {
    return this.posts.update(user.id, id, dto);
  }

  @Post('posts/:id/publish')
  @Throttle({ default: { limit: 30, ttl: HOUR } })
  publish(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: PublishDto,
  ) {
    return this.posts.publish(user.id, id, dto.joinTheme);
  }

  @Delete('posts/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.remove(user, id);
  }

  @Put('posts/:id/like')
  like(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.setLike(user.id, id, true);
  }

  @Delete('posts/:id/like')
  unlike(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.setLike(user.id, id, false);
  }

  @Put('posts/:id/save')
  save(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.setSave(user.id, id, true);
  }

  @Delete('posts/:id/save')
  unsave(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.setSave(user.id, id, false);
  }

  @Put('posts/:id/convinced')
  convince(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.setConvinced(user.id, id, true);
  }

  @Delete('posts/:id/convinced')
  unconvince(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.setConvinced(user.id, id, false);
  }

  @Post('posts/:id/share')
  @HttpCode(200)
  share(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.share(user.id, id);
  }

  @Post('posts/:id/not-interested')
  @HttpCode(200)
  notInterested(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.notInterested(user.id, id);
  }

  @Delete('posts/:id/not-interested')
  undoNotInterested(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ) {
    return this.posts.undoNotInterested(user.id, id);
  }

  @Post('views')
  @HttpCode(200)
  views(@CurrentUser() user: AuthUser, @Body() dto: ViewsDto) {
    return this.posts.recordViews(user.id, dto.postIds);
  }

  /* ---------- Commentaires ---------- */

  @Get('posts/:id/comments')
  comments(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query('cursor') cursor?: string,
    @Query('limit', optionalInt) limit?: number,
  ) {
    return this.posts.listComments(user.id, id, cursor, limit);
  }

  @Post('posts/:id/comments')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  addComment(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CommentDto,
  ) {
    return this.posts.addComment(user.id, id, dto);
  }

  @Delete('comments/:id')
  deleteComment(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.deleteComment(user.id, id);
  }

  @Put('comments/:id/like')
  likeComment(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.setCommentLike(user.id, id, true);
  }

  @Delete('comments/:id/like')
  unlikeComment(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.setCommentLike(user.id, id, false);
  }

  /* ---------- Signalements ---------- */

  @Post('reports')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: HOUR } })
  report(@CurrentUser() user: AuthUser, @Body() dto: ReportDto) {
    return this.posts.report(user.id, dto);
  }

  /* ---------- Coach IA ---------- */

  @Post('posts/:id/analysis')
  @Throttle({ default: { limit: 20, ttl: HOUR } })
  requestAnalysis(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ) {
    return this.coach.request(user, id);
  }

  @Get('posts/:id/analysis')
  postAnalysis(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.coach.latestForPost(user.id, id);
  }

  @Get('analyses/:id')
  analysis(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.coach.get(user.id, id);
  }

  @Get('coach/quota')
  quota(@CurrentUser() user: AuthUser) {
    return this.coach.quota(user);
  }

  @Get('coach/history')
  history(
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: string,
    @Query('limit', optionalInt) limit?: number,
  ) {
    return this.coach.history(user, cursor, limit);
  }

  @Get('coach/stats')
  stats(@CurrentUser() user: AuthUser) {
    return this.coach.stats(user);
  }
}
