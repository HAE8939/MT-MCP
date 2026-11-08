import { PublicError } from './errors.js';
import {
  annotationTemplate,
  embedBootstrapJson,
  escapeHtml,
  fillAnnotationTemplate,
  type AnnotMode,
} from './template.js';

export type { AnnotMode };

export const PANO_SCHEMA = 'camera-annot.pano-annotations/1';
export const EFFECT_SCHEMA = 'camera-annot.camera-annotations/1';

/** Same sentence the panorama page writes on Export → JSON. */
export const PANO_NOTE =
  '实景全景点位：仅记录平面图像素坐标 x/y 与归一化 nx/ny；dir/fov 不使用（为 null）。';
/** Same sentence the effect-image page writes on Export → JSON. */
export const EFFECT_NOTE =
  'dir = 图纸上方为 0°、顺时针的方位角；x/y 为平面图像素坐标；nx/ny 为 0-1 归一化坐标。';

const MAX_FLOORS = 40;
const MAX_PAGES = 2000;
const MAX_DIM = 100_000;
const MAX_WARNINGS = 12;

const CONF = new Set(['high', 'mid', 'low', 'dup', 'none']);

export interface FloorInput {
  id?: string;
  title?: string;
  name?: string;
  short?: string;
  plan?: string;
  w?: number;
  h?: number;
}

export interface PageInput {
  no?: number;
  sec?: string;
  floor?: string;
  room?: string;
  view?: string;
  conf?: string;
  note?: string;
  file?: string;
}

export interface AnnotationInput {
  project?: string;
  sourcePdf?: string;
  base?: string;
  mode?: string;
  title?: string;
  subtitle?: string;
  logo?: string;
  storeKey?: string;
  schema?: string;
  floors?: FloorInput[];
  pages?: PageInput[];
  sections?: Record<string, string>;
  dupOf?: Record<string, number>;
  includeScaffold?: boolean;
}

export interface ScaffoldFloor {
  id: string;
  title: string;
  name: string;
  plan: string;
  w: number;
  h: number;
  cameras: [];
}

export interface ScaffoldPage {
  no: number;
  floor: string;
  room: string;
  view: string;
  conf: string;
  note: string;
  file: string;
  camera: null;
}

/** Empty export document, matching Export → JSON before any point is placed. */
export interface AnnotationScaffold {
  schema: string;
  project: string;
  sourcePdf: string;
  exportedAt: null;
  note: string;
  floors: ScaffoldFloor[];
  pages: ScaffoldPage[];
}

export interface BuildResult {
  filename: string;
  mode: AnnotMode;
  project: string;
  schema: string;
  floor_count: number;
  page_count: number;
  warnings: string[];
  html: string;
  scaffold: AnnotationScaffold | null;
}

interface FloorOut {
  id: string;
  title: string;
  name: string;
  plan: string;
  w: number;
  h: number;
  short?: string;
}

interface PageOut {
  no: number;
  sec: string;
  floor: string;
  room: string;
  view: string;
  conf: string;
  note: string;
  file: string;
}

interface Bootstrap {
  project: string;
  sourcePdf: string;
  base: string;
  mode: AnnotMode;
  schema: string;
  storeKey: string;
  floors: FloorOut[];
  sections: Record<string, string>;
  dupOf: Record<string, number>;
  pages: PageOut[];
}

interface Prepared {
  bootstrap: Bootstrap;
  title: string;
  subtitle: string;
  logo: string;
  filename: string;
  warnings: string[];
  includeScaffold: boolean;
}

export function buildAnnotationHtml(input: AnnotationInput): BuildResult {
  const prepared = prepareAnnotation(input);
  const html = renderHtml(prepared);
  return {
    filename: prepared.filename,
    mode: prepared.bootstrap.mode,
    project: prepared.bootstrap.project,
    schema: prepared.bootstrap.schema,
    floor_count: prepared.bootstrap.floors.length,
    page_count: prepared.bootstrap.pages.length,
    warnings: prepared.warnings,
    html,
    scaffold: prepared.includeScaffold ? emptyScaffold(prepared.bootstrap) : null,
  };
}

