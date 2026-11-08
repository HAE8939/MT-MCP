import { cameraAnnotPack } from './camera-annot/index.js';
import { designPromptsPack } from './design-prompts/index.js';
import { generationChannelPack } from './generation-channel/index.js';
import { imageBedPack } from './imagebed/index.js';
import { internalDocsPack } from './internal-docs/index.js';
import type { ToolPack } from './types.js';

/**
 * Every pack the hub knows about. Order is the order tools are registered.
 * Adding a pack does not change the client connection: same URL, same token.
 */
export const toolPacks: readonly ToolPack[] = [
  imageBedPack,
  cameraAnnotPack,
  designPromptsPack,
  generationChannelPack,
  internalDocsPack,
];

export function enabledPackIds(config: Parameters<ToolPack['enabled']>[0]): string[] {
  return toolPacks.filter((pack) => pack.enabled(config)).map((pack) => pack.id);
}
