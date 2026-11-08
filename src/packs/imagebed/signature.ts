import { createHash, createHmac } from 'node:crypto';

/**
 * Tencent COS request signature (XML API).
 * https://www.tencentcloud.com/document/product/436/7778
 *
 * The pathname used for the signature is the raw object path. The request
 * line percent-encodes each segment. COS decodes the path before verifying.
 */
export function encodeCam(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

export function encodeObjectKey(key: string): string {
  return key
    .split('/')
    .map((part) => encodeCam(part))
    .join('/');
}

export interface CanonicalRequest {
  httpString: string;
  headerList: string;
  urlParamList: string;
  queryString: string;
}

export function canonicalRequest(input: {
  method: string;
  pathname: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
}): CanonicalRequest {
  const query = canonicalMap(input.query ?? {});
  const headers = canonicalMap(input.headers);
  const pathname = input.pathname.startsWith('/') ? input.pathname : `/${input.pathname}`;
  const httpString = [input.method.toLowerCase(), pathname, query.joined, headers.joined, ''].join('\n');
  return {
    httpString,
    headerList: headers.list,
    urlParamList: query.list,
    queryString: query.joined,
  };
}

export function buildAuthorization(input: {
  secretId: string;
  secretKey: string;
  method: string;
  pathname: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  keyTime?: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const keyTime = input.keyTime ?? `${now - 60};${now + (input.ttlSeconds ?? 900)}`;
  const signed = canonicalRequest(input);
  const signKey = createHmac('sha1', input.secretKey).update(keyTime).digest('hex');
  const stringToSign = `sha1\n${keyTime}\n${createHash('sha1').update(signed.httpString).digest('hex')}\n`;
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${input.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${signed.headerList}`,
    `q-url-param-list=${signed.urlParamList}`,
    `q-signature=${signature}`,
  ].join('&');
}

function canonicalMap(entries: Record<string, string>): { list: string; joined: string } {
  const pairs = Object.entries(entries).map(([key, value]) => ({
    key: encodeCam(key.toLowerCase()),
    value: encodeCam(value),
  }));
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    list: pairs.map((pair) => pair.key).join(';'),
    joined: pairs.map((pair) => `${pair.key}=${pair.value}`).join('&'),
  };
}
