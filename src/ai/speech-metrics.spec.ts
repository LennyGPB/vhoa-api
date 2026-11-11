import {
  addDays,
  monthKey,
  parisMidnight,
  weekRange,
  weekStart,
} from '../common/time';
import { computeSpeechMetrics } from './speech-metrics';

const words = (list: [string, number, number][]) =>
  list.map(([w, s, e]) => ({ w, s, e }));

describe('computeSpeechMetrics', () => {
  it('compte les mots parasites simples et composés sans doublon', () => {
    const m = computeSpeechMetrics(
      words([
        ['Euh,', 0, 0.3],
        ['du', 0.4, 0.5],
        ['coup', 0.5, 0.7],
        ['je', 0.8, 0.9],
        ['pense', 0.9, 1.2],
        ['genre', 1.3, 1.6],
        ['ce', 1.7, 1.8],
        ['genre', 1.8, 2.1],
        ['de', 2.1, 2.2],
        ['truc', 2.2, 2.5],
      ]),
      3,
    );
    expect(m.fillers).toEqual(
      expect.arrayContaining([
        { word: 'euh', count: 1 },
        { word: 'du coup', count: 1 },
        { word: 'genre', count: 1 },
      ]),
    );
    // « ce genre de » n'est pas un tic de langage.
    expect(m.fillerCount).toBe(3);
  });

  it('mesure les silences et le débit', () => {
    const m = computeSpeechMetrics(
      words([
        ['Bonjour', 0, 0.5],
        ['à', 0.5, 0.6],
        ['tous', 0.6, 1],
        ['voici', 3, 3.4],
        ['mon', 3.4, 3.6],
        ['sujet', 3.6, 4],
      ]),
      4,
    );
    expect(m.silenceCount).toBe(1);
    expect(m.longestSilence).toBe(2);
    expect(m.longSilences).toEqual([{ at: 1, duration: 2 }]);
    expect(m.wordsPerMinute).toBe(90);
  });

  it('gère une transcription vide', () => {
    const m = computeSpeechMetrics([], 10);
    expect(m.wordCount).toBe(0);
    expect(m.wordsPerMinute).toBe(0);
  });
});

describe('dates (Europe/Paris)', () => {
  it('trouve le lundi de la semaine, même tard le dimanche soir', () => {
    // Dimanche 8 nov. 2026, 23 h 30 à Paris = 22 h 30 UTC : encore la semaine du lundi 2.
    expect(weekStart(new Date('2026-11-08T22:30:00Z')).toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    );
    // Lundi 9 nov., 0 h 30 à Paris = dimanche 23 h 30 UTC : déjà la semaine suivante.
    expect(weekStart(new Date('2026-11-08T23:30:00Z')).toISOString()).toBe(
      '2026-11-09T00:00:00.000Z',
    );
  });

  it('calcule minuit heure de Paris en hiver et en été', () => {
    expect(parisMidnight(2026, 1, 15).toISOString()).toBe(
      '2026-01-14T23:00:00.000Z',
    );
    expect(parisMidnight(2026, 7, 15).toISOString()).toBe(
      '2026-07-14T22:00:00.000Z',
    );
  });

  it('borne la semaine du lundi au lundi suivant', () => {
    const r = weekRange(new Date('2026-11-12T12:00:00Z'));
    expect(r.start.toISOString()).toBe('2026-11-08T23:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-11-15T23:00:00.000Z');
    expect(addDays(r.start, 7).getTime()).toBe(r.end.getTime());
  });

  it('donne le mois de quota en heure de Paris', () => {
    // 31 déc. 23 h 30 UTC = 1er janvier à Paris.
    expect(monthKey(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01');
  });
});
