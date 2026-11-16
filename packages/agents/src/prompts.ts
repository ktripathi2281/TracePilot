// Prompts live in versioned files under packages/agents/prompts/ (brief §12), each starting with
// an HTML comment that explains why it is written the way it is. The comment is for maintainers
// and is stripped before the prompt is sent.

import { readFileSync } from 'node:fs';

export type PromptName = 'investigator' | 'skeptic' | 'verifier';

const cache = new Map<PromptName, string>();

export function loadPrompt(name: PromptName): string {
  let text = cache.get(name);
  if (text === undefined) {
    const raw = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
    text = raw.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
    if (text.length === 0) throw new Error(`prompt ${name} is empty`);
    cache.set(name, text);
  }
  return text;
}
