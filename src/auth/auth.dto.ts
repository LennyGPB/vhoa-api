import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const USERNAME_RE = /^(?![._])(?!.*[._]{2})[a-z0-9._]{3,30}(?<![._])$/;
/** Pseudos réservés (évite l'usurpation de l'équipe). */
export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrateur',
  'vhoa',
  'support',
  'help',
  'aide',
  'moderation',
  'moderateur',
  'staff',
  'team',
  'official',
  'officiel',
  'root',
  'api',
  'system',
  'systeme',
  'coach',
  'premium',
  'null',
  'undefined',
]);

const PASSWORD_RE = /^(?=.*\p{L})(?=.*\d).{8,128}$/u;

export class RegisterDto {
  @Transform(lower)
  @IsEmail({}, { message: 'Adresse email invalide' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(PASSWORD_RE, {
    message:
      'Le mot de passe doit faire au moins 8 caractères avec une lettre et un chiffre',
  })
  password!: string;

  @Transform(lower)
  @Matches(USERNAME_RE, {
    message:
      'Pseudo : 3 à 30 caractères, lettres, chiffres, points ou tirets bas',
  })
  username!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  displayName?: string;

  /** Réponse « Oui » à la question « As-tu 15 ans ou plus ? ». */
  @IsBoolean()
  ageConfirmed!: boolean;
}

export class LoginDto {
  @Transform(lower)
  @IsEmail({}, { message: 'Adresse email invalide' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @MaxLength(128)
  password!: string;
}

export class AppleAuthDto {
  @IsString()
  @MaxLength(4000)
  identityToken!: string;

  /** Valeur brute du nonce envoyé à Apple (le jeton en contient le SHA-256). */
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  nonce!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  fullName?: string;

  @IsOptional()
  @IsBoolean()
  ageConfirmed?: boolean;
}

export class GoogleAuthDto {
  @IsString()
  @MaxLength(4000)
  idToken!: string;

  @IsOptional()
  @IsBoolean()
  ageConfirmed?: boolean;
}

export class RefreshDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  refreshToken!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(128)
  currentPassword!: string;

  @IsString()
  @Matches(PASSWORD_RE, {
    message:
      'Le mot de passe doit faire au moins 8 caractères avec une lettre et un chiffre',
  })
  newPassword!: string;
}
