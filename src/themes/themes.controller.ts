import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';

import { type AuthUser, CurrentUser } from '../common/auth.decorators';
import { FeedService } from '../posts/feed.service';
import { ThemesService } from './themes.service';

@Controller('themes')
export class ThemesController {
  constructor(
    private readonly themes: ThemesService,
    private readonly feed: FeedService,
  ) {}

  @Get('current')
  current() {
    return this.themes.current();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.themes.get(id);
  }

  @Get(':id/posts')
  posts(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.feed.themePosts(user.id, id, cursor, limit);
  }
}
