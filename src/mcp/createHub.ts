import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

import type { AppConfig } from '../config.js';
import { SERVICE_NAME, VERSION } from '../version.js';
import type { ObjectStore } from '../packs/imagebed/cos.js';
import { toolPacks } from '../packs/registry.js';
import type { HubContext } from '../packs/types.js';

const INSTRUCTIONS = [
  'Company MCP hub. One connection exposes every enabled tool pack.',
  'imagebed_upload, imagebed_list, and imagebed_delete use the temporary Tencent COS image bed.',
  'Returned URLs are public. Objects expire by a bucket lifecycle rule of about one day; do not upload secrets.',
  'camera_annot_build_html returns a standalone offline annotation page from caller-supplied floors and pages. It does not read the disk and does not build tours.',
  'design_list_prompts and design_get_prompt read the checked-in Markdown design prompt library. They do not call a model.',
  'Future packs appear as additional tools on this same server. Tool names stay stable.',
].join(' ');

export function createHubHandler(config: AppConfig, store: ObjectStore | null) {
  return createMcpHandler(() => createHubServer(config, store), {
    legacy: 'stateless',
    responseMode: 'auto',
    maxRequestBodySize: config.bodyLimitBytes,
  });
}

export function createHubServer(config: AppConfig, store: ObjectStore | null): McpServer {
  const server = new McpServer(
    { name: SERVICE_NAME, version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  const ctx: HubContext = { config, store };
  for (const pack of toolPacks) {
    if (pack.enabled(config)) pack.register(server, ctx);
  }
  return server;
}
