import { requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler, type FetchLikeMcpHandler } from '@modelcontextprotocol/node';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import type { AppConfig } from '../config.js';
import { log } from '../logger.js';
import { enabledPackIds, toolPacks } from '../packs/registry.js';
import { SERVICE_NAME, VERSION } from '../version.js';
import { sharedTokenVerifier } from './auth.js';

const QUERY_CREDENTIALS = ['token', 'access_token', 'api_key', 'apikey', 'key'];

export function createHttpApp(options: { config: AppConfig; handler: FetchLikeMcpHandler }): Express {
  const { config, handler } = options;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.bodyLimitBytes }));
  app.use(rejectQueryCredentials);

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: SERVICE_NAME,
      version: VERSION,
      packs: toolPacks.map((pack) => ({
        id: pack.id,
        enabled: pack.enabled(config),
      })),
    });
  });

  app.get('/', (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      mcp: '/mcp',
      health: '/health',
      auth: 'bearer',
      packs: enabledPackIds(config),
    });
  });

  if (config.allowedHosts.length > 0) {
    app.use('/mcp', hostAllowlist(config.allowedHosts));
  }
  app.use('/mcp', originAllowlist(config.allowedOrigins));
  app.use('/mcp', acceptApiKey);
  app.use(
    '/mcp',
    requireBearerAuth({
      verifier: sharedTokenVerifier(config.mcpAuthToken),
      requiredScopes: ['mcp'],
    }),
  );

  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: config.bodyLimitBytes,
    onerror(error) {
      log.error('mcp transport failed', { name: error.name });
    },
  });
  app.all('/mcp', (req, res) => {
    const parsed = req.is('application/json') || req.is('json') ? req.body : undefined;
    void nodeHandler(req, res, parsed);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use(jsonErrorHandler);
  return app;
}

function rejectQueryCredentials(req: Request, res: Response, next: NextFunction): void {
  for (const name of QUERY_CREDENTIALS) {
    if (req.query[name] !== undefined) {
      res.status(400).json({ error: 'credentials_in_query_not_allowed' });
      return;
    }
  }
  next();
}

function acceptApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.authorization) {
    next();
    return;
  }
  const apiKey = req.headers['x-api-key'];
  if (Array.isArray(apiKey)) {
    res.status(400).json({ error: 'invalid_api_key_header' });
    return;
  }
  if (apiKey) req.headers.authorization = `Bearer ${apiKey}`;
  next();
}

function hostAllowlist(allowed: string[]): RequestHandler {
  const names = new Set(allowed.map(hostName));
  return (req, res, next) => {
    if (!names.has(hostName(req.headers.host ?? ''))) {
      res.status(403).json({ error: 'invalid_host' });
      return;
    }
    next();
  };
}

function hostName(value: string): string {
  const host = value.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  return host.replace(/:\d+$/, '');
}

function originAllowlist(allowed: string[]): RequestHandler {
  const names = new Set(allowed.map((host) => host.toLowerCase()));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined || origin === '') {
      next();
      return;
    }
    let hostname = '';
    try {
      hostname = new URL(origin).hostname.toLowerCase();
    } catch {
      res.status(403).json({ error: 'invalid_origin' });
      return;
    }
    if (!hostname || !names.has(hostname)) {
      res.status(403).json({ error: 'invalid_origin' });
      return;
    }
    next();
  };
}

const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const typed = err as { type?: string; status?: number; name?: string };
  if (typed.type === 'entity.too.large' || typed.status === 413) {
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }
  if (err instanceof SyntaxError || typed.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }
  log.error('http request failed', { name: typed.name ?? 'Error' });
  res.status(500).json({ error: 'internal_error' });
};