export function validateAnnotation(input: AnnotationInput): Omit<BuildResult, 'html' | 'scaffold'> {
  const prepared = prepareAnnotation(input);
  return {
    filename: prepared.filename,
    mode: prepared.bootstrap.mode,
    project: prepared.bootstrap.project,
    schema: prepared.bootstrap.schema,
    floor_count: prepared.bootstrap.floors.length,
    page_count: prepared.bootstrap.pages.length,
    warnings: prepared.warnings,
  };
}

function prepareAnnotation(input: AnnotationInput): Prepared {
  const problems: string[] = [];
  const warnings: string[] = [];

  const project = cleanText(input.project, 'project', 80, problems);
  if (!project) problems.push('project is required.');
  else if (/[\\/:*?"<>|]/.test(project)) {
    problems.push('project contains a character that cannot be used in the HTML file name.');
  }

  const mode = input.mode;
  if (mode !== 'pano' && mode !== 'effect') problems.push('mode must be "pano" or "effect".');

  const sourcePdf = cleanText(input.sourcePdf, 'source_pdf', 200, problems);
  const base = normalizeBase(input.base, problems);
  const floors = normalizeFloors(input.floors, problems);
  const pages = normalizePages(input.pages, new Set(floors.map((floor) => floor.id)), problems);
  const sections = normalizeSections(input.sections, pages, floors, problems, warnings);
  const dupOf = normalizeDupOf(input.dupOf, new Set(pages.map((page) => page.no)), problems);

  const schema = normalizeSchema(mode === 'pano' || mode === 'effect' ? mode : undefined, input.schema, problems);
  const storeKey = normalizeStoreKey(project, input.storeKey, problems);
  const title = optionalText(input.title, 'title', 120, problems) || defaultTitle(project, mode);
  const subtitle = optionalText(input.subtitle, 'subtitle', 80, problems) || defaultSubtitle(mode);
  const logo = normalizeLogo(project, input.logo, problems);

  for (const floor of floors) {
    if (!pages.some((page) => page.floor === floor.id)) warnings.push(`floor "${floor.id}" has no pages.`);
  }
  const fileCounts = new Map<string, number>();
  for (const page of pages) fileCounts.set(page.file, (fileCounts.get(page.file) ?? 0) + 1);
  for (const [file, count] of fileCounts) {
    if (count > 1) warnings.push(`file "${file}" is listed ${count} times.`);
  }

  if (problems.length) {
    const shown = problems.slice(0, 8);
    const extra = problems.length > shown.length ? `\n(+${problems.length - shown.length} more)` : '';
    throw new PublicError(shown.join('\n') + extra);
  }

  if (mode !== 'pano' && mode !== 'effect') {
    throw new PublicError('mode must be "pano" or "effect".');
  }

  return {
    bootstrap: {
      project,
      sourcePdf,
      base,
      mode,
      schema,
      storeKey,
      floors,
      sections,
      dupOf,
      pages,
    },
    title,
    subtitle,
    logo,
    filename: `${project}-机位标注.html`,
    warnings: capWarnings(warnings),
    includeScaffold: input.includeScaffold !== false,
  };
}

function renderHtml(prepared: Prepared): string {
  return fillAnnotationTemplate(annotationTemplate(prepared.bootstrap.mode), {
    BOOTSTRAP_JSON: embedBootstrapJson(prepared.bootstrap),
    PAGE_TITLE: escapeHtml(prepared.title),
    LOGO: escapeHtml(prepared.logo),
    PROJECT_NAME: escapeHtml(prepared.bootstrap.project),
    SUBTITLE: escapeHtml(prepared.subtitle),
    PAGE_COUNT: String(prepared.bootstrap.pages.length),
  });
}

function emptyScaffold(boot: Bootstrap): AnnotationScaffold {
  return {
    schema: boot.schema,
    project: boot.project,
    sourcePdf: boot.sourcePdf,
    exportedAt: null,
    note: boot.mode === 'pano' ? PANO_NOTE : EFFECT_NOTE,
    floors: boot.floors.map((floor) => ({
      id: floor.id,
      title: floor.title,
      name: floor.name,
      plan: boot.base + floor.plan,
      w: floor.w,
      h: floor.h,
      cameras: [],
    })),
    pages: boot.pages.map((page) => ({
      no: page.no,
      floor: page.floor,
      room: page.room,
      view: page.view,
      conf: page.conf,
      note: page.note,
      file: boot.base + page.file,
      camera: null,
    })),
  };
}

function normalizeFloors(input: FloorInput[] | undefined, problems: string[]): FloorOut[] {
  if (!Array.isArray(input) || input.length === 0) {
    problems.push('floors is empty. Add at least one floor plan with id, title, plan, w, and h.');
    return [];
  }
  if (input.length > MAX_FLOORS) {
    problems.push(`floors has ${input.length} items; the maximum is ${MAX_FLOORS}.`);
  }
  const floors: FloorOut[] = [];
  const seen = new Set<string>();
  input.forEach((floor, index) => {
    const label = `floor ${index + 1}`;
    const id = cleanText(floor?.id, `${label} id`, 32, problems);
    const title = cleanText(floor?.title, `${label} title`, 80, problems);
    const name = cleanText(floor?.name, `${label} name`, 80, problems) || title;
    const plan = normalizeRelPath(floor?.plan, id ? `floor "${clip(id)}" plan` : `${label} plan`, problems);
    const size = normalizeSize(floor?.w, floor?.h, id ? `floor "${clip(id)}"` : label, problems);
    const short = optionalText(floor?.short, id ? `floor "${clip(id)}" short` : `${label} short`, 8, problems);
    let idOk = false;
    if (!id) problems.push(`${label} is missing id.`);
    else if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(id)) {
      problems.push(`floor id "${clip(id)}" may contain only letters, digits, "_" and "-".`);
    } else if (seen.has(id)) problems.push(`duplicate floor id "${id}".`);
    else {
      seen.add(id);
      idOk = true;
    }
    if (!title) problems.push(`${id ? `floor "${clip(id)}"` : label} is missing title.`);
    if (!plan || !size || !idOk || !title) return;
    const out: FloorOut = { id, title, name, plan, w: size.w, h: size.h };
    if (short) out.short = short;
    floors.push(out);
  });
  return floors;
}

