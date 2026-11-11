import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { USERNAME_RE } from '../auth/auth.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class UpdateMeDto {
  @IsOptional()
  @Transform(lower)
  @Matches(USERNAME_RE, {
    message:
      'Pseudo : 3 à 30 caractères, lettres, chiffres, points ou tirets bas',
  })
  username?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  displayName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  bio?: string;
}

export class SettingsDto {
  @IsOptional()
  @IsBoolean()
  interactions?: boolean;

  @IsOptional()
  @IsBoolean()
  themes?: boolean;

  @IsOptional()
  @IsBoolean()
  progress?: boolean;
}

export class AvatarUploadDto {
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  mimeType!: string;

  @IsInt()
  @Min(1)
  @Max(2 * 1024 * 1024)
  sizeBytes!: number;
}

export class AvatarConfirmDto {
  @IsString()
  @MaxLength(200)
  @Matches(/^a\/[0-9a-f-]{36}\/[0-9a-f]{32}\.(jpg|png|webp)$/)
  key!: string;
}

export class PushTokenDto {
  @IsString()
  @MaxLength(200)
  @Matches(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/, {
    message: 'Jeton push invalide',
  })
  token!: string;

  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';
}

export class DeleteAccountDto {
  /** Obligatoire pour les comptes email/mot de passe. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;
}

export class AppealDto {
  @IsOptional()
  @IsUUID()
  postId?: string;

  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  message!: string;
}
