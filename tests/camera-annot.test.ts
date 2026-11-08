import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';
import {
  CAMERA_ANNOT_BUILD,
  CAMERA_ANNOT_VALIDATE,
} from '../src/packs/camera-annot/index.js';
import { PublicError } from '../src/packs/camera-annot/errors.js';
import {
  EFFECT_NOTE,
  EFFECT_SCHEMA,
  PANO_NOTE,
  PANO_SCHEMA,
  buildAnnotationHtml,
  validateAnnotation,
  type AnnotationInput,
} from '../src/packs/camera-annot/service.js';
import { appConfig, authHeader, memoryStore, postMcp, startServer } from './helpers.js';

const sample = (): AnnotationInput => ({
  project: '示例别墅',
  sourcePdf: '方案平面.pdf',
  base: '../',
  mode: 'pano',
  floors: [
    { id: 'F1', title: '一层', plan: '平面图/一层.png', w: 4000, h: 3000 },
    { id: 'F2', title: '二层', name: '二层平面', plan: '平面图/二层.png', w: 4000, h: 2800, short: '2F' },
  ],
  pages: [
    { floor: 'F1', file: 'jpg/1 (1).jpg', room: '客厅', view: '沙发', conf: 'high', note: '1 (1).jpg' },
    { floor: 'F1', file: 'jpg/1 (2).jpg', room: '餐厅', view: '餐桌' },
    { floor: 'F2', file: 'jpg/2 (1).jpg', room: '主卧' },
  ],
});

function toolPayload(message: Record<string, unknown> | null): {
  filename: string;
  page_count: number;
  schema: string;
  html: string;
} {
  const result = message?.result as { structuredContent?: Record<string, unknown>; isError?: boolean } | undefined;
  assert.equal(result?.isError, undefined);
  const content = result?.structuredContent;
  assert.ok(content);
  return content as ReturnType<typeof toolPayload>;
}

function bootstrapOf(html: string): {
  project: string;
  sourcePdf: string;
  base: string;
  mode: string;
  schema: string;
  storeKey: string;
  floors: Array<{ id: string; short?: string; plan: string }>;
  sections: Record<string, string>;
  dupOf: Record<string, number>;
  pages: Array<{ no: number; file: string; floor: string; sec: string; conf: string }>;
} {
  const match = html.match(/<script id="bootstrap" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match?.[1], 'bootstrap script missing');
  return JSON.parse(match[1]) as ReturnType<typeof bootstrapOf>;
}

