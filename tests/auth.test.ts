import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';
import { assertNoSecrets, authHeader, memoryStore, postMcp, startServer, TOKEN } from './helpers.js';

describe('auth gate', () => {
  it('serves health without credentials and hides secrets', async () => {
    const running = await startServer(memoryStore());
    try {
      const health = await fetch(`${running.base}/health`);
      const body = await health.text();
      assert.equal(health.status, 200);
      assert.match(body, /"id":"imagebed"/);
      assert.match(body, /"enabled":true/);
      assert.match(body, /"id":"generation-channel"/);
      assert.match(body, /"enabled":false/);
      assertNoSecrets(body);

      const root = await fetch(`${running.base}/`);
      const rootBody = await root.text();
      assert.equal(root.status, 200);
      assert.match(rootBody, /"mcp":"\/mcp"/);
      assertNoSecrets(rootBody);
    } finally {
      await running.close();
    }
  });

  it('rejects missing, wrong, and query-string credentials', async () => {
    const running = await startServer(memoryStore());
    try {
      const missing = await postMcp(running.base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      assert.equal(missing.status, 401);
      assert.match(missing.wwwAuthenticate ?? '', /Bearer/i);
      assert.equal((missing.wwwAuthenticate ?? '').includes('resource_metadata'), false);
      assertNoSecrets(missing.text);

      const wrong = await postMcp(running.base, { jsonrpc: '2.0', id: 1, method: 'ping' }, authHeader('not-the-company-token'));
      assert.equal(wrong.status, 401);
      assert.equal(wrong.text.includes('not-the-company-token'), false);

      const query = await fetch(`${running.base}/mcp?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: '{}',
      });
      assert.equal(query.status, 400);
      assert.match(await query.text(), /credentials_in_query_not_allowed/);
    } finally {
      await running.close();
    }
  });

  it('accepts the bearer token and an equivalent X-API-Key', async () => {
    const running = await startServer(memoryStore());
    try {
      const bearer = await postMcp(running.base, initializeBody(), authHeader());
      assert.equal(bearer.status, 200);
      assert.match(JSON.stringify(bearer.message), /mt-mcp/);
      assertNoSecrets(bearer.text);

      const apiKey = await postMcp(running.base, initializeBody(), { 'x-api-key': TOKEN });
      assert.equal(apiKey.status, 200);
      assert.match(JSON.stringify(apiKey.message), /mt-mcp/);
    } finally {
      await running.close();
    }
  });

  it('rejects browser origins unless the hostname is allowed', async () => {
    const blocked = await startServer(memoryStore());
    try {
      const response = await postMcp(blocked.base, initializeBody(), {
        ...authHeader(),
        origin: 'https://evil.example',
      });
      assert.equal(response.status, 403);
      assert.match(response.text, /invalid_origin/);
    } finally {
      await blocked.close();
    }

    const allowed = await startServer(memoryStore(), { MCP_ALLOWED_ORIGINS: 'app.example' });
    try {
      const response = await postMcp(allowed.base, initializeBody(), {
        ...authHeader(),
        origin: 'https://app.example:8443',
      });
      assert.equal(response.status, 200);
    } finally {
      await allowed.close();
    }
  });

  it('rejects unexpected Host values when an allowlist is set', async () => {
    const running = await startServer(memoryStore(), { MCP_ALLOWED_HOSTS: 'nas.local' });
    try {
      const response = await postMcp(running.base, initializeBody(), authHeader());
      assert.equal(response.status, 403);
      assert.match(response.text, /invalid_host/);
    } finally {
      await running.close();
    }
  });

  it('refuses to boot without a long shared token', () => {
    assert.throws(() => loadConfig({}), /MCP_AUTH_TOKEN is required/);
    assert.throws(() => loadConfig({ MCP_AUTH_TOKEN: 'short-token' }), /at least 16/);
    assert.throws(
      () =>
        loadConfig({
          MCP_AUTH_TOKEN: TOKEN,
          COS_SECRET_ID: 'only-one',
        }),
      /together/,
    );
  });
});

function initializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'mt-mcp-test', version: '0.0.1' },
    },
  };
}
