import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type AnnotMode = 'pano' | 'effect';

/**
 * The two HTML files are the production annotators (point-only panorama and
 * effect images with bearing / FOV) with project data replaced by slots.
 * `npm run build` copies them next to the compiled pack so `node dist` can
 * read them the same way tsx reads `src/`.
 */
const SLOTS = ['BOOTSTRAP_JSON', 'PAGE_TITLE', 'LOGO', 'PROJECT_NAME', 'SUBTITLE', 'PAGE_COUNT'] as const;

export type TemplateSlot = (typeof SLOTS)[number];

const cache = new Map<AnnotMode, string>();

export function annotationTemplate(mode: AnnotMode): string {
  const hit = cache.get(mode);
  if (hit) return hit;
  const name = mode === 'pano' ? 'template-pano.html' : 'template-effect.html';
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), 'utf8');
  cache.set(mode, text);
  return text;
}

export function fillAnnotationTemplate(template: string, slots: Record<TemplateSlot, string>): string {
  const seen = new Set<string>();
  const filled = template.replace(/__([A-Z0-9_]+)__/g, (token, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(slots, key)) {
      throw new Error(`Unknown camera-annot template slot ${token}.`);
    }
    seen.add(key);
    return slots[key as TemplateSlot];
  });
  for (const slot of SLOTS) {
    if (!seen.has(slot)) throw new Error(`Camera-annot template is missing __${slot}__.`);
  }
  return filled;
}

/** JSON for a `<script type="application/json">` block. `<` cannot close the tag. */
export function embedBootstrapJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
