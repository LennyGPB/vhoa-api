import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { CATEGORY_VALUES } from '../common/mappers';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Hashtags normalisés : « #Lycée » → « #lycée », sans doublons. */
const normalizeTags = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((t): t is string => typeof t === 'string')
            .map((t) => `#${t.trim().replace(/^#+/, '').toLowerCase()}`)
            .filter((t) => t.length > 1),
        ),
      ]
    : value;

export class InitUploadDto {
  @IsIn(['video', 'audio'])
  type!: 'video' | 'audio';

  @IsString()
  @MaxLength(60)
  mimeType!: string;

  @IsInt()
  @Min(1)
  sizeBytes!: number;

  /** Durée annoncée par l'app (revérifiée côté serveur). */
  @IsNumber()
  @Min(0)
  @Max(65)
  duration!: number;
}

export class PostDetailsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  title?: string;

  @IsOptional()
  @IsIn(CATEGORY_VALUES)
  category?: string;

  @IsOptional()
  @Transform(normalizeTags)
  @IsArray()
  @ArrayMaxSize(5)
  @Matches(/^#[\p{L}\p{N}_]{1,30}$/u, {
    each: true,
    message: 'Hashtag invalide',
  })
  hashtags?: string[];
}

export class SubmitPostDto extends PostDetailsDto {
  @IsIn(['public', 'draft', 'ai'])
  mode!: 'public' | 'draft' | 'ai';

  @IsOptional()
  @IsBoolean()
  joinTheme?: boolean;

  /** Thème visé (par défaut : le thème de la semaine). */
  @IsOptional()
  @IsUUID()
  themeId?: string;
}

export class CommentDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  text!: string;
}

export class ViewsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  postIds!: string[];
}

export class ReportDto {
  @IsIn(['post', 'user', 'comment'])
  targetType!: 'post' | 'user' | 'comment';

  @IsUUID()
  targetId!: string;

  @IsIn([
    'spam',
    'harassment',
    'hate',
    'violence',
    'sexual',
    'self_harm',
    'misinformation',
    'other',
  ])
  reason!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  details?: string;
}
