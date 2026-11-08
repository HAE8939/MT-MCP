import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PublicError } from './errors.js';

/**
 * Markdown prompt library. Each call reads the files under `prompts/`
 * next to this module. `npm run dev` therefore sees edits immediately.
 * `npm run build` copies the same tree to `dist/` so `node dist` can
 * read it the same way.
 *
 * A prompt file is `<category>/<stem>.md` with YAML frontmatter and a
 * `# Prompt` section. `# Notes` is optional. `version` in frontmatter
 * wins; otherwise the version is `sha256:` plus the first 12 hex chars
 * of the file bytes.
 */

const CATEGORY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FILE_STEM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ID = 80;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_TAGS = 20;
const MAX_TAG = 40;
const MAX_SHORT = 300;

export interface DesignPromptSummary {
  id: string;
  title: string;
  description: string;
  tags: string[];
  category: string;
  slug: string;
  path: string;
  model?: string;
  image?: string;
  version: string;
}

export interface DesignPrompt extends DesignPromptSummary {
  prompt: string;
  notes?: string;
}

function defaultPromptsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'prompts');
}

export function listPrompts(root: string = defaultPromptsRoot()): DesignPromptSummary[] {
  return loadLibrary(root).map(toSummary);
}

export function getPrompt(
  query: { id?: string | undefined; slug?: string | undefined },
  root: string = defaultPromptsRoot(),
): DesignPrompt {
  const id = query.id?.trim() ?? '';
  const slugInput = query.slug?.trim() ?? '';
  if (!id && !slugInput) throw new PublicError('Provide a prompt id or slug.');
  const slug = slugInput ? canonicalSlug(slugInput) : '';
  const library = loadLibrary(root);
  if (id) {
    const found = library.find((prompt) => prompt.id === id);
    if (!found) throw new PublicError(`Unknown prompt id "${id}".`);
    if (slug && found.slug !== slug) {
      throw new PublicError('Prompt id and slug do not refer to the same prompt.');
    }
    return found;
  }
  const found = library.find((prompt) => prompt.slug === slug);
  if (!found) throw new PublicError(`Unknown prompt slug "${slug}".`);
  return found;
}

function canonicalSlug(input: string): string {
  const trimmed = input.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.includes('\0')) {
    throw new PublicError('Prompt slug must look like rendering/01_render_reverse_master.');
  }
  const slug = trimmed.endsWith('.md') ? trimmed.slice(0, -'.md'.length) : trimmed;
  const parts = slug.split('/');
  if (slug.startsWith('/') || parts.length !== 2 || parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new PublicError('Prompt slug must look like rendering/01_render_reverse_master.');
  }
  const category = parts[0] ?? '';
  const stem = parts[1] ?? '';
  if (!CATEGORY_NAME.test(category) || !FILE_STEM.test(stem)) {
    throw new PublicError('Prompt slug must look like rendering/01_render_reverse_master.');
  }
  return `${category}/${stem}`;
}

function loadLibrary(root: string): DesignPrompt[] {
  const prompts = collectFiles(root).map((file) => readPrompt(root, file));
  prompts.sort((a, b) => filenameOf(a.path).localeCompare(filenameOf(b.path), 'en', { numeric: true }) || a.path.localeCompare(b.path, 'en'));
  const seen = new Map<string, string>();
  for (const prompt of prompts) {
    const previous = seen.get(prompt.id);
    if (previous) {
      throw new PublicError(`Prompt id "${prompt.id}" is used by both ${previous} and ${prompt.path}.`);
    }
    seen.set(prompt.id, prompt.path);
  }
  return prompts;
}

