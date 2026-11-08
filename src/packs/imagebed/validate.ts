import { randomBytes } from 'node:crypto';

import type { CosSettings } from '../../config.js';
import { PublicError } from './errors.js';
import { encodeObjectKey } from './signature.js';

const DETECTED = [
  { mime: 'image/png', ext: 'png' },
  { mime: 'image/jpeg', ext: 'jpg' },
  { mime: 'image/gif', ext: 'gif' },
  { mime: 'image/webp', ext: 'webp' },
] as const;

export type DetectedImage = { mime: string; ext: string };

export function detectImage(body: Buffer): DetectedImage | null {
  if (
    body.length >= 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (body.length >= 6) {
    const head = body.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  }
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

export function decodeBase64Image(input: string, maxBytes: number): Buffer {
  let raw = input.trim();
  const dataUrl = /^data:[^;,]+;base64,([\s\S]+)$/i.exec(raw);
  if (dataUrl?.[1]) raw = dataUrl[1];
  raw = raw.replace(/\s/g, '');
  if (raw.length > maxBytes * 2) throw new PublicError('content_base64 exceeds the size limit.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    throw new PublicError('content_base64 is not valid base64.');
  }
  const body = Buffer.from(raw, 'base64');
  if (body.length === 0) throw new PublicError('image is empty.');
  if (body.length > maxBytes) throw new PublicError('image exceeds the size limit.');
  return body;
}

export function assertAllowedImage(body: Buffer, declared: string | undefined, maxBytes: number): DetectedImage {
  if (body.length === 0) throw new PublicError('image is empty.');
  if (body.length > maxBytes) throw new PublicError('image exceeds the size limit.');
  const detected = detectImage(body);
  if (!detected) {
    throw new PublicError('Only jpeg, png, gif, and webp images are accepted.');
  }
  if (declared) {
    const normalized = declared.trim().toLowerCase();
    const alias = normalized === 'image/jpg' ? 'image/jpeg' : normalized;
    if (!DETECTED.some((item) => item.mime === alias)) {
      throw new PublicError('content_type must be image/jpeg, image/png, image/gif, or image/webp.');
    }
    if (alias !== detected.mime) {
      throw new PublicError('content_type does not match the image bytes.');
    }
  }
  return detected;
}

export function objectKey(prefix: string, filename: string, ext: string, now: Date, nonce: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const label = sanitizeFilename(filename);
  const key = `${prefix}${stamp}-${nonce}-${label}.${ext}`;
  assertKeyInPrefix(key, prefix);
  return key;
}

export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'image';
  const noExt = base.replace(/\.[^.]+$/, '');
  const cleaned = noExt
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  return cleaned || 'image';
}

export function resolveListPrefix(root: string, extra: string | undefined): string {
  if (!extra || extra.trim() === '') return root;
  if (extra.startsWith('/') || extra.includes('\\') || extra.includes('..') || /[\0\r\n]/.test(extra)) {
    throw new PublicError('prefix must stay under the image bed root.');
  }
  const joined = `${root}${extra.replace(/^\/+/, '')}`;
  if (!joined.startsWith(root)) throw new PublicError('prefix must stay under the image bed root.');
  return joined;
}

export function assertKeyInPrefix(key: string, prefix: string): string {
  if (
    !key.startsWith(prefix) ||
    key.includes('..') ||
    key.includes('\\') ||
    key.startsWith('/') ||
    /[\0\r\n]/.test(key) ||
    key.length > 512
  ) {
    throw new PublicError('key must stay under the image bed prefix.');
  }
  return key;
}

export function publicObjectUrl(cos: CosSettings, key: string): string {
  const path = encodeObjectKey(key);
  if (cos.cdnDomain) return `${cos.cdnDomain}/${path}`;
  return `https://${cos.bucket}.cos.${cos.region}.myqcloud.com/${path}`;
}

export function randomNonce(): string {
  return randomBytes(4).toString('hex');
}
