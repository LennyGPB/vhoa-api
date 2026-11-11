import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import ffmpegStatic from 'ffmpeg-static';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobeStatic = require('ffprobe-static') as { path: string };

const FFMPEG = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string);
const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path;

/** Lance une commande sans shell (pas d'injection possible), avec délai maximum. */
function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 2_000_000) out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else
        reject(
          new Error(
            `${bin.split(/[\\/]/).pop()} a échoué (${code}) : ${err.split('\n').slice(-3).join(' ')}`,
          ),
        );
    });
  });
}

/**
 * Format réel du fichier, lu dans ses premiers octets (jamais d'après l'extension ou le type
 * annoncé). Un fichier non reconnu est refusé : ça empêche par exemple une playlist HLS
 * déguisée en .mp4 de faire lire à ffmpeg des fichiers du serveur.
 */
export type InputFormat = 'mov' | 'matroska' | 'mp3' | 'wav' | 'ogg' | 'aac';

export async function sniffFormat(path: string): Promise<InputFormat | null> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    await handle.read(buf, 0, 16, 0);
    if (buf.toString('latin1', 4, 8) === 'ftyp') return 'mov';
    if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'matroska';
    if (
      buf.toString('latin1', 0, 4) === 'RIFF' &&
      buf.toString('latin1', 8, 12) === 'WAVE'
    )
      return 'wav';
    if (buf.toString('latin1', 0, 4) === 'OggS') return 'ogg';
    if (buf.toString('latin1', 0, 3) === 'ID3') return 'mp3';
    if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'aac'; // ADTS
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'; // trame MPEG
    return null;
  } finally {
    await handle.close();
  }
}

/** Options d'entrée communes : format imposé et accès limité au fichier local. */
const inputArgs = (format: InputFormat, path: string) => [
  '-protocol_whitelist',
  'file',
  '-f',
  format,
  '-i',
  path,
];

export interface ProbeResult {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
}

export async function probe(
  path: string,
  format: InputFormat = 'mov',
): Promise<ProbeResult> {
  const raw = await run(
    FFPROBE,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-protocol_whitelist',
      'file',
      '-f',
      format,
      path,
    ],
    30_000,
  );
  const info = JSON.parse(raw) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      duration?: string;
      disposition?: { attached_pic?: number };
    }[];
  };
  const streams = info.streams ?? [];
  // Une pochette d'album dans un m4a n'est pas une vraie vidéo.
  const video = streams.find(
    (s) => s.codec_type === 'video' && !s.disposition?.attached_pic,
  );
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(
    info.format?.duration ?? video?.duration ?? audio?.duration ?? 0,
  );
  return {
    duration,
    hasVideo: !!video,
    hasAudio: !!audio,
    width: video?.width,
    height: video?.height,
  };
}

/** Durée max conservée : 60 s (les quelques ms de marge d'un enregistrement sont coupées). */
export const MAX_SECONDS = 60;

/**
 * Vidéo H.264 720p max (le plus petit côté ≤ 720), 30 i/s max, son AAC mono.
 * `faststart` place l'index en tête : la lecture démarre avant la fin du téléchargement.
 */
export function transcodeVideo(
  input: string,
  format: InputFormat,
  output: string,
) {
  return run(
    FFMPEG,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs(format, input),
      '-t',
      String(MAX_SECONDS),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-vf',
      "scale='if(gte(iw,ih),-2,trunc(min(720,iw)/2)*2)':'if(gte(iw,ih),trunc(min(720,ih)/2)*2,-2)'",
      '-fpsmax',
      '30',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-maxrate',
      '2500k',
      '-bufsize',
      '5000k',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ac',
      '1',
      '-ar',
      '44100',
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      output,
    ],
    180_000,
  );
}

export function transcodeAudio(
  input: string,
  format: InputFormat,
  output: string,
) {
  return run(
    FFMPEG,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs(format, input),
      '-t',
      String(MAX_SECONDS),
      '-vn',
      '-map',
      '0:a:0',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ac',
      '1',
      '-ar',
      '44100',
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      output,
    ],
    90_000,
  );
}

/** Piste allégée pour la transcription : 16 kHz mono (≈ 250 Ko par minute). */
export function extractSpeech(input: string, output: string) {
  return run(
    FFMPEG,
    // Lit notre propre fichier converti (mp4/m4a) : format connu.
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs('mov', input),
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '32k',
      output,
    ],
    60_000,
  );
}

export function extractFrame(
  input: string,
  at: number,
  output: string,
  width: number,
) {
  return run(
    FFMPEG,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      at.toFixed(2),
      ...inputArgs('mov', input),
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2`,
      '-q:v',
      '4',
      output,
    ],
    30_000,
  );
}