function normalizePages(input: PageInput[] | undefined, floorIds: Set<string>, problems: string[]): PageOut[] {
  if (!Array.isArray(input) || input.length === 0) {
    problems.push('pages is empty. Add at least one image with file and floor.');
    return [];
  }
  if (input.length > MAX_PAGES) {
    problems.push(`pages has ${input.length} items; the maximum is ${MAX_PAGES}.`);
  }
  const specified = input.map((page) => page?.no);
  const anyNo = specified.some((no) => no !== undefined && no !== null);
  const allNo = specified.every((no) => no !== undefined && no !== null);
  if (anyNo && !allNo) {
    problems.push('pass page no on every page, or omit no on every page to number them in order.');
  }
  const pages: PageOut[] = [];
  const seenNo = new Set<number>();
  input.forEach((page, index) => {
    const autoNo = index + 1;
    const no = allNo ? page?.no : autoNo;
    const where = typeof no === 'number' && Number.isInteger(no) ? `page ${no}` : `page ${autoNo}`;
    if (allNo) {
      if (typeof no !== 'number' || !Number.isInteger(no) || no < 1 || no > 100_000) {
        problems.push(`${where} no must be a positive integer.`);
      } else if (seenNo.has(no)) problems.push(`duplicate page no ${no}.`);
      else seenNo.add(no);
    }
    const file = normalizeRelPath(page?.file, `${where} file`, problems);
    const floor = cleanText(page?.floor, `${where} floor`, 32, problems);
    if (!floor) problems.push(`${where} is missing floor.`);
    else if (floorIds.size > 0 && !floorIds.has(floor)) {
      problems.push(`${where} references unknown floor "${clip(floor)}".`);
    }
    const secInput = optionalText(page?.sec, `${where} sec`, 80, problems);
    const sec = secInput || (file ? folderOf(file) : '');
    const room = optionalText(page?.room, `${where} room`, 80, problems);
    const view = optionalText(page?.view, `${where} view`, 200, problems);
    const note = optionalText(page?.note, `${where} note`, 200, problems);
    const confRaw = (page?.conf ?? '').trim();
    const conf = confRaw || 'none';
    if (!CONF.has(conf)) problems.push(`${where} conf must be high, mid, low, dup, or none.`);
    if (!file || typeof no !== 'number') return;
    pages.push({ no, sec, floor, room, view, conf, note, file });
  });
  pages.sort((a, b) => a.no - b.no);
  return pages;
}

