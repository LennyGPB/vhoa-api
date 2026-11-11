import type { MediaType } from '../generated/prisma/enums';

/** Taille max d'un fichier brut envoyé par l'app (avant conversion 720p côté serveur). */
export const MAX_UPLOAD_BYTES: Record<MediaType, number> = {
  VIDEO: 200 * 1024 * 1024,
  AUDIO: 30 * 1024 * 1024,
};

export const ALLOWED_MIME: Record<MediaType, Record<string, string>> = {
  VIDEO: {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/3gpp': '3gp',
  },
  AUDIO: {
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/3gpp': '3gp',
  },
};

/** Envois commencés mais pas terminés en même temps, par personne. */
export const MAX_PENDING_UPLOADS = 3;

/** Envois par 24 h et par personne (protège le budget transcription / modération). */
export const MAX_DAILY_UPLOADS = 40;