describe('camera annotation html', () => {
  it('embeds the project, page count, and panorama UI', () => {
    const result = buildAnnotationHtml(sample());
    const boot = bootstrapOf(result.html);
    assert.equal(result.filename, '示例别墅-机位标注.html');
    assert.equal(result.mode, 'pano');
    assert.equal(result.page_count, 3);
    assert.equal(result.floor_count, 2);
    assert.equal(result.schema, PANO_SCHEMA);
    assert.equal(boot.project, '示例别墅');
    assert.equal(boot.sourcePdf, '方案平面.pdf');
    assert.equal(boot.base, '../');
    assert.equal(boot.mode, 'pano');
    assert.equal(boot.schema, PANO_SCHEMA);
    assert.equal(boot.storeKey, 'camera-annot.示例别墅');
    assert.equal(boot.pages.length, 3);
    assert.equal(boot.pages[0]?.no, 1);
    assert.equal(boot.pages[2]?.file, 'jpg/2 (1).jpg');
    assert.equal(boot.pages[1]?.conf, 'none');
    assert.equal(boot.floors[1]?.short, '2F');
    assert.equal(boot.sections.jpg, undefined);
    assert.match(result.html, /^<!doctype html>/);
    assert.match(result.html, /<\/html>\s*$/);
    assert.match(result.html, /<title>示例别墅 · 实景全景点位<\/title>/);
    assert.match(result.html, /<div class="bname">示例别墅<\/div>/);
    assert.match(result.html, /<div class="logo">示<\/div>/);
    assert.match(result.html, /<span id="totalCount">3<\/span>/);
    for (const marker of ['id="stage"', 'id="btnImport"', 'id="floorTabs"', '导出', 'id="bootstrap"']) {
      assert.equal(result.html.includes(marker), true, marker);
    }
    assert.match(result.html, /id="btnWedges" title="全景点位模式不使用视场角" hidden/);
    assert.equal(result.html.includes('data-handle="rot"'), false);
    assert.equal(result.html.includes('安徽广德明璟庭'), false);
    assert.equal(result.html.includes('南通和园'), false);
    assert.equal(result.html.includes('gdmjt'), false);
    assert.equal(result.html.includes('nthy5'), false);
    assert.equal(result.scaffold?.exportedAt, null);
    assert.equal(result.scaffold?.note, PANO_NOTE);
    assert.equal(result.scaffold?.floors[0]?.plan, '../平面图/一层.png');
    assert.deepEqual(result.scaffold?.floors[0]?.cameras, []);
    assert.equal(result.scaffold?.pages[2]?.camera, null);
    assert.equal(result.scaffold?.pages[2]?.file, '../jpg/2 (1).jpg');
    assert.deepEqual(result.warnings, [
      'section "jpg" is used on more than one floor; each page keeps its own floor.',
    ]);
    const again = buildAnnotationHtml(sample());
    assert.equal(again.html, result.html);
  });

  it('uses the effect engine and an empty bearing scaffold', () => {
    const result = buildAnnotationHtml({
      ...sample(),
      mode: 'effect',
      pages: [
        { floor: 'F1', file: '一层/一层 (1).jpg', room: '客厅', sec: '一层' },
        { floor: 'F1', file: '一层/一层 (2).jpg', room: '餐厅', sec: '一层' },
      ],
      floors: [{ id: 'F1', title: '一层', plan: '平面图JPG/page_003.jpg', w: 2600, h: 1837 }],
    });
    const boot = bootstrapOf(result.html);
    assert.equal(result.schema, EFFECT_SCHEMA);
    assert.equal(result.page_count, 2);
    assert.equal(boot.pages.length, 2);
    assert.equal(boot.sections['一层'], 'F1');
    assert.match(result.html, /<title>示例别墅 · 效果图机位标注<\/title>/);
    assert.match(result.html, /<span id="totalCount">2<\/span>/);
    assert.match(result.html, /data-handle="rot"/);
    assert.match(result.html, /按下并拖动/);
    assert.equal(result.html.includes('全景点位模式不使用视场角'), false);
    assert.equal(result.scaffold?.note, EFFECT_NOTE);
    assert.equal(result.scaffold?.schema, EFFECT_SCHEMA);
    assert.deepEqual(result.warnings, []);
  });

  it('honours schema, store key, numbering, duplicates, and scaffold opt-out', () => {
    const result = buildAnnotationHtml({
      project: 'Villa',
      mode: 'pano',
      base: '..',
      schema: 'gdmjt.pano-annotations/1',
      storeKey: 'gdmjt.cameras.v1',
      sections: { jpg: 'F1' },
      dupOf: { '2': 1 },
      floors: [{ id: 'F1', title: '一层', plan: '平面图/a.png', w: 10, h: 10 }],
      pages: [
        { no: 2, floor: 'F1', file: 'jpg/b.jpg' },
        { no: 1, floor: 'F1', file: 'jpg/a.jpg' },
      ],
      includeScaffold: false,
    });
    const boot = bootstrapOf(result.html);
    assert.equal(result.scaffold, null);
    assert.equal(result.schema, 'gdmjt.pano-annotations/1');
    assert.equal(boot.storeKey, 'gdmjt');
    assert.equal(boot.base, '../');
    assert.deepEqual(
      boot.pages.map((page) => page.no),
      [1, 2],
    );
    assert.equal(boot.dupOf['2'], 1);
    assert.equal(boot.sections.jpg, 'F1');
    assert.match(result.html, /<div class="logo">VI<\/div>/);
    assert.match(result.html, /<span id="totalCount">2<\/span>/);
  });

  it('rejects empty pages, missing plans, bad paths, and broken references', async () => {
    const base = sample();
    await assert.rejects(async () => buildAnnotationHtml({ ...base, pages: [] }), /pages is empty/);
    await assert.rejects(async () => buildAnnotationHtml({ ...base, floors: [] }), /floors is empty/);
    await assert.rejects(
      async () =>
        buildAnnotationHtml({
          ...base,
          floors: [{ id: 'F1', title: '一层', plan: '', w: 10, h: 10 }],
        }),
      /plan is empty/,
    );
    await assert.rejects(
      async () =>
        buildAnnotationHtml({
          ...base,
          floors: [{ id: 'F1', title: '一层', plan: '平面图/a.png', w: 1.5, h: 10 }],
        }),
      /positive integer w and h/,
    );
    await assert.rejects(
      async () =>
        buildAnnotationHtml({
          ...base,
          floors: [{ id: 'F1', title: '一层', plan: 'https://example.com/a.png', w: 10, h: 10 }],
        }),
      /not a URL/,
    );
    await assert.rejects(
      async () =>
        buildAnnotationHtml({
          ...base,
          pages: [{ floor: 'F1', file: '../secret.jpg' }],
        }),
      /must not contain/,
    );
    await assert.rejects(
      async () =>
        buildAnnotationHtml({
          ...base,
          pages: [{ floor: 'F9', file: 'jpg/a.jpg' }],
        }),
      /unknown floor "F9"/,
    );
    await assert.rejects(async () => buildAnnotationHtml({ ...base, mode: 'tour' }), /mode must be/);
    await assert.rejects(async () => buildAnnotationHtml({ ...base, base: 'https://evil/' }), /base must be/);
    await assert.rejects(
      async () =>
        buildAnnotationHtml({
          ...base,
          pages: [
            { no: 1, floor: 'F1', file: 'jpg/a.jpg' },
            { floor: 'F1', file: 'jpg/b.jpg' },
          ],
        }),
      /omit no on every page/,
    );
    await assert.rejects(
      async () => buildAnnotationHtml({ ...base, dupOf: { '1': 1 } }),
      (error: unknown) => error instanceof PublicError && /cannot point at itself/.test(error.message),
    );
  });

  it('keeps a script-breaking room name inside the bootstrap JSON', () => {
    const payload = '</script><script>alert(1)</script>';
    const result = buildAnnotationHtml({
      ...sample(),
      sourcePdf: payload,
      title: '</title><script>alert(1)</script>',
      pages: [{ floor: 'F1', file: 'jpg/a.jpg', room: payload }],
      floors: [{ id: 'F1', title: '一层', plan: '平面图/a.png', w: 8, h: 8 }],
    });
    assert.equal((result.html.match(/<\/script>/g) ?? []).length, 2);
    assert.equal((result.html.match(/<\/title>/g) ?? []).length, 1);
    assert.equal(result.html.includes('</script><script>'), false);
    assert.equal(bootstrapOf(result.html).sourcePdf, payload);
    assert.equal(bootstrapOf(result.html).pages[0]?.file, 'jpg/a.jpg');
    const page = JSON.parse(
      result.html.match(/<script id="bootstrap" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? '{}',
    ) as { pages: Array<{ room: string }> };
    assert.equal(page.pages[0]?.room, payload);
  });

  it('validates without rendering and warns about an unused floor', () => {
    const checked = validateAnnotation({
      ...sample(),
      floors: [
        { id: 'F1', title: '一层', plan: '平面图/a.png', w: 10, h: 10 },
        { id: 'F2', title: '二层', plan: '平面图/b.png', w: 10, h: 10 },
      ],
      pages: [
        { floor: 'F1', file: 'jpg/a.jpg', sec: 'jpg' },
        { floor: 'F1', file: 'jpg/a.jpg', sec: 'jpg' },
      ],
    });
    assert.equal(checked.page_count, 2);
    assert.equal(checked.floor_count, 2);
    assert.equal(checked.warnings.includes('floor "F2" has no pages.'), true);
    assert.equal(checked.warnings.some((warning) => warning.includes('listed 2 times')), true);
  });
});

describe('camera annotation over MCP', () => {
  it('lists the tools and returns html that contains the project and page count', async () => {
    const running = await startServer(memoryStore());
    try {
      const listed = await postMcp(running.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, authHeader());
      assert.equal(listed.status, 200, listed.text);
      const names = JSON.stringify(listed.message);
      assert.equal(names.includes(CAMERA_ANNOT_BUILD), true);
      assert.equal(names.includes(CAMERA_ANNOT_VALIDATE), true);
      assert.equal(names.includes('generation_'), false);

      const built = await postMcp(
        running.base,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: CAMERA_ANNOT_BUILD,
            arguments: {
              project: '示例别墅',
              mode: 'pano',
              floors: [{ id: 'F1', title: '一层', plan: '平面图/一层.png', w: 100, h: 80 }],
              pages: [
                { floor: 'F1', file: 'jpg/1 (1).jpg', room: '客厅' },
                { floor: 'F1', file: 'jpg/1 (2).jpg', room: '餐厅' },
              ],
            },
          },
        },
        authHeader(),
      );
      assert.equal(built.status, 200, built.text.slice(0, 500));
      const payload = toolPayload(built.message);
      assert.equal(payload.filename, '示例别墅-机位标注.html');
      assert.equal(payload.page_count, 2);
      assert.equal(payload.schema, PANO_SCHEMA);
      assert.match(payload.html, /<title>示例别墅 · 实景全景点位<\/title>/);
      assert.match(payload.html, /<span id="totalCount">2<\/span>/);
      assert.equal(payload.html.includes('id="stage"'), true);

      const invalid = await postMcp(
        running.base,
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: CAMERA_ANNOT_BUILD,
            arguments: {
              project: '示例别墅',
              mode: 'effect',
              floors: [{ id: 'F1', title: '一层', plan: '平面图/一层.png', w: 100, h: 80 }],
              pages: [],
            },
          },
        },
        authHeader(),
      );
      assert.equal(invalid.status, 200, invalid.text.slice(0, 500));
      assert.match(JSON.stringify(invalid.message), /pages is empty/);
    } finally {
      await running.close();
    }
  });

  it('stays available without COS and hides when the flag is false', async () => {
    const withoutCos = await startServer(null, {
      COS_SECRET_ID: undefined,
      COS_SECRET_KEY: undefined,
      COS_REGION: undefined,
      COS_BUCKET: undefined,
      COS_PREFIX: undefined,
    });
    try {
      const health = await fetch(`${withoutCos.base}/health`);
      const body = await health.text();
      assert.match(body, /"id":"camera-annot","enabled":true/);
      assert.match(body, /"id":"imagebed","enabled":false/);
      const listed = await postMcp(withoutCos.base, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authHeader());
      assert.equal(JSON.stringify(listed.message).includes(CAMERA_ANNOT_BUILD), true);
    } finally {
      await withoutCos.close();
    }

    const disabled = await startServer(memoryStore(), { PACK_CAMERA_ANNOT_ENABLED: 'false' });
    try {
      const health = await fetch(`${disabled.base}/health`);
      assert.match(await health.text(), /"id":"camera-annot","enabled":false/);
      const listed = await postMcp(disabled.base, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authHeader());
      assert.equal(JSON.stringify(listed.message).includes(CAMERA_ANNOT_BUILD), false);
      assert.equal(JSON.stringify(listed.message).includes(CAMERA_ANNOT_VALIDATE), false);
    } finally {
      await disabled.close();
    }

    assert.equal(appConfig().cameraAnnotEnabled, true);
    assert.throws(() => loadConfig({ MCP_AUTH_TOKEN: 'test-token-value-0123456789', PACK_CAMERA_ANNOT_ENABLED: 'yes' }), /true or false/);
  });
});

describe('camera annotation templates', () => {
  it('does not keep the reference project names', () => {
    for (const name of ['template-pano.html', 'template-effect.html']) {
      const text = readFileSync(new URL(`../src/packs/camera-annot/${name}`, import.meta.url), 'utf8');
      for (const banned of ['安徽广德明璟庭', '南通和园', '香樟园', 'gdmjt', 'nthy5']) {
        assert.equal(text.includes(banned), false, `${name} still contains ${banned}`);
      }
      assert.equal(text.includes('__BOOTSTRAP_JSON__'), true);
      assert.equal(text.includes('id="stage"'), true);
    }
  });
});
