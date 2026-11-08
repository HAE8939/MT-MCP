import { z } from 'zod';

import { log } from '../../logger.js';
import type { HubContext, ToolPack } from '../types.js';
import { PublicError } from './errors.js';
import { deleteImage, listImages, uploadImage } from './service.js';

export const IMAGEBED_UPLOAD = 'imagebed_upload';
export const IMAGEBED_LIST = 'imagebed_list';
export const IMAGEBED_DELETE = 'imagebed_delete';

const uploadInput = z.object({
  filename: z.string().describe('Original file name. Path segments are stripped and are not used as the object key.'),
  content_base64: z
    .string()
    .optional()
    .describe('Image bytes as base64, or a data:image/...;base64 URL. Provide this or source_url.'),
  source_url: z
    .string()
    .optional()
    .describe('https URL of a public image to copy into the bed. Provide this or content_base64.'),
  content_type: z
    .string()
    .optional()
    .describe('Optional declared MIME type. The server still checks the file bytes.'),
});

const uploadOutput = z.object({
  url: z.string(),
  key: z.string(),
  content_type: z.string(),
  size: z.number(),
  etag: z.string().optional(),
});

const listInput = z.object({
  prefix: z
    .string()
    .optional()
    .describe('Extra prefix under the configured image bed root, for example 2026/. It cannot escape that root.'),
  max_keys: z.number().int().min(1).max(100).optional().describe('How many objects to return. Default 50, maximum 100.'),
});

const listOutput = z.object({
  prefix: z.string(),
  truncated: z.boolean(),
  objects: z.array(
    z.object({
      key: z.string(),
      url: z.string(),
      size: z.number(),
      last_modified: z.string().optional(),
    }),
  ),
});

const deleteInput = z.object({
  key: z.string().describe('Object key returned by imagebed_upload or imagebed_list. It must stay under the image bed prefix.'),
});

const deleteOutput = z.object({
  key: z.string(),
  deleted: z.boolean(),
});

export const imageBedPack: ToolPack = {
  id: 'imagebed',
  title: '临时图床',
  description: 'Upload, list, and delete images in the company Tencent COS image bed.',
  enabled: (config) => config.cos !== null,
  register(server, ctx) {
    server.registerTool(
      IMAGEBED_UPLOAD,
      {
        title: '上传临时图片',
        description:
          'Upload one image to the company temporary image bed (Tencent COS, prefix configured on the server, usually dmds/). Returns a public URL. Objects are removed by a bucket lifecycle rule of about one day; this server does not store the file. Accepts jpeg, png, gif, and webp only. Provide exactly one of content_base64 or source_url.',
        inputSchema: uploadInput,
        outputSchema: uploadOutput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args) =>
        run(() =>
          uploadImage(
            {
              filename: args.filename,
              contentBase64: args.content_base64,
              sourceUrl: args.source_url,
              contentType: args.content_type,
            },
            requireDeps(ctx),
          ).then((result) => ({
            content: [
              {
                type: 'text' as const,
                text: `已上传 ${result.url}\nkey: ${result.key}\n该地址可公网访问，对象大约 1 天后由存储桶生命周期删除。`,
              },
            ],
            structuredContent: stripEmpty(result),
          })),
        ),
    );

    server.registerTool(
      IMAGEBED_LIST,
      {
        title: '列出临时图片',
        description:
          'List objects under the image bed prefix. An optional prefix is appended to the server prefix and cannot escape it. Results may be truncated.',
        inputSchema: listInput,
        outputSchema: listOutput,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      async (args) =>
        run(async () => {
          const result = await listImages({ prefix: args.prefix, maxKeys: args.max_keys }, requireDeps(ctx));
          const lines = result.objects.map((object) => `${object.key} ${object.url}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: lines.length
                  ? `prefix ${result.prefix}\n${lines.join('\n')}${result.truncated ? '\n(结果已截断)' : ''}`
                  : `prefix ${result.prefix} 下没有对象。`,
              },
            ],
            structuredContent: result,
          };
        }),
    );

    server.registerTool(
      IMAGEBED_DELETE,
      {
        title: '删除临时图片',
        description: 'Delete one object by key. The key must stay under the configured image bed prefix.',
        inputSchema: deleteInput,
        outputSchema: deleteOutput,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async (args) =>
        run(async () => {
          const result = await deleteImage(args.key, requireDeps(ctx));
          return {
            content: [{ type: 'text' as const, text: `已删除 ${result.key}` }],
            structuredContent: result,
          };
        }),
    );
  },
};

function requireDeps(ctx: HubContext) {
  if (!ctx.config.cos || !ctx.store) {
    throw new PublicError('Image bed is not configured on the server.');
  }
  return {
    cos: ctx.config.cos,
    store: ctx.store,
    maxUploadBytes: ctx.config.maxUploadBytes,
  };
}

function stripEmpty<T extends { etag?: string }>(result: T): T {
  if (!result.etag) {
    const copy = { ...result };
    delete copy.etag;
    return copy;
  }
  return result;
}

async function run<T>(fn: () => Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: T }>) {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof PublicError)) {
      log.error('imagebed tool failed', { name: error instanceof Error ? error.name : 'Error' });
    }
    const text = error instanceof PublicError ? error.message : 'The image bed request failed. Check the server logs.';
    return { isError: true as const, content: [{ type: 'text' as const, text }] };
  }
}
