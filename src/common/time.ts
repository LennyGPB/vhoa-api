/**
 * Dates côté métier (semaines de série, mois de quota, thèmes) calculées en heure de Paris,
 * pour que « la semaine » corresponde à ce que vit l'utilisateur.
 */
export const TZ = 'Europe/Paris';
const DAY = 24 * 60 * 60 * 1000;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: 'numeric',
  hourCycle: 'h23',
});

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function parisParts(date = new Date()) {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS[parts.weekday],
    hour: Number(parts.hour),
  };
}

/** Décalage de Paris par rapport à UTC (en minutes) à un instant donné. */
function parisOffsetMinutes(date: Date) {
  const name =
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === '-' ? -minutes : minutes;
}

/** Instant UTC correspondant à minuit (heure de Paris) du jour donné. */
export function parisMidnight(year: number, month: number, day: number) {
  const guess = new Date(Date.UTC(year, month - 1, day));
  const offset = parisOffsetMinutes(
    new Date(guess.getTime() - 12 * 60 * 60 * 1000),
  );
  const result = new Date(guess.getTime() - offset * 60_000);
  // Ajustement si le changement d'heure tombe pile entre les deux.
  const check = parisOffsetMinutes(result);
  return check === offset ? result : new Date(guess.getTime() - check * 60_000);
}

/** Date calendaire (minuit UTC) — format attendu par les colonnes `@db.Date`. */
const calendarDate = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));

/** Lundi de la semaine en cours à Paris, en date calendaire. */
export function weekStart(date = new Date()) {
  const p = parisParts(date);
  const today = calendarDate(p.year, p.month, p.day);
  return new Date(today.getTime() - (p.weekday - 1) * DAY);
}

export const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * DAY);

/** Début (lundi 00:00 Paris) et fin (lundi suivant 00:00 Paris) de la semaine. */
export function weekRange(date = new Date()) {
  const monday = weekStart(date);
  const next = addDays(monday, 7);
  return {
    start: parisMidnight(
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate(),
    ),
    end: parisMidnight(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
    ),
  };
}

/** Début et fin du mois (heure de Paris). */
export function monthRange(date = new Date()) {
  const p = parisParts(date);
  const nextMonth =
    p.month === 12 ? { y: p.year + 1, m: 1 } : { y: p.year, m: p.month + 1 };
  return {
    start: parisMidnight(p.year, p.month, 1),
    end: parisMidnight(nextMonth.y, nextMonth.m, 1),
  };
}

/** Clé de mois « YYYY-MM » (quota du coach IA). */
export function monthKey(date = new Date()) {
  const p = parisParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}