function collectFiles(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    throw new PublicError('Design prompt library is not available on the server.');
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile() && entry.name.endsWith('.md')) {
      throw new PublicError(`Prompt file "${entry.name}" must live in a category folder such as rendering/.`);
    }
    if (!entry.isDirectory()) continue;
    if (!CATEGORY_NAME.test(entry.name)) {
      throw new PublicError(`Prompt category "${entry.name}" must use letters, numbers, underscores, or hyphens.`);
    }
    let children;
    try {
      children = readdirSync(join(root, entry.name), { withFileTypes: true });
    } catch {
      throw new PublicError(`Prompt category "${entry.name}" could not be read.`);
    }
    for (const child of children) {
      if (child.name.startsWith('.')) continue;
      const rel = `${entry.name}/${child.name}`;
      if (child.isDirectory()) {
        throw new PublicError(`Prompt file "${rel}" must sit directly under a category folder.`);
      }
      if (!child.isFile() || !child.name.endsWith('.md')) continue;
      const stem = child.name.slice(0, -'.md'.length);
      if (!FILE_STEM.test(stem)) {
        throw new PublicError(`Prompt filename "${rel}" must use letters, numbers, dots, underscores, or hyphens.`);
      }
      files.push(join(root, entry.name, child.name));
    }
  }
  return files;
}

function readPrompt(root: string, abs: string): DesignPrompt {
  const rel = toPosix(root, abs);
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch {
    throw new PublicError(`Prompt file ${rel} could not be read.`);
  }
  const text = decodeUtf8(bytes, rel).replace(/^\uFEFF/, '');
  const parsed = parseDocument(text, rel);
  const category = rel.slice(0, rel.indexOf('/'));
  const slug = rel.slice(0, -'.md'.length);
  return {
    id: parsed.id,
    title: parsed.title,
    description: parsed.description,
    tags: parsed.tags,
    category,
    slug,
    path: rel,
    model: parsed.model,
    image: parsed.image,
    version: parsed.version ?? contentVersion(bytes),
    prompt: parsed.prompt,
    notes: parsed.notes,
  };
}

function contentVersion(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
}

function decodeUtf8(bytes: Buffer, rel: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PublicError(`Prompt file ${rel} is not valid UTF-8.`);
  }
}

interface ParsedDocument {
  id: string;
  title: string;
  description: string;
  tags: string[];
  model?: string;
  image?: string;
  version?: string;
  prompt: string;
  notes?: string;
}

function parseDocument(text: string, rel: string): ParsedDocument {
  if (!text.startsWith('---')) {
    throw new PublicError(`Prompt file ${rel} is missing YAML frontmatter.`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new PublicError(`Prompt file ${rel} has unclosed frontmatter.`);
  const fields = parseFrontmatter(match[1] ?? '', rel);
  const sections = splitSections(text.slice(match[0].length), rel);
  const id = requireToken(scalar(fields, 'id', rel), rel, 'id');
  const title = requireLine(scalar(fields, 'title', rel), rel, 'title', MAX_TITLE);
  const description = optionalLine(scalar(fields, 'description', rel), rel, 'description', MAX_DESCRIPTION) ?? '';
  return {
    id,
    title,
    description,
    tags: tagList(fields, rel),
    model: optionalLine(scalar(fields, 'model', rel), rel, 'model', MAX_SHORT),
    image: optionalLine(scalar(fields, 'image', rel), rel, 'image', MAX_SHORT),
    version: optionalLine(scalar(fields, 'version', rel), rel, 'version', MAX_SHORT),
    prompt: sections.prompt,
    notes: sections.notes,
  };
}

function parseFrontmatter(yaml: string, rel: string): Map<string, string | string[]> {
  const lines = yaml.split(/\r?\n/);
  const result = new Map<string, string | string[]>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) {
      throw new PublicError(`Prompt file ${rel} has unexpected indented frontmatter: ${line.trim()}`);
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!kv || kv[1] === undefined) {
      throw new PublicError(`Prompt file ${rel} has unsupported frontmatter: ${line.trim()}`);
    }
    const key = kv[1];
    const rest = kv[2] ?? '';
    if (result.has(key)) throw new PublicError(`Prompt file ${rel} repeats frontmatter key "${key}".`);
    if (rest === '') {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        if (next.trim() === '') {
          j++;
          continue;
        }
        if (!/^\s/.test(next)) break;
        const item = /^[ \t]*-[ \t]+(.*)$/.exec(next);
        if (!item) throw new PublicError(`Prompt file ${rel} has an invalid list item under "${key}".`);
        const value = unquote(item[1] ?? '');
        if (!value) throw new PublicError(`Prompt file ${rel} has an empty list item under "${key}".`);
        items.push(value);
        j++;
      }
      result.set(key, items);
      i = j - 1;
      continue;
    }
    if (rest === '[]') {
      result.set(key, []);
      continue;
    }
    if (rest === '|' || rest === '>' || rest.startsWith('|') || rest.startsWith('>')) {
      throw new PublicError(`Prompt file ${rel} must keep "${key}" on one line.`);
    }
    result.set(key, unquote(rest));
  }
  return result;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return unescapeDouble(value.slice(1, -1));
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function unescapeDouble(inner: string): string {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next !== undefined) out += next;
      i++;
      continue;
    }
    if (char !== undefined) out += char;
  }
  return out;
}

