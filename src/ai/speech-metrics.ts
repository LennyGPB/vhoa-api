import type { TimedWord } from './openai.service';

/**
 * Mesures objectives d'une prise de parole, calculées à partir des mots horodatés.
 * Aucun appel à GPT ici : c'est gratuit, instantané et reproductible.
 */

/** Un blanc entre deux mots compte comme silence à partir de ce seuil (secondes). */
export const SILENCE_MIN = 0.6;
/** Silences signalés individuellement à l'utilisateur. */
export const LONG_SILENCE = 1.5;

const SINGLE_FILLERS = new Set([
  'euh',
  'euhh',
  'euuh',
  'heu',
  'hum',
  'hmm',
  'mmh',
  'bah',
  'ben',
  'bref',
  'voilà',
]);
const MULTI_FILLERS: string[][] = [
  ['du', 'coup'],
  ['en', 'fait'],
  ['tu', 'vois'],
  ['tu', 'sais'],
  ['en', 'gros'],
  ['on', 'va', 'dire'],
  ['je', 'veux', 'dire'],
  ["j'veux", 'dire'],
];
/** « genre » n'est un tic que s'il n'est pas précédé d'un déterminant (« ce genre de »…). */
const GENRE_LEGIT_BEFORE = new Set([
  'ce',
  'un',
  'le',
  'quel',
  'quelle',
  'du',
  'mon',
  'ton',
  'son',
  'notre',
  'votre',
  'leur',
  'mauvais',
  'bon',
  'nouveau',
  'même',
  'autre',
  'tout',
  'tous',
  'de',
]);

export const normalize = (word: string) =>
  word
    .toLowerCase()
    .normalize('NFC')
    .replace(/[’]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

export interface SpeechMetrics {
  wordCount: number;
  /** Durée entre le premier et le dernier mot (s). */
  speakingSpan: number;
  wordsPerMinute: number;
  fillerCount: number;
  fillers: { word: string; count: number }[];
  silenceCount: number;
  silenceTotal: number;
  longestSilence: number;
  /** Part du temps passée à parler (0–1). */
  speakingRatio: number;
  longSilences: { at: number; duration: number }[];
}

const round = (n: number, digits = 1) =>
  Math.round(n * 10 ** digits) / 10 ** digits;

export function computeSpeechMetrics(
  words: TimedWord[],
  mediaDuration: number,
): SpeechMetrics {
  const tokens = words
    .map((w) => ({ ...w, n: normalize(w.w) }))
    .filter((w) => w.n);

  // Mots parasites (les expressions de plusieurs mots d'abord, pour ne pas les compter deux fois).
  const counts = new Map<string, number>();
  const used = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    for (const phrase of MULTI_FILLERS) {
      if (phrase.every((p, j) => tokens[i + j]?.n === p && !used.has(i + j))) {
        const key = phrase.join(' ');
        counts.set(key, (counts.get(key) ?? 0) + 1);
        phrase.forEach((_, j) => used.add(i + j));
      }
    }
  }
  tokens.forEach((t, i) => {
    if (used.has(i)) return;
    if (
      SINGLE_FILLERS.has(t.n) ||
      (t.n === 'genre' && !GENRE_LEGIT_BEFORE.has(tokens[i - 1]?.n ?? ''))
    ) {
      const key = t.n.startsWith('eu') || t.n === 'heu' ? 'euh' : t.n;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  });
  const fillers = [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count);

  // Silences : blancs entre deux mots consécutifs.
  let silenceTotal = 0;
  let silenceCount = 0;
  let longestSilence = 0;
  const longSilences: { at: number; duration: number }[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const gap = tokens[i].s - tokens[i - 1].e;
    if (gap >= SILENCE_MIN) {
      silenceCount++;
      silenceTotal += gap;
      longestSilence = Math.max(longestSilence, gap);
      if (gap >= LONG_SILENCE)
        longSilences.push({ at: round(tokens[i - 1].e), duration: round(gap) });
    }
  }

  const first = tokens[0]?.s ?? 0;
  const last = tokens[tokens.length - 1]?.e ?? 0;
  const span = Math.max(1, last - first);
  const total = Math.max(span, mediaDuration || span);

  return {
    wordCount: tokens.length,
    speakingSpan: round(span),
    wordsPerMinute: tokens.length ? Math.round(tokens.length / (span / 60)) : 0,
    fillerCount: fillers.reduce((sum, f) => sum + f.count, 0),
    fillers,
    silenceCount,
    silenceTotal: round(silenceTotal),
    longestSilence: round(longestSilence),
    speakingRatio: round(
      Math.min(1, Math.max(0, (span - silenceTotal) / total)),
      2,
    ),
    longSilences: longSilences
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5),
  };
}

/** Repères lisibles (débit conseillé pour un discours en français : ~130–170 mots/min). */
export function paceLabel(wpm: number) {
  if (wpm === 0) return 'inconnu';
  if (wpm < 110) return 'lent';
  if (wpm <= 170) return 'idéal';
  if (wpm <= 200) return 'rapide';
  return 'très rapide';
}
