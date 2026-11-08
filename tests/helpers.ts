import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadConfig, type AppConfig } from '../src/config.js';
import { createHttpApp } from '../src/http/createApp.js';
import { createHubHandler } from '../src/mcp/createHub.js';
import type { ObjectStore } from '../src/packs/imagebed/cos.js';
import { PublicError } from '../src/packs/imagebed/errors.js';

export const TOKEN = 'test-token-value-0123456789';

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export function appConfig(extra: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({
    MCP_AUTH_TOKEN: TOKEN,
    COS_SECRET_ID: 'AKIDEXAMPLEFORTESTS',
    COS_SECRET_KEY: 'secret-example-for-tests-not-real',
    COS_REGION: 'ap-guangzhou',
    COS_BUCKET: 'dmds-images-1259154611',
    COS_PREFIX: 'dmds/',
    ...extra,
  });
}

export function memoryStore(): ObjectStore & {
  objects: Map<string, { body: Buffer; contentType: string; acl: string }>;
} {
  const objects = new Map<string, { body: Buffer; contentType: string; acl: string }>();
  return {
    objects,
    async putObject(input) {
      objects.set(input.key, { body: input.body, contentType: input.contentType, acl: input.acl });
      return { etag: 'etag-1' };
    },
    async listObjects({ prefix, maxKeys }) {
      const matched = [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({
          key,
          size: value.body.length,
          lastModified: '2026-11-08T00:00:00.000Z',
          etag: 'etag-1',
        }));
      return { objects: matched.slice(0, maxKeys), truncated: matched.length > maxKeys };
    },
    async deleteObject({ key }) {
      if (!objects.delete(key)) throw new PublicError('Object was not found under the image bed prefix.');
    },
  };
}

export async function startServer(store: ObjectStore | null, extra: Record<string, string | undefined> = {}) {
  const config = appConfig(extra);
  const handler = createHubHandler(config, store);
  const app = createHttpApp({ config, handler });
  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    config,
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, 'close');
      await handler.close();
    },
  };
}

export async function postMcp(base: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    wwwAuthenticate: response.headers.get('www-authenticate'),
    contentType: response.headers.get('content-type'),
    text,
    message: parseMcpMessage(response.headers.get('content-type'), text),
  };
}

export function parseMcpMessage(contentType: string | null, text: string): Record<string, unknown> | null {
  if (!text) return null;
  if (contentType?.includes('text/event-stream')) {
    const payloads = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0);
    const last = payloads.at(-1);
    if (!last) return null;
    return JSON.parse(last) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export function authHeader(token = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export function assertNoSecrets(text: string): void {
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes('AKIDEXAMPLEFORTESTS'), false);
  assert.equal(text.includes('secret-example-for-tests-not-real'), false);
}
