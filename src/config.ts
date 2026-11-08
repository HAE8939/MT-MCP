import { readFileSync } from 'node:fs';

import { PublicError } from './packs/imagebed/errors.js';

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_UPLOAD_CAP = 20 * 1024 * 1024;
const MIN_TOKEN_LENGTH = 16;
const PLACEHOLDER_TOKEN = 'replace-me-with-openssl-rand-hex-32';

export interface CosSettings {
  secretId: string;
  secretKey: string;
  region: string;
  bucket: string;
  /** Always ends with `/`. Objects outside this prefix are refused. */
  prefix: string;
  /** `https://host` origin, or null to use the COS public URL. */
  cdnDomain: string | null;
  objectAcl: 'public-read' | 'default';
}

export interface AppConfig {
  host: string;
  port: number;
  mcpAuthToken: string;
  tokenIsPlaceholder: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxUploadBytes: number;
  cos: CosSettings | null;
  /** Upper bound for the HTTP JSON body, covering base64 expansion. */
  bodyLimitBytes: number;
  /** Camera-annotation HTML pack. On unless PACK_CAMERA_ANNOT_ENABLED=false. */
  cameraAnnotEnabled: boolean;
  /** Design prompt library. On unless PACK_DESIGN_PROMPTS_ENABLED=false. */
  designPromptsEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const token = readSecret(env, 'MCP_AUTH_TOKEN');
  if (!token) {
    throw new Error('MCP_AUTH_TOKEN is required. Set it in the environment or MCP_AUTH_TOKEN_FILE.');
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  if (/\s/.test(token)) {
    throw new Error('MCP_AUTH_TOKEN must be a single token without spaces.');
  }

  const port = parsePort(env.PORT);
  const host = (env.HOST || '0.0.0.0').trim();
  if (!host) throw new Error('HOST is empty.');

  const maxUploadBytes = parseMaxUpload(env.MAX_UPLOAD_BYTES);
  const cos = loadCos(env);

  return {
    host,
    port,
    mcpAuthToken: token,
    tokenIsPlaceholder: token === PLACEHOLDER_TOKEN,
    allowedHosts: parseHostList(env.MCP_ALLOWED_HOSTS),
    allowedOrigins: parseHostList(env.MCP_ALLOWED_ORIGINS),
    maxUploadBytes,
    cos,
    bodyLimitBytes: bodyLimitFor(maxUploadBytes),
    cameraAnnotEnabled: parseBoolFlag('PACK_CAMERA_ANNOT_ENABLED', env.PACK_CAMERA_ANNOT_ENABLED, true),
    designPromptsEnabled: parseBoolFlag('PACK_DESIGN_PROMPTS_ENABLED', env.PACK_DESIGN_PROMPTS_ENABLED, true),
  };
}

function parseBoolFlag(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value.trim() === 'true') return true;
  if (value.trim() === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function loadCos(env: NodeJS.ProcessEnv): CosSettings | null {
  const secretId = readSecret(env, 'COS_SECRET_ID');
  const secretKey = readSecret(env, 'COS_SECRET_KEY');
  const region = optional(env.COS_REGION);
  const bucket = optional(env.COS_BUCKET);
  const any = Boolean(secretId || secretKey || region || bucket);
  if (!any) return null;
  if (!secretId || !secretKey || !region || !bucket) {
    throw new Error('COS image bed needs COS_SECRET_ID, COS_SECRET_KEY, COS_REGION, and COS_BUCKET together.');
  }
  if (!/^[a-z0-9-]+$/.test(region)) {
    throw new Error('COS_REGION must look like ap-guangzhou.');
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?-[0-9]{3,}$/.test(bucket)) {
    throw new Error('COS_BUCKET must look like bucket-name-1250000000.');
  }
  const prefix = normalizePrefix(env.COS_PREFIX ?? 'dmds/');
  const aclRaw = (env.COS_OBJECT_ACL ?? 'public-read').trim();
  if (aclRaw !== 'public-read' && aclRaw !== 'default') {
    throw new Error('COS_OBJECT_ACL must be public-read or default.');
  }
  return {
    secretId,
    secretKey,
    region,
    bucket,
    prefix,
    cdnDomain: parseCdn(optional(env.COS_CDN_DOMAIN)),
    objectAcl: aclRaw,
  };
}

export function normalizePrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('COS_PREFIX is empty.');
  if (trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.includes('..') || /[\0\s]/.test(trimmed)) {
    throw new Error('COS_PREFIX must be a relative prefix such as dmds/.');
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(trimmed)) {
    throw new Error('COS_PREFIX contains unsupported characters.');
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function parseCdn(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('COS_CDN_DOMAIN must be an https URL.');
  }
  if (url.protocol !== 'https:') throw new Error('COS_CDN_DOMAIN must use https.');
  if (url.username || url.password) throw new Error('COS_CDN_DOMAIN must not include credentials.');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('COS_CDN_DOMAIN must not include a path.');
  if (url.search || url.hash) throw new Error('COS_CDN_DOMAIN must not include a query or hash.');
  return url.origin;
}

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  return port;
}

function parseMaxUpload(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_UPLOAD;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > MAX_UPLOAD_CAP) {
    throw new Error(`MAX_UPLOAD_BYTES must be an integer from 1024 to ${MAX_UPLOAD_CAP}.`);
  }
  return n;
}

function bodyLimitFor(maxUploadBytes: number): number {
  return Math.min(Math.max(maxUploadBytes * 2 + 64 * 1024, 1024 * 1024), 32 * 1024 * 1024);
}

function parseHostList(value: string | undefined): string[] {
  if (!value) return [];
  const hosts: string[] = [];
  for (const part of value.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    if (entry.includes('://')) {
      hosts.push(new URL(entry).hostname);
    } else {
      hosts.push(entry);
    }
  }
  return hosts;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = optional(env[name]);
  if (direct) return direct;
  const file = optional(env[`${name}_FILE`]);
  if (!file) return undefined;
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (!text) throw new PublicError('empty');
    return text;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unreadable';
    throw new Error(`Could not read ${name}_FILE (${reason}).`);
  }
}
