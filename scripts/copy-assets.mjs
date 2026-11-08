import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src/packs/camera-annot');
const dest = join(root, 'dist/packs/camera-annot');
mkdirSync(dest, { recursive: true });
for (const name of readdirSync(src)) {
  if (name.endsWith('.html')) cpSync(join(src, name), join(dest, name));
}

// Prompt Markdown is read from next to the compiled module. tsc does not copy it.
const promptsSrc = join(root, 'src/packs/design-prompts/prompts');
const promptsDest = join(root, 'dist/packs/design-prompts/prompts');
rmSync(promptsDest, { recursive: true, force: true });
cpSync(promptsSrc, promptsDest, { recursive: true });