function scalar(fields: Map<string, string | string[]>, key: string, rel: string): string | undefined {
  if (!fields.has(key)) return undefined;
  const value = fields.get(key);
  if (typeof value !== 'string') {
    throw new PublicError(`Prompt file ${rel} field "${key}" must be a single-line string.`);
  }
  return value;
}

function tagList(fields: Map<string, string | string[]>, rel: string): string[] {
  if (!fields.has('tags')) return [];
  const value = fields.get('tags');
  if (!Array.isArray(value)) throw new PublicError(`Prompt file ${rel} field "tags" must be a list.`);
  if (value.length > MAX_TAGS) throw new PublicError(`Prompt file ${rel} has too many tags.`);
  return value.map((tag) => {
    if (tag.length > MAX_TAG || /[\r\n]/.test(tag)) {
      throw new PublicError(`Prompt file ${rel} has an invalid tag.`);
    }
    return tag;
  });
}

function requireToken(value: string | undefined, rel: string, field: string): string {
  if (value === undefined || value === '') throw new PublicError(`Prompt file ${rel} is missing ${field}.`);
  if (value.length > MAX_ID || !ID_TOKEN.test(value)) {
    throw new PublicError(`Prompt file ${rel} has an invalid ${field}.`);
  }
  return value;
}

function requireLine(value: string | undefined, rel: string, field: string, max: number): string {
  if (value === undefined || value.trim() === '') throw new PublicError(`Prompt file ${rel} is missing ${field}.`);
  if (value.length > max || /[\r\n]/.test(value)) {
    throw new PublicError(`Prompt file ${rel} has an invalid ${field}.`);
  }
  return value.trim();
}

function optionalLine(value: string | undefined, rel: string, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max || /[\r\n]/.test(trimmed)) {
    throw new PublicError(`Prompt file ${rel} has an invalid ${field}.`);
  }
  return trimmed;
}

function splitSections(body: string, rel: string): { prompt: string; notes?: string } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let promptAt = -1;
  let notesAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? '';
    if (promptAt === -1 && trimmed === '# Prompt') {
      promptAt = i;
      continue;
    }
    if (promptAt !== -1 && notesAt === -1 && trimmed === '# Notes') {
      notesAt = i;
      break;
    }
  }
  if (promptAt === -1) throw new PublicError(`Prompt file ${rel} is missing a "# Prompt" section.`);
  const prompt = lines.slice(promptAt + 1, notesAt === -1 ? undefined : notesAt).join('\n').trim();
  if (!prompt) throw new PublicError(`Prompt file ${rel} has an empty prompt body.`);
  if (notesAt === -1) return { prompt };
  const notes = lines.slice(notesAt + 1).join('\n').trim();
  return notes ? { prompt, notes } : { prompt };
}

function toSummary(prompt: DesignPrompt): DesignPromptSummary {
  return {
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
  };
}

function toPosix(root: string, abs: string): string {
  const rel = relative(root, abs);
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || rel === '') {
    throw new PublicError('Prompt path escaped the library.');
  }
  return rel.split(sep).join('/');
}

function filenameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}
