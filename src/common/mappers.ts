import { env } from '../config/env';
import type {
  Category,
  ThemePeriod,
  ThemeStatus,
} from '../generated/prisma/enums';

/**
 * Conversion base de données → formats attendus par l'app (src/types/models.ts côté Expo).
 * L'app affiche les catégories en français : on garde ce libellé comme valeur d'échange.
 */
export const CATEGORY_LABELS: Record<Category, string> = {
  DISCOURS: 'Discours',
  PLAIDOIRIE: 'Plaidoirie',
  DEBAT: 'Débat',
  STORYTELLING: 'Storytelling',
  SLAM: 'Slam',
  PITCH: 'Pitch',
  IMPRO: 'Impro',
};
export const CATEGORY_VALUES = Object.values(CATEGORY_LABELS);
const LABEL_TO_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORY_LABELS).map(([k, v]) => [v, k]),
) as Record<string, Category>;
export const categoryFromLabel = (label: string): Category | undefined =>
  LABEL_TO_CATEGORY[label];

export const publicUrl = (key: string | null | undefined) =>
  key ? `${env().R2_PUBLIC_BASE_URL}/${key}` : '';

export interface AuthorRow {
  id: string;
  username: string;
  avatarKey: string | null;
}

export const toAuthor = (u: AuthorRow) => ({
  id: u.id,
  username: u.username,
  avatarUrl: publicUrl(u.avatarKey),
});

export interface PostRow {
  id: string;
  type: 'VIDEO' | 'AUDIO';
  status: string;
  title: string;
  category: Category | null;
  hashtags: string[];
  thumbnailKey: string | null;
  mediaKey: string | null;
  duration: number;
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  savesCount: number;
  convincedCount: number;
  transcript: unknown;
  publishedAt: Date | null;
  createdAt: Date;
  author: AuthorRow;
  theme: ThemeRow | null;
}

export interface ThemeRow {
  id: string;
  subject: string;
  period: ThemePeriod;
  status: ThemeStatus;
  startsAt: Date;
  endsAt: Date;
  participantsCount: number;
}

/** Champs Prisma à sélectionner pour construire un post. */
export const POST_SELECT = {
  id: true,
  type: true,
  status: true,
  title: true,
  category: true,
  hashtags: true,
  thumbnailKey: true,
  mediaKey: true,
  duration: true,
  likesCount: true,
  commentsCount: true,
  sharesCount: true,
  savesCount: true,
  convincedCount: true,
  transcript: true,
  publishedAt: true,
  createdAt: true,
  author: { select: { id: true, username: true, avatarKey: true } },
  theme: {
    select: {
      id: true,
      subject: true,
      period: true,
      status: true,
      startsAt: true,
      endsAt: true,
      participantsCount: true,
    },
  },
} as const;

/** Variante légère pour les vignettes : pas de transcription (inutile et lourde). */
export const POST_CARD_SELECT = {
  ...POST_SELECT,
  transcript: false,
  mediaKey: false,
} as const;

const PERIOD = { WEEKLY: 'weekly', MONTHLY: 'monthly' } as const;

/** Participation et vote sont ouverts en même temps pendant tout le thème. */
export const themePhase = (status: ThemeStatus) =>
  status === 'CLOSED' ? 'closed' : 'open';

export const toTheme = (t: ThemeRow) => ({
  id: t.id,
  period: PERIOD[t.period],
  subject: t.subject,
  endsAt: t.endsAt.toISOString(),
  participantsCount: t.participantsCount,
  phase: themePhase(t.status),
});

const STATUS: Record<string, string> = {
  PUBLISHED: 'published',
  REMOVED: 'removed',
  REJECTED: 'removed',
  DRAFT: 'draft',
  PRIVATE: 'private',
  PROCESSING: 'processing',
  UPLOADING: 'processing',
  FAILED: 'failed',
};

/** Vignette d'un post : image extraite de la vidéo, ou avatar de l'auteur pour l'audio. */
const thumbnailOf = (p: PostRow) =>
  publicUrl(p.thumbnailKey) || publicUrl(p.author.avatarKey);

export const toPost = (p: PostRow) => ({
  id: p.id,
  type: p.type === 'VIDEO' ? 'video' : 'audio',
  thumbnailUrl: thumbnailOf(p),
  duration: Math.round(p.duration),
  title: p.title,
  category: p.category ? CATEGORY_LABELS[p.category] : null,
  hashtags: p.hashtags,
  author: toAuthor(p.author),
  likes: p.likesCount,
  comments: p.commentsCount,
});

export interface ViewerState {
  isLiked: boolean;
  isSaved: boolean;
  isConvinced: boolean;
  isFollowingAuthor: boolean;
}

export const toFeedPost = (p: PostRow, viewer: ViewerState) => ({
  ...toPost(p),
  mediaUrl: publicUrl(p.mediaKey),
  transcript:
    p.type === 'AUDIO'
      ? ((p.transcript as unknown[] | null) ?? undefined)
      : undefined,
  theme: p.theme
    ? {
        id: p.theme.id,
        subject: p.theme.subject,
        period: PERIOD[p.theme.period],
        phase: themePhase(p.theme.status),
      }
    : undefined,
  status: STATUS[p.status] ?? 'removed',
  shares: p.sharesCount,
  saves: p.savesCount,
  convinced: p.convincedCount,
  publishedAt: (p.publishedAt ?? p.createdAt).toISOString(),
  viewer,
});
