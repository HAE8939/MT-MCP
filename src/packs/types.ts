import type { AppConfig } from '../config.js';
import type { ObjectStore } from './imagebed/cos.js';
import type { McpServer } from '@modelcontextprotocol/server';

/**
 * A capability pack. Add a folder under src/packs, export a ToolPack,
 * and register it in registry.ts. Clients keep the same MCP URL.
 * Tool names are stable and prefixed: imagebed_*, camera_annot_*, design_*, generation_*, docs_*.
 */
export interface ToolPack {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Env var that would turn the pack on once it is implemented. */
  readonly reservedEnv?: string;
  enabled(config: AppConfig): boolean;
  register(server: McpServer, ctx: HubContext): void;
}

export interface HubContext {
  config: AppConfig;
  store: ObjectStore | null;
}
