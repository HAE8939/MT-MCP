import { createHash } from 'node:crypto';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';

import type { CosSettings } from '../../config.js';
import { PublicError, scrubClientMessage } from './errors.js';
import { buildAuthorization, canonicalRequest, encodeObjectKey } from './signature.js';

export interface StoredObject {
  key: string;
  size: number;
  lastModified?: string;
  etag?: string;
}

export interface ObjectStore {
  putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
    acl: 'public-read' | 'default';
  }): Promise<{ etag?: string }>;
  listObjects(input: { prefix: string; maxKeys: number }): Promise<{ objects: StoredObject[]; truncated: boolean }>;
  deleteObject(input: { key: string }): Promise<void>;
}

const RESPONSE_CAP = 2 * 1024 * 1024;

export function createTencentCosStore(cos: CosSettings): ObjectStore {
  const host = `${cos.bucket}.cos.${cos.region}.myqcloud.com`;

  return {
    async putObject({ key, body, contentType, acl }) {
      const headers: Record<string, string> = {
        host,
        'content-type': contentType,
        'content-length': String(body.length),
        'content-md5': createHash('md5').update(body).digest('base64'),
      };
      if (acl === 'public-read') headers['x-cos-acl'] = 'public-read';
      const response = await signedRequest({
        cos,
        host,
        method: 'PUT',
        pathname: `/${key}`,
        path: `/${encodeObjectKey(key)}`,
        headers,
        body,
      });
      if (response.status < 200 || response.status >= 300) throw cosFailure(response.status, response.body);
      const etag = singleHeader(response.headers, 'etag')?.replaceAll('"', '');
      return { etag };
    },

    async listObjects({ prefix, maxKeys }) {
      const query = { prefix, 'max-keys': String(maxKeys) };
      const response = await signedRequest({
        cos,
        host,
        method: 'GET',
        pathname: '/',
        path: `/?${canonicalRequest({ method: 'GET', pathname: '/', query, headers: { host } }).queryString}`,
        query,
        headers: { host },
      });
      if (response.status < 200 || response.status >= 300) throw cosFailure(response.status, response.body);
      return parseBucketListing(response.body.toString('utf8'));
    },

    async deleteObject({ key }) {
      const response = await signedRequest({
        cos,
        host,
        method: 'DELETE',
        pathname: `/${key}`,
        path: `/${encodeObjectKey(key)}`,
        headers: { host },
      });
      if (response.status === 404) throw new PublicError('Object was not found under the image bed prefix.');
      if (response.status < 200 || response.status >= 300) throw cosFailure(response.status, response.body);
    },
  };
}

async function signedRequest(input: {
  cos: CosSettings;
  host: string;
  method: string;
  pathname: string;
  path: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  body?: Buffer;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  const authorization = buildAuthorization({
    secretId: input.cos.secretId,
    secretKey: input.cos.secretKey,
    method: input.method,
    pathname: input.pathname,
    query: input.query,
    headers: input.headers,
  });
  return cosHttps({
    host: input.host,
    method: input.method,
    path: input.path,
    headers: { ...input.headers, authorization },
    body: input.body,
  });
}

function cosHttps(input: {
  host: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: 'https:',
        hostname: input.host,
        method: input.method,
        path: input.path,
        headers: input.headers,
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > RESPONSE_CAP) {
            req.destroy(new Error('COS response exceeded the size cap'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('COS request timed out')));
    req.on('error', (error) => reject(new PublicError(`COS request failed: ${error.message}`)));
    if (input.body) req.end(input.body);
    else req.end();
  });
}

function cosFailure(status: number, body: Buffer): PublicError {
  const xml = body.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return new PublicError(`COS request failed (HTTP ${status}).`);
  }
  const code = tagText(xml, 'Code');
  const message = tagText(xml, 'Message');
  const detail = scrubClientMessage(message ?? 'request failed');
  return new PublicError(`COS ${code ?? `HTTP ${status}`}: ${detail}`);
}

export function parseBucketListing(xml: string): { objects: StoredObject[]; truncated: boolean } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new PublicError('COS returned an unexpected list response.');
  }
  const objects: StoredObject[] = [];
  for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
    const key = tagText(block, 'Key');
    if (!key) continue;
    const size = Number(tagText(block, 'Size') ?? '0');
    objects.push({
      key,
      size: Number.isFinite(size) ? size : 0,
      lastModified: tagText(block, 'LastModified'),
      etag: tagText(block, 'ETag')?.replaceAll('"', ''),
    });
  }
  return { objects, truncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml) };
}

function tagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  return decodeXml(raw.trim());
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
