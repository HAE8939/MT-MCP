import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';
import { PublicError } from '../src/packs/design-prompts/errors.js';
import { DESIGN_GET_PROMPT, DESIGN_LIST_PROMPTS } from '../src/packs/design-prompts/index.js';
import { getPrompt, listPrompts, type DesignPrompt } from '../src/packs/design-prompts/library.js';
import { appConfig, authHeader, memoryStore, postMcp, startServer } from './helpers.js';

const EXPECTED = [
  {
    id: '14a956a9-5c6e-4c3a-98d1-485bf385542b',
    title: '通用效果图返推大师',
    slug: 'rendering/01_render_reverse_master',
    category: 'rendering',
  },
  {
    id: '212b09ae-e8e2-4df4-b384-5ec52755c76c',
    title: '效果图设计提示词',
    slug: 'rendering/02_render_design_prompt',
    category: 'rendering',
  },
  {
    id: '1d3be541-be7c-4ba4-b222-76979b3d4989',
    title: '情绪板大师',
    slug: 'moodboard/03_moodboard_master',
    category: 'moodboard',
  },
  {
    id: 'ccbaeee7-d54d-4c66-873e-bbc2a920296c',
    title: '九宫格分镜图',
    slug: 'camera/04_nine_grid_storyboard',
    category: 'camera',
  },
  {
    id: '11c3ae3a-bbfc-4405-9fd1-6b217618d1f5',
    title: '换角度',
    slug: 'camera/05_change_angle',
    category: 'camera',
  },
] as const;

