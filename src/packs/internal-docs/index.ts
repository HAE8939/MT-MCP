import type { ToolPack } from '../types.js';

/**
 * Reserved pack. No tools are registered.
 * Future tool names should use the docs_ prefix, for example docs_search.
 * Read-only access to internal documents belongs here, not in the image bed.
 */
export const internalDocsPack: ToolPack = {
  id: 'internal-docs',
  title: '内部文档只读',
  description: 'Future read-only pack for internal documents. Not implemented.',
  reservedEnv: 'PACK_DOCS_ENABLED',
  enabled: () => false,
  register() {
    // Intentionally empty. See generation-channel/index.ts for the same pattern.
  },
};
