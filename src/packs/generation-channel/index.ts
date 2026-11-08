import type { ToolPack } from '../types.js';

/**
 * Reserved pack. No tools are registered.
 * Future tool names should use the generation_ prefix, for example generation_submit.
 * Set PACK_GENERATION_ENABLED=true only after this pack is implemented;
 * until then the process logs a warning and still exposes no tools.
 */
export const generationChannelPack: ToolPack = {
  id: 'generation-channel',
  title: '生成渠道',
  description: 'Future pack for company generation channels. Not implemented.',
  reservedEnv: 'PACK_GENERATION_ENABLED',
  enabled: () => false,
  register() {
    // Intentionally empty. Implement register() here and flip enabled()
    // when the pack has real tools. Do not rename tools after publication.
  },
};