function fileVersion(slug: string): string {
  const bytes = readFileSync(new URL(`../src/packs/design-prompts/prompts/${slug}.md`, import.meta.url));
  return `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
}

function toolResult(message: Record<string, unknown> | null): {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  text: string;
} {
  const result = message?.result as
    | { structuredContent?: Record<string, unknown>; isError?: boolean; content?: Array<{ text?: string }> }
    | undefined;
  const text = result?.content?.map((part) => part.text ?? '').join('\n') ?? '';
  return { isError: result?.isError, structuredContent: result?.structuredContent, text };
}

describe('design prompt library', () => {
  it('lists the five checked-in prompts in filename order', () => {
    const prompts = listPrompts();
    assert.deepEqual(
      prompts.map((prompt) => prompt.slug),
      EXPECTED.map((prompt) => prompt.slug),
    );
    for (const [index, expected] of EXPECTED.entries()) {
      const prompt = prompts[index];
      assert.ok(prompt);
      assert.equal(prompt.id, expected.id);
      assert.equal(prompt.title, expected.title);
      assert.equal(prompt.category, expected.category);
      assert.equal(prompt.path, `${expected.slug}.md`);
      assert.equal(prompt.model, 'Gemini');
      assert.deepEqual(prompt.tags, ['AI角色', '提示词']);
      assert.equal(prompt.description.length > 0, true);
      assert.equal(prompt.version, fileVersion(expected.slug));
      assert.equal('prompt' in prompt, false);
    }
    assert.equal(prompts[3]?.image, 'src/九宫格.png');
    assert.equal(prompts[0]?.image, undefined);
  });

  it('returns the prompt body and notes without the section headings', () => {
    const reverse = getPrompt({ id: EXPECTED[0].id });
    assert.equal(reverse.slug, EXPECTED[0].slug);
    assert.equal(reverse.prompt.startsWith('帮我分析用户提供的照片和提示词'), true);
    assert.equal(reverse.prompt.includes('# Prompt'), false);
    assert.equal(reverse.prompt.includes('用户可根据需要增加自定义键名'), false);
    assert.match(reverse.prompt, /\n  "空间类型": \{/);
    assert.match(reverse.prompt, /严格保持原始 su 场景结构/);
    assert.equal(
      reverse.notes,
      'JSON 格式，包含 6 大维度：空间类型、核心约束、场景与光效、材质控制、摄影参数、渲染精度。用户可根据需要增加自定义键名。',
    );

    const moodboard = getPrompt({ slug: 'moodboard/03_moodboard_master.md' });
    assert.equal(moodboard.id, EXPECTED[2].id);
    assert.match(moodboard.prompt, /^# 角色提示词：专业室内设计软装材质情绪板提取师/);
    assert.equal(moodboard.prompt.includes('# Notes'), false);
    assert.match(moodboard.notes ?? '', /材质样本摆放、元素组合/);

    const storyboard = getPrompt({ slug: EXPECTED[3].slug });
    assert.equal(storyboard.image, 'src/九宫格.png');
    assert.match(storyboard.prompt, /第9格图片\.广角全景镜头/);
    assert.match(storyboard.notes ?? '', /9 个镜头角度无重复/);

    const angle = getPrompt({ id: EXPECTED[4].id, slug: EXPECTED[4].slug });
    assert.match(angle.prompt, /角度1：/);
    assert.match(angle.notes ?? '', /4 条完整提示词/);
    assert.equal(getPrompt({ slug: EXPECTED[4].slug }).prompt, angle.prompt);
  });

  it('rejects a missing id, a missing slug, and a mismatched pair', () => {
    assert.throws(() => getPrompt({ id: 'does-not-exist' }), (error: unknown) => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.message, 'Unknown prompt id "does-not-exist".');
      assert.equal(error.message.includes('/'), false);
      return true;
    });
    assert.throws(() => getPrompt({ slug: 'rendering/missing' }), /Unknown prompt slug "rendering\/missing"/);
    assert.throws(() => getPrompt({}), /Provide a prompt id or slug/);
    assert.throws(() => getPrompt({ id: '   ', slug: '   ' }), /Provide a prompt id or slug/);
    assert.throws(() => getPrompt({ slug: '../secrets/token' }), /Prompt slug must look like/);
    assert.throws(() => getPrompt({ slug: '/rendering/01_render_reverse_master' }), /Prompt slug must look like/);
    assert.throws(
      () => getPrompt({ id: EXPECTED[0].id, slug: EXPECTED[1].slug }),
      /Prompt id and slug do not refer to the same prompt/,
    );
  });

  it('reports a broken markdown file by its library path', () => {
    const root = mkdtempSync(join(tmpdir(), 'design-prompts-'));
    try {
      writePrompt(root, 'rendering/draft.md', 'title: 草稿\n', '正文');
      assert.throws(() => listPrompts(root), /rendering\/draft\.md is missing id/);

      writePrompt(root, 'rendering/draft.md', 'id: same-id\ntitle: 一\n', '一');
      writePrompt(root, 'camera/other.md', 'id: same-id\ntitle: 二\n', '二');
      assert.throws(() => getPrompt({ id: 'same-id' }, root), /used by both/);

      writePrompt(root, 'rendering/draft.md', 'id: only-id\ntitle: 只有标题\nversion: 2026.11\n', '');
      rmSync(join(root, 'camera'), { recursive: true, force: true });
      assert.throws(() => getPrompt({ id: 'only-id' }, root), /missing a "# Prompt" section/);

      writePrompt(
        root,
        'rendering/draft.md',
        'id: only-id\ntitle: "带引号的标题"\ndescription: 说明\ntags:\n  - 标签\nversion: 2026.11\n',
        '可用正文',
      );
      const prompt = getPrompt({ slug: 'rendering/draft' }, root);
      assert.equal(prompt.title, '带引号的标题');
      assert.equal(prompt.version, '2026.11');
      assert.equal(prompt.prompt, '可用正文');
      assert.equal(prompt.notes, undefined);
      assert.deepEqual(prompt.tags, ['标签']);

      writeFileSync(join(root, 'loose.md'), '---\nid: loose\ntitle: 根目录\n---\n\n# Prompt\n\n不行\n');
      assert.throws(() => listPrompts(root), /must live in a category folder/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('design prompts over MCP', () => {
  it('lists and fetches prompts, and reports an unknown id', async () => {
    const running = await startServer(memoryStore());
    try {
      const health = await fetch(`${running.base}/health`);
      assert.match(await health.text(), /"id":"design-prompts","enabled":true/);
      const root = await fetch(`${running.base}/`);
      assert.match(await root.text(), /"design-prompts"/);

      const listed = await postMcp(running.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, authHeader());
      assert.equal(listed.status, 200, listed.text);
      const names = JSON.stringify(listed.message);
      assert.equal(names.includes(DESIGN_LIST_PROMPTS), true);
      assert.equal(names.includes(DESIGN_GET_PROMPT), true);

      const catalog = await postMcp(
        running.base,
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: DESIGN_LIST_PROMPTS, arguments: {} } },
        authHeader(),
      );
      assert.equal(catalog.status, 200, catalog.text.slice(0, 500));
      const catalogResult = toolResult(catalog.message);
      assert.equal(catalogResult.isError, undefined);
      const prompts = catalogResult.structuredContent?.prompts as Array<Record<string, unknown>>;
      assert.equal(prompts.length, 5);
      assert.deepEqual(
        prompts.map((prompt) => prompt.slug),
        EXPECTED.map((prompt) => prompt.slug),
      );
      assert.equal(prompts[0]?.title, '通用效果图返推大师');
      assert.equal('prompt' in (prompts[0] ?? {}), false);
      assert.match(catalogResult.text, /设计提示词 5 条/);
      assert.match(catalogResult.text, /换角度/);

      const fetched = await postMcp(
        running.base,
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: DESIGN_GET_PROMPT, arguments: { slug: 'rendering/02_render_design_prompt' } },
        },
        authHeader(),
      );
      const fetchedResult = toolResult(fetched.message);
      assert.equal(fetchedResult.isError, undefined, fetchedResult.text);
      const body = fetchedResult.structuredContent as unknown as DesignPrompt;
      assert.equal(body.id, EXPECTED[1].id);
      assert.equal(body.title, '效果图设计提示词');
      assert.match(body.prompt, /你是"效果图设计"角色/);
      assert.match(body.notes ?? '', /基础版提示词 \+ 细化版提示词/);
      assert.match(fetchedResult.text, /效果图设计提示词/);
      assert.match(fetchedResult.text, /你是"效果图设计"角色/);

      const missing = await postMcp(
        running.base,
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: DESIGN_GET_PROMPT, arguments: { id: 'does-not-exist' } },
        },
        authHeader(),
      );
      assert.equal(missing.status, 200, missing.text.slice(0, 500));
      const missingResult = toolResult(missing.message);
      assert.equal(missingResult.isError, true);
      assert.equal(missingResult.text, 'Unknown prompt id "does-not-exist".');
      assert.equal(missingResult.structuredContent, undefined);

      const blank = await postMcp(
        running.base,
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: DESIGN_GET_PROMPT, arguments: {} },
        },
        authHeader(),
      );
      assert.equal(toolResult(blank.message).text, 'Provide a prompt id or slug.');
    } finally {
      await running.close();
    }
  });

  it('stays on by default and hides when the flag is false', async () => {
    assert.equal(appConfig().designPromptsEnabled, true);
    assert.equal(appConfig({ PACK_DESIGN_PROMPTS_ENABLED: '' }).designPromptsEnabled, true);
    assert.equal(appConfig({ PACK_DESIGN_PROMPTS_ENABLED: 'false' }).designPromptsEnabled, false);
    assert.throws(
      () => loadConfig({ MCP_AUTH_TOKEN: 'test-token-value-0123456789', PACK_DESIGN_PROMPTS_ENABLED: 'yes' }),
      /PACK_DESIGN_PROMPTS_ENABLED must be true or false/,
    );

    const disabled = await startServer(memoryStore(), { PACK_DESIGN_PROMPTS_ENABLED: 'false' });
    try {
      const health = await fetch(`${disabled.base}/health`);
      assert.match(await health.text(), /"id":"design-prompts","enabled":false/);
      const listed = await postMcp(disabled.base, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authHeader());
      const names = JSON.stringify(listed.message);
      assert.equal(names.includes(DESIGN_LIST_PROMPTS), false);
      assert.equal(names.includes(DESIGN_GET_PROMPT), false);
      assert.equal(names.includes('camera_annot_build_html'), true);
    } finally {
      await disabled.close();
    }
  });
});

function writePrompt(root: string, rel: string, frontmatter: string, prompt: string, notes?: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  const noteSection = notes === undefined ? '' : `\n\n# Notes\n\n${notes}\n`;
  const body = prompt ? `\n# Prompt\n\n${prompt}\n${noteSection}` : '\n';
  writeFileSync(abs, `---\n${frontmatter}---${body}`);
}
