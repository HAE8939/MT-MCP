import { z } from 'zod';

import { log } from '../../logger.js';
import type { ToolPack } from '../types.js';
import { PublicError } from './errors.js';
import { buildAnnotationHtml, validateAnnotation, type AnnotationInput, type BuildResult } from './service.js';

export const CAMERA_ANNOT_BUILD = 'camera_annot_build_html';
export const CAMERA_ANNOT_VALIDATE = 'camera_annot_validate_bootstrap';

const floorInput = z.object({
  id: z.string().describe('Stable floor id, for example B1, BM, or F1.'),
  title: z.string().describe('Floor tab label, for example 一层.'),
  name: z.string().optional().describe('Name written into the export. Defaults to title.'),
  short: z.string().optional().describe('Short tab mark, for example 1F. Known ids already have a default.'),
  plan: z.string().describe('Floor-plan path relative to base. Example: 平面图/一层.png. No absolute path and no "..".'),
  w: z.number().describe('Plan width in pixels. Required so exported nx/ny stay aligned.'),
  h: z.number().describe('Plan height in pixels.'),
});

const pageInput = z.object({
  no: z
    .number()
    .optional()
    .describe('1-based page number. Omit it on every page to number the list from 1, or set it on every page.'),
  sec: z.string().optional().describe('Group name, often the folder. Defaults to the first path segment of file.'),
  floor: z.string().describe('Floor id this image belongs to.'),
  room: z.string().optional().describe('Room name shown in the list.'),
  view: z.string().optional().describe('What the frame shows.'),
  conf: z
    .enum(['high', 'mid', 'low', 'dup', 'none'])
    .optional()
    .describe('How sure the room assignment is. low shows a 存疑 flag. Default none.'),
  note: z.string().optional(),
  file: z.string().describe('Image path relative to base. Example: jpg/1 (1).jpg.'),
});

const bootstrapInput = z.object({
  project: z.string().describe('Project name. Used in the page title and the suggested file name 「<project>-机位标注.html」.'),
  source_pdf: z.string().optional().describe('Optional source drawing name, stored as sourcePdf and shown in the help footer.'),
  base: z
    .string()
    .optional()
    .describe('Path from the HTML file to the asset root. Default "../", which matches HTML saved in 01_机位标注/.'),
  mode: z
    .enum(['pano', 'effect'])
    .describe(
      'pano: panorama points only, exported dir and fov are null. effect: drag to set bearing and FOV for effect images.',
    ),
  title: z.string().optional().describe('Browser title. Default is 「<project> · 实景全景点位」 or 「<project> · 效果图机位标注」.'),
  subtitle: z.string().optional().describe('Small line under the project name.'),
  logo: z.string().optional().describe('One or two characters in the corner mark. Default is the first character of project.'),
  store_key: z
    .string()
    .optional()
    .describe('localStorage prefix. The page appends .cameras.v1. Default is derived from the project name. Pass gdmjt to keep an older draft.'),
  schema: z
    .string()
    .optional()
    .describe('Export schema id. Default camera-annot.pano-annotations/1 or camera-annot.camera-annotations/1. Pass gdmjt.pano-annotations/1 to keep an old id.'),
  floors: z.array(floorInput).describe('Floor plans. The first floor is the initial tab. Must not be empty.'),
  pages: z.array(pageInput).describe('Images to annotate, in survey order. Must not be empty.'),
  sections: z
    .record(z.string(), z.string())
    .optional()
    .describe('Optional fallback from a group name to a floor id, used only when a page has no floor. Omit to derive unambiguous groups.'),
  dup_of: z
    .record(z.string(), z.number())
    .optional()
    .describe('Optional map of duplicate page number to the page it repeats. Placing one links the other.'),
});

const buildInput = bootstrapInput.extend({
  include_scaffold: z
    .boolean()
    .optional()
    .describe('When true (default), also return an empty Export → JSON document with no cameras yet.'),
});

const scaffoldCamera = z.object({
  id: z.string(),
  pages: z.array(z.number()),
  primary: z.number(),
  x: z.number(),
  y: z.number(),
  nx: z.number(),
  ny: z.number(),
  dir: z.number().nullable(),
  fov: z.number().nullable(),
  name: z.string(),
  note: z.string(),
  locked: z.boolean(),
});

const scaffoldFloor = z.object({
  id: z.string(),
  title: z.string(),
  name: z.string(),
  plan: z.string(),
  w: z.number(),
  h: z.number(),
  cameras: z
    .array(scaffoldCamera)
    .describe('Empty in this scaffold. Export → JSON in the HTML page fills one object per placed camera. pano leaves dir and fov null.'),
});

const scaffoldPage = z.object({
  no: z.number(),
  floor: z.string(),
  room: z.string(),
  view: z.string(),
  conf: z.string(),
  note: z.string(),
  file: z.string(),
  camera: z.null(),
});

const scaffoldOutput = z.object({
  schema: z.string(),
  project: z.string(),
  sourcePdf: z.string(),
  exportedAt: z.null(),
  note: z.string(),
  floors: z.array(scaffoldFloor),
  pages: z.array(scaffoldPage),
});

