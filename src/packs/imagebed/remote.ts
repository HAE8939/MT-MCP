import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

import { PublicError } from './errors.js';

const blocked = new BlockList();
for (const [cidr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(cidr, prefix, 'ipv4');
}
blocked.addSubnet('::', 128, 'ipv6');
blocked.addSubnet('::1', 128, 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');

export function isPublicIp(ip: string): boolean {
  let normalized = ip.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) normalized = mapped;
  }
  const family = isIP(normalized);
  if (family === 0) return false;
  return !blocked.check(normalized, family === 6 ? 'ipv6' : 'ipv4');
}

export interface RemoteResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface RemoteFetchDeps {
  lookup?: (hostname: string) => Promise<string[]>;
  request?: (target: { hostname: string; ip: string; path: string }, maxBytes: number) => Promise<RemoteResponse>;
}

const MAX_REDIRECTS = 2;

export async function fetchPublicImage(rawUrl: string, maxBytes: number, deps: RemoteFetchDeps = {}): Promise<Buffer> {
  const lookupHost = deps.lookup ?? defaultLookup;
  const request = deps.request ?? defaultRequest;
  let current = parsePublicHttpsUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const addresses = await resolvePublicHost(current.hostname, lookupHost);
    const ip = addresses[0];
    if (!ip) throw new PublicError('source_url host did not resolve.');
    const path = `${current.pathname}${current.search}`;
    const response = await request({ hostname: current.hostname, ip, path }, maxBytes);
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, 'location');
      if (!location) throw new PublicError('source_url redirect had no Location header.');
      current = parsePublicHttpsUrl(new URL(location, current).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PublicError(`source_url returned HTTP ${response.status}.`);
    }
    if (response.body.length === 0) throw new PublicError('source_url returned an empty body.');
    if (response.body.length > maxBytes) throw new PublicError('source_url image exceeds the size limit.');
    return response.body;
  }
  throw new PublicError('source_url redirected too many times.');
}

export function parsePublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicError('source_url is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new PublicError('source_url must use https.');
  if (url.username || url.password) throw new PublicError('source_url must not include credentials.');
  if (hostnameBlocked(url.hostname)) throw new PublicError('source_url host is not allowed.');
  return url;
}

async function resolvePublicHost(hostname: string, lookupHost: (hostname: string) => Promise<string[]>): Promise<string[]> {
  if (isIP(hostname) !== 0) {
    if (!isPublicIp(hostname)) throw new PublicError('source_url host is not allowed.');
    return [hostname];
  }
  let addresses: string[];
  try {
    addresses = await lookupHost(hostname);
  } catch {
    throw new PublicError('source_url host could not be resolved.');
  }
  if (addresses.length === 0) throw new PublicError('source_url host could not be resolved.');
  if (addresses.some((ip) => !isPublicIp(ip))) {
    throw new PublicError('source_url host is not allowed.');
  }
  return addresses;
}

function hostnameBlocked(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (host === 'metadata.google.internal' || host === 'metadata.tencentyun.com') return true;
  if (isIP(host) !== 0) return !isPublicIp(host);
  return false;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function defaultRequest(
  target: { hostname: string; ip: string; path: string },
  maxBytes: number,
): Promise<RemoteResponse> {
  return new Promise((resolve, reject) => {
    const family = isIP(target.ip) === 6 ? 6 : 4;
    const req = https.request(
      {
        protocol: 'https:',
        host: target.ip,
        servername: target.hostname,
        family,
        method: 'GET',
        path: target.path || '/',
        headers: {
          host: target.hostname,
          accept: 'image/jpeg,image/png,image/gif,image/webp',
          'user-agent': 'mt-mcp-imagebed',
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error('too-large'));
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      if (error.message === 'too-large') {
        reject(new PublicError('source_url image exceeds the size limit.'));
        return;
      }
      reject(new PublicError('source_url could not be fetched.'));
    });
    req.end();
  });
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}