function normalizeSections(
  input: Record<string, string> | undefined,
  pages: PageOut[],
  floors: FloorOut[],
  problems: string[],
  warnings: string[],
): Record<string, string> {
  const floorIds = new Set(floors.map((floor) => floor.id));
  if (input) {
    const sections: Record<string, string> = {};
    for (const [sec, floorId] of Object.entries(input)) {
      const key = cleanText(sec, 'sections key', 80, problems);
      const value = cleanText(floorId, `sections["${clip(sec)}"]`, 32, problems);
      if (!key) problems.push('sections contains an empty key.');
      else if (floorIds.size > 0 && !floorIds.has(value)) {
        problems.push(`sections["${clip(key)}"] references unknown floor "${clip(value)}".`);
      } else if (key && value) sections[key] = value;
    }
    return sections;
  }
  const seen = new Map<string, Set<string>>();
  for (const page of pages) {
    if (!page.sec) continue;
    const set = seen.get(page.sec) ?? new Set<string>();
    set.add(page.floor);
    seen.set(page.sec, set);
  }
  const sections: Record<string, string> = {};
  for (const [sec, ids] of seen) {
    if (ids.size === 1) {
      const only = [...ids][0];
      if (only) sections[sec] = only;
    } else {
      warnings.push(`section "${clip(sec)}" is used on more than one floor; each page keeps its own floor.`);
    }
  }
  return sections;
}

function normalizeDupOf(
  input: Record<string, number> | undefined,
  pageNos: Set<number>,
  problems: string[],
): Record<string, number> {
  if (!input) return {};
  const dupOf: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[1-9][0-9]*$/.test(key) || !pageNos.has(Number(key))) {
      problems.push(`dup_of key "${clip(key)}" is not a page number in pages.`);
      continue;
    }
    if (!Number.isInteger(value) || !pageNos.has(value)) {
      problems.push(`dup_of "${key}" references unknown page ${String(value)}.`);
      continue;
    }
    if (Number(key) === value) {
      problems.push(`dup_of "${key}" cannot point at itself.`);
      continue;
    }
    dupOf[key] = value;
  }
  return dupOf;
}

function normalizeSchema(mode: AnnotMode | undefined, input: string | undefined, problems: string[]): string {
  const fallback = mode === 'effect' ? EFFECT_SCHEMA : PANO_SCHEMA;
  if (input === undefined || input.trim() === '') return fallback;
  const schema = input.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(schema)) {
    problems.push('schema must look like camera-annot.pano-annotations/1.');
    return fallback;
  }
  return schema;
}

function normalizeStoreKey(project: string, input: string | undefined, problems: string[]): string {
  if (input === undefined || input.trim() === '') return deriveStoreKey(project);
  const prefix = input.trim().replace(/\.cameras\.v1$/, '');
  if (!/^[\p{L}\p{N}._-]{1,64}$/u.test(prefix)) {
    problems.push('store_key may contain letters, digits, ".", "_" and "-" only (max 64).');
    return deriveStoreKey(project);
  }
  return prefix;
}

function deriveStoreKey(project: string): string {
  const slug = Array.from(project)
    .filter((ch) => /[\p{L}\p{N}._-]/u.test(ch))
    .join('')
    .slice(0, 48);
  return slug ? `camera-annot.${slug}` : 'camera-annot';
}