const buildOutput = z.object({
  filename: z.string(),
  mode: z.enum(['pano', 'effect']),
  project: z.string(),
  schema: z.string(),
  floor_count: z.number(),
  page_count: z.number(),
  warnings: z.array(z.string()),
  html: z.string(),
  scaffold: scaffoldOutput.nullable(),
});

const validateOutput = z.object({
  ok: z.literal(true),
  filename: z.string(),
  mode: z.enum(['pano', 'effect']),
  project: z.string(),
  schema: z.string(),
  floor_count: z.number(),
  page_count: z.number(),
  warnings: z.array(z.string()),
});

const BUILD_DESCRIPTION = [
  '根据调用方传入的项目、楼层平面和图片清单，生成一份可离线双击打开的单文件机位标注 HTML。',
  '服务端不读取 NAS 或任何本地路径；平面图和图片只作为相对路径写进页面。',
  '请把返回的 html 原样保存为 filename，通常放在「01_机位标注/」，base 用 "../" 指向素材根目录。',
  '人用浏览器打开该文件，在平面图上点选机位，再用页面里的「导出 → JSON」。',
  'mode=pano：实景全景，只落点，导出的 dir 和 fov 为 null。',
  'mode=effect：效果图，按下并拖出朝向，可调视场角。',
  '不要用这个工具做全景转换、导览或 tour 导出。',
  'floors 与 pages 都不能为空；每张图的 floor 必须是某个楼层 id；plan 和 file 必须是相对 base 的路径。',
].join('');

export const cameraAnnotPack: ToolPack = {
  id: 'camera-annot',
  title: '机位标注',
  description: 'Build a standalone offline HTML page for placing camera points on floor plans.',
  enabled: (config) => config.cameraAnnotEnabled,
  register(server) {
    server.registerTool(
      CAMERA_ANNOT_VALIDATE,
      {
        title: '检查机位标注数据',
        description:
          '用与 camera_annot_build_html 相同的参数检查清单能否生成标注页。返回楼层数、图片数、建议文件名、schema 和警告。不返回 HTML，也不读取本地磁盘。',
        inputSchema: bootstrapInput,
        outputSchema: validateOutput,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) =>
        run(() => {
          const result = validateAnnotation(toInput(args));
          const text = [
            `可以生成 ${result.filename}`,
            `模式：${modeLabel(result.mode)}`,
            `楼层 ${result.floor_count}，图片 ${result.page_count}`,
            `schema：${result.schema}`,
            result.warnings.length ? `注意：${result.warnings.join(' ')}` : '没有警告。',
          ].join('\n');
          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: { ok: true as const, ...result },
          };
        }),
    );

    server.registerTool(
      CAMERA_ANNOT_BUILD,
      {
        title: '生成机位标注页',
        description: BUILD_DESCRIPTION,
        inputSchema: buildInput,
        outputSchema: buildOutput,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) =>
        run(() => {
          const result = buildAnnotationHtml(toInput(args, args.include_scaffold));
          return {
            content: [{ type: 'text' as const, text: resultText(result) }],
            structuredContent: result,
          };
        }),
    );
  },
};

function toInput(
  args: z.infer<typeof bootstrapInput>,
  includeScaffold?: boolean,
): AnnotationInput {
  return {
    project: args.project,
    sourcePdf: args.source_pdf,
    base: args.base,
    mode: args.mode,
    title: args.title,
    subtitle: args.subtitle,
    logo: args.logo,
    storeKey: args.store_key,
    schema: args.schema,
    floors: args.floors,
    pages: args.pages,
    sections: args.sections,
    dupOf: args.dup_of,
    includeScaffold,
  };
}

function modeLabel(mode: BuildResult['mode']): string {
  return mode === 'pano' ? 'pano 实景全景（只标点，dir/fov 为 null）' : 'effect 效果图（含朝向与视场角）';
}

function resultText(result: BuildResult): string {
  const lines = [
    `已生成 ${result.filename}`,
    `模式：${modeLabel(result.mode)}`,
    `项目：${result.project}`,
    `楼层 ${result.floor_count}，图片 ${result.page_count}`,
    `schema：${result.schema}`,
    '请把下方 HTML 原样保存为该文件名，放在素材旁边的 01_机位标注/ 目录（base 默认 ../）。不要改动 bootstrap。',
    '人工用浏览器打开，在平面图上点选，然后使用页面中的「导出 → JSON」。',
  ];
  if (result.warnings.length) lines.push(`注意：${result.warnings.join(' ')}`);
  if (result.scaffold) lines.push('scaffold 是尚未标注的空 JSON，供对照字段；人工导出的 JSON 才是下游输入。');
  lines.push('-----HTML-----');
  lines.push(result.html);
  return lines.join('\n');
}

async function run<T>(fn: () => { content: Array<{ type: 'text'; text: string }>; structuredContent: T }) {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof PublicError)) {
      log.error('camera-annot tool failed', { name: error instanceof Error ? error.name : 'Error' });
    }
    const text = error instanceof PublicError ? error.message : 'The camera annotation request failed. Check the server logs.';
    return { isError: true as const, content: [{ type: 'text' as const, text }] };
  }
}
