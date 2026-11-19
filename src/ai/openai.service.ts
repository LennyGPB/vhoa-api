import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import OpenAI from 'openai';

import { env } from '../config/env';
import { PermanentJobError } from '../jobs/jobs.service';

export interface TimedWord {
  w: string;
  s: number;
  e: number;
}

export interface Transcription {
  text: string;
  language: string;
  words: TimedWord[];
  cues: { start: number; end: number; text: string }[];
}

export interface ModerationVerdict {
  flagged: boolean;
  /** Catégories en cause (en anglais, pour les logs / l'admin). */
  categories: string[];
}

/**
 * Toutes les requêtes OpenAI passent par ici : modèles, limites de jetons et délais centralisés.
 * `store: false` : rien n'est conservé côté OpenAI au-delà du traitement.
 */
@Injectable()
export class OpenAiService {
  private readonly logger = new Logger('OpenAI');
  private readonly client = new OpenAI({
    apiKey: env().OPENAI_API_KEY,
    timeout: 60_000,
    // Une seule relance réseau : la file de tâches réessaie déjà (sinon jusqu'à 9 appels payés).
    maxRetries: 1,
  });

  /** Identifiant anonyme transmis à OpenAI pour la détection d'abus (jamais l'id brut). */
  private safetyId(userId: string) {
    return createHash('sha256')
      .update(`vhoa:${userId}`)
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * Transcription mot à mot. L'invite contient volontairement des hésitations :
   * sans elle, Whisper « nettoie » le texte et on ne pourrait plus compter les « euh ».
   */
  async transcribe(path: string): Promise<Transcription> {
    const res = await this.client.audio.transcriptions.create({
      file: createReadStream(path),
      model: env().OPENAI_TRANSCRIBE_MODEL,
      language: 'fr',
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      temperature: 0,
      prompt:
        'Euh… alors, hum, du coup, genre, en fait, euh, je voulais vous parler de… bah, voilà.',
    });
    const words = (res.words ?? []).map((w) => ({
      w: w.word.trim(),
      s: Math.round(w.start * 100) / 100,
      e: Math.round(w.end * 100) / 100,
    }));
    const cues = (res.segments ?? [])
      .map((s) => ({
        start: Math.round(s.start * 100) / 100,
        end: Math.round(s.end * 100) / 100,
        text: s.text.trim(),
      }))
      .filter((c) => c.text);
    return {
      text: res.text.trim(),
      language: res.language ?? 'fr',
      words,
      cues,
    };
  }

  /**
   * Modération (gratuite chez OpenAI). Public de 15 ans et plus : seuil plus strict que le
   * simple `flagged` sur les contenus sexuels.
   */
  async moderate(input: {
    text?: string;
    images?: string[];
  }): Promise<ModerationVerdict> {
    const calls: Promise<OpenAI.Moderations.ModerationCreateResponse>[] = [];
    const text = input.text?.trim();
    if (text) {
      calls.push(
        this.client.moderations.create({
          model: 'omni-moderation-latest',
          input: text.slice(0, 10_000),
        }),
      );
    }
    // Une image par requête : c'est ce que le modèle de modération accepte de façon fiable.
    for (const image of input.images ?? []) {
      calls.push(
        this.client.moderations.create({
          model: 'omni-moderation-latest',
          input: [{ type: 'image_url', image_url: { url: image } }],
        }),
      );
    }
    if (!calls.length) return { flagged: false, categories: [] };

    const results = (await Promise.all(calls)).flatMap((r) => r.results);
    const categories = new Set<string>();
    for (const r of results) {
      for (const [name, hit] of Object.entries(r.categories))
        if (hit) categories.add(name);
      const scores = r.category_scores as unknown as Record<string, number>;
      if ((scores['sexual'] ?? 0) > 0.35) categories.add('sexual');
      if ((scores['sexual/minors'] ?? 0) > 0.05)
        categories.add('sexual/minors');
    }
    return { flagged: categories.size > 0, categories: [...categories] };
  }

  /**
   * Réponse JSON validée par un schéma strict. Effort de raisonnement faible et plafond de
   * jetons : les retours du coach sont courts, pas besoin de payer plus.
   */
  async json<T>(opts: {
    userId: string;
    name: string;
    system: string;
    user: string;
    schema: Record<string, unknown>;
    maxOutputTokens: number;
  }): Promise<T> {
    const res = await this.client.responses.create({
      model: env().OPENAI_MODEL,
      store: false,
      reasoning: { effort: 'low' },
      max_output_tokens: opts.maxOutputTokens,
      safety_identifier: this.safetyId(opts.userId),
      input: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: opts.name,
          schema: opts.schema,
          strict: true,
        },
      },
    });
    // Réponse tronquée ou JSON invalide : réessayer donnerait le même résultat (et serait refacturé).
    if (res.status === 'incomplete') {
      this.logger.warn(
        `Réponse incomplète (${res.incomplete_details?.reason ?? '?'})`,
      );
      throw new PermanentJobError('Réponse IA incomplète');
    }
    try {
      return JSON.parse(res.output_text) as T;
    } catch {
      throw new PermanentJobError('Réponse IA illisible');
    }
  }
}
