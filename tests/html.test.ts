// Every element the UI code looks up by id must exist in public/index.html.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync('public/index.html', 'utf8');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

function referencedIds(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  // $('id'), $<Type>('id') and document.getElementById('id'); modal ids (m-*) are created at runtime
  return [...src.matchAll(/(?:\$(?:<[^>]+>)?|getElementById)\('([a-z][\w-]*)'\)/g)].map(m => m[1]).filter(id => !id.startsWith('m-'));
}

describe('public/index.html', () => {
  it.each(['src/ui/main.ts', 'src/ui/shell.ts'])('provides every id used by %s', file => {
    const missing = referencedIds(file).filter(id => !ids.has(id));
    expect(missing).toEqual([]);
  });

  it('loads the bundled script and stylesheet', () => {
    expect(html).toMatch(/<script src="game\.js">/);
    expect(html).toMatch(/<link rel="stylesheet" href="style\.css">/);
  });

  it('has no duplicate ids', () => {
    const all = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    expect(all.length).toBe(new Set(all).size);
  });
});