function normalizeLogo(project: string, input: string | undefined, problems: string[]): string {
  if (input !== undefined && input.trim() !== '') {
    const chars = Array.from(input.trim());
    if (chars.length > 2) problems.push('logo must be at most 2 characters.');
    return chars.slice(0, 2).join('');
  }
  const chars = Array.from(project.trim());
  const first = chars[0] ?? '标';
  if (/[A-Za-z0-9]/.test(first)) {
    const ascii = project.replace(/[^A-Za-z0-9]/g, '');
    return (ascii.slice(0, 2) || first).toUpperCase();
  }
  return first;
}

function normalizeBase(input: string | undefined, problems: string[]): string {
  if (input === undefined) return '../';
  const raw = input.trim();
  if (raw === '' || raw === '.') return '';
  if (isRemoteOrAbsolute(raw) || raw.includes('\\')) {
    problems.push('base must be a relative path such as "../".');
    return '../';
  }
  const segments = raw.split('/').filter((segment) => segment.length > 0);
  if (segments.length > 8 || segments.filter((segment) => segment === '..').length > 4) {
    problems.push('base must be a relative path such as "../".');
    return '../';
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') continue;
    if (!isSafeSegment(segment)) {
      problems.push(`base segment "${clip(segment)}" is not allowed.`);
      return '../';
    }
  }
  return segments.length ? `${segments.join('/')}/` : '';
}

function normalizeRelPath(input: string | undefined, label: string, problems: string[]): string | null {
  const raw = (input ?? '').trim();
  if (!raw) {
    problems.push(`${label} is empty.`);
    return null;
  }
  if (raw.length > 300) {
    problems.push(`${label} is too long.`);
    return null;
  }
  if (isRemoteOrAbsolute(raw)) {
    problems.push(`${label} must be a relative path, not a URL or absolute path.`);
    return null;
  }
  if (raw.includes('\\')) {
    problems.push(`${label} must use "/" separators.`);
    return null;
  }
  if (/[\u0000-\u001f]/.test(raw)) {
    problems.push(`${label} contains a control character.`);
    return null;
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    problems.push(`${label} has an empty path segment.`);
    return null;
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    problems.push(`${label} must not contain "." or ".." segments.`);
    return null;
  }
  if (segments.some((segment) => !isSafeSegment(segment))) {
    problems.push(`${label} contains a character that is not allowed in a file name.`);
    return null;
  }
  return segments.join('/');
}

function normalizeSize(
  w: number | undefined,
  h: number | undefined,
  label: string,
  problems: string[],
): { w: number; h: number } | null {
  if (!isPixel(w) || !isPixel(h)) {
    problems.push(`${label} needs positive integer w and h (the plan's pixel size).`);
    return null;
  }
  return { w, h };
}

function isPixel(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DIM;
}

function isRemoteOrAbsolute(value: string): boolean {
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ||
    value.startsWith('//') ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-zA-Z]:/.test(value)
  );
}

function isSafeSegment(segment: string): boolean {
  return segment.length > 0 && segment.length <= 180 && !/[<>:"|?*#%]/.test(segment) && !/[\u0000-\u001f]/.test(segment);
}

function folderOf(file: string): string {
  const slash = file.indexOf('/');
  return slash === -1 ? '' : file.slice(0, slash);
}

function cleanText(value: string | undefined, label: string, max: number, problems: string[]): string {
  const text = (value ?? '').trim();
  if (text.length > max) problems.push(`${label} must be at most ${max} characters.`);
  if (/[\u0000-\u001f]/.test(text)) problems.push(`${label} contains a control character.`);
  return text;
}

function optionalText(value: string | undefined, label: string, max: number, problems: string[]): string {
  if (value === undefined) return '';
  return cleanText(value, label, max, problems);
}

function defaultTitle(project: string, mode: string | undefined): string {
  if (mode === 'effect') return `${project} · 效果图机位标注`;
  return `${project} · 实景全景点位`;
}

function defaultSubtitle(mode: string | undefined): string {
  return mode === 'effect' ? '效果图 · 机位标注' : '实景全景 · 点位标注';
}

function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_WARNINGS), `${warnings.length - MAX_WARNINGS} more warnings were omitted.`];
}

function clip(value: string): string {
  const flat = value.replace(/[\r\n]/g, ' ');
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}
