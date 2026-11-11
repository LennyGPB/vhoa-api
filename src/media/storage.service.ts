import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { env } from '../config/env';

/** Accès à Cloudflare R2 (API compatible S3). */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket = env().R2_BUCKET_NAME;

  constructor() {
    const e = env();
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: e.R2_ACCESS_KEY_ID,
        secretAccessKey: e.R2_SECRET_ACCESS_KEY,
      },
      // R2 ne gère pas les sommes de contrôle CRC ajoutées par défaut aux URLs signées.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /**
   * URL d'envoi direct app → R2, valable 10 min.
   * Le type et la taille exacte sont signés : impossible d'envoyer un autre fichier avec cette URL.
   */
  presignUpload(key: string, contentType: string, contentLength: number) {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      {
        expiresIn: 600,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
  }

  async head(key: string) {
    try {
      const res = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? '',
      };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw e;
    }
  }

  async download(key: string, path: string, maxBytes: number) {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if ((res.ContentLength ?? 0) > maxBytes)
      throw new Error('Fichier trop volumineux');
    await pipeline(res.Body as Readable, createWriteStream(path));
  }

  async upload(key: string, path: string, contentType: string) {
    const { size } = await stat(path);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: contentType,
        // Les fichiers finaux ne changent jamais (nom unique) : cache CDN long.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async deleteKeys(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      if (!chunk.length) continue;
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async deletePrefix(prefix: string) {
    if (!prefix || prefix.length < 8)
      throw new Error('Préfixe de suppression trop court');
    let token: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      await this.deleteKeys(
        (res.Contents ?? []).map((o) => o.Key!).filter(Boolean),
      );
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }
}
