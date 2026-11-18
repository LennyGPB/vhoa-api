import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';

import {
  ANONYMOUS_VIEWER,
  type AuthUser,
  CurrentUser,
  Public,
} from '../common/auth.decorators';
import { FeedService } from '../posts/feed.service';
import { ThemesService } from './themes.service';

@Controller('themes')
export class ThemesController {
  constructor(
    private readonly themes: ThemesService,
    private readonly feed: FeedService,
  ) {}

  @Public()
  @Get('current')
  current() {
    return this.themes.current();
  }

  /** Défis terminés, du plus récent au plus ancien, avec leur podium. */
  @Public()
  @Get('recent')
  recent(@Query('limit', new ParseIntPipe({ optional: true })) limit?: number) {
    return this.themes.recent(limit);
  }

  @Public()
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.themes.get(id);
  }

  @Public()
  @Get(':id/posts')
  posts(
    @CurrentUser() user: AuthUser | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.feed.themePosts(
      user?.id ?? ANONYMOUS_VIEWER,
      id,
      cursor,
      limit,
    );
  }
}
