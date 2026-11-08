import { z } from 'zod';

import { log } from '../../logger.js';
import type { ToolPack } from '../types.js';
import { PublicError } from './errors.js';
import { getPrompt, listPrompts, type DesignPrompt, type DesignPromptSummary } from './library.js';

export const DESIGN_LIST_PROMPTS = 'design_list_prompts';
export const DESIGN_GET_PROMPT = 'design_get_prompt';

const listInput = z.object({});

const summaryOutput = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  category: z.string(),
  slug: z.string(),
  path: z.string(),
  model: z.string().optional(),
  image: z.string().optional(),
  version: z.string(),
});

const listOutput = z.object({
  prompts: z.array(summaryOutput),
});

const getInput = z.object({
  id: z
    .string()
    .optional()
    .describe('Frontmatter id. Example: 14a956a9-5c6e-4c3a-98d1-485bf385542b. Provide id or slug.'),
  slug: z
    .string()
    .optional()
    .describe('Path without .md. Example: rendering/01_render_reverse_master. A trailing .md is accepted. Provide id or slug.'),
});

const getOutput = summaryOutput.extend({
  prompt: z.string().describe('Usable prompt body from the "# Prompt" section, without the heading.'),
  notes: z.string().optional().describe('Text under "# Notes" when that section exists.'),
});

const LIST_DESCRIPTION = [
  '列出仓库里的设计提示词库。',
  '每条返回 id、title、description、tags、category、slug、path 和 version。',
  'version 优先用 frontmatter 里的 version；没有则是文件字节的 sha256: 加前 12 位十六进制。',
  '有 model 或 image 时一并返回。',
  '不含提示词正文。要正文时调用 design_get_prompt。',
  '服务只读 Markdown，不调用模型。',
].join('');

const GET_DESCRIPTION = [
  '按 id 或 slug 读取一条设计提示词。',
  'id 是 Markdown frontmatter 里的 id。slug 是分类加文件名、不带 .md，例如 camera/05_change_angle；带 .md 也可以。',
  '返回 title 和可直接使用的 prompt 正文。文件有 "# Notes" 时同时返回 notes。',
  '只填 id 或 slug 其中一个即可。两个都填时必须指向同一条。',
  '找不到、或库里的 Markdown 不完整时，返回明确错误。',
  '服务只读 Markdown，不调用模型。',
].join('');

export const designPromptsPack: ToolPack = {
  id: 'design-prompts',
  title: '设计提示词',
  description: 'Read the checked-in Markdown design prompt library.',
  enabled: (config) => config.designPromptsEnabled,
  register(server) {
    server.registerTool(
      DESIGN_LIST_PROMPTS,
      {
        title: '列出设计提示词',
        description: LIST_DESCRIPTION,
        inputSchema: listInput,
        outputSchema: listOutput,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () =>
        run(() => {
          const prompts = listPrompts().map(publishSummary);
          const text = prompts.length
            ? [`设计提示词 ${prompts.length} 条`, ...prompts.map(summaryLine)].join('\n')
            : '设计提示词库是空的。';
          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: { prompts },
          };
        }),
    );

    server.registerTool(
      DESIGN_GET_PROMPT,
      {
        title: '获取设计提示词',
        description: GET_DESCRIPTION,
        inputSchema: getInput,
        outputSchema: getOutput,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) =>
        run(() => {
          const prompt = publishPrompt(getPrompt({ id: args.id, slug: args.slug }));
          return {
            content: [{ type: 'text' as const, text: promptText(prompt) }],
            structuredContent: prompt,
          };
        }),
    );
  },
};

function summaryLine(prompt: DesignPromptSummary): string {
  const tags = prompt.tags.length ? ` (${prompt.tags.join(', ')})` : '';
  return `- ${prompt.title} [${prompt.slug}]${tags}\n  ${prompt.description}`;
}

function promptText(prompt: DesignPrompt): string {
  const header = [prompt.title, prompt.slug];
  if (prompt.model) header.push(`model: ${prompt.model}`);
  const parts = [header.join('\n'), prompt.prompt];
  if (prompt.notes) parts.push(`Notes:\n${prompt.notes}`);
  return parts.join('\n\n');
}

function publishSummary(prompt: DesignPromptSummary): DesignPromptSummary {
  return compact({
    id: prompt.id,
    title: prompt.title,
    description: prompt.description,
    tags: prompt.tags,
    category: prompt.category,
    slug: prompt.slug,
    path: prompt.path,
    model: prompt.model,
    image: prompt.image,
    version: prompt.version,
  });
}

function publishPrompt(prompt: DesignPrompt): DesignPrompt {
  return compact({
    ...publishSummary(prompt),
    prompt: prompt.prompt,
    notes: prompt.notes,
  });
}

function compact<T extends object>(record: T): T {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) copy[key] = value;
  }
  return copy as T;
}

async function run<T>(fn: () => { content: Array<{ type: 'text'; text: string }>; structuredContent: T }) {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof PublicError)) {
      log.error('design-prompts tool failed', { name: error instanceof Error ? error.name : 'Error' });
    }
    const text = error instanceof PublicError ? error.message : 'The design prompt request failed. Check the server logs.';
    return { isError: true as const, content: [{ type: 'text' as const, text }] };
  }
}
