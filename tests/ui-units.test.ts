// Pure UI-support modules: history, persistence, scoring.
import { describe, expect, it } from 'vitest';
import { calcStars } from '../src/core/scoring';
import { CommandHistory } from '../src/ui/history';
import { SAVE_KEY, emptySave, loadSave, recordWin, writeSave } from '../src/ui/save';
import type { KeyValueStore } from '../src/ui/save';
import { sim, start } from './helpers';

describe('CommandHistory', () => {
  it('walks back and forward and restores the unsent draft', () => {
    const h = new CommandHistory(['a', 'b', 'c']);
    expect(h.prev('draft')).toBe('c');
    expect(h.prev('ignored')).toBe('b');
    expect(h.prev('')).toBe('a');
    expect(h.prev('')).toBe('a'); // clamps at the oldest
    expect(h.next('')).toBe('b');
    expect(h.next('')).toBe('c');
    expect(h.next('')).toBe('draft');
    expect(h.next('x')).toBe('x'); // nothing newer
  });

  it('does not store consecutive duplicates and caps its size', () => {
    const h = new CommandHistory([], 3);
    ['a', 'a', 'b', 'c', 'd'].forEach(x => h.push(x));
    expect(h.entries).toEqual(['b', 'c', 'd']);
  });

  it('returns the current line when empty', () => {
    expect(new CommandHistory().prev('typed')).toBe('typed');
  });

  it('reverse search finds the newest match and can continue to older ones', () => {
    const h = new CommandHistory(['kubectl get pods', 'kubectl scale deployment web --replicas=3', 'kubectl get nodes', 'kubectl get services']);
    const first = h.search('get');
    expect(h.entries[first]).toBe('kubectl get services');
    const second = h.search('get', first - 1);
    expect(h.entries[second]).toBe('kubectl get nodes');
    expect(h.entries[h.search('scale')]).toMatch(/replicas=3/);
    expect(h.search('zzz')).toBe(-1);
    expect(h.search('get', -1)).toBe(-1);
  });

  it('pushing resets the browsing cursor', () => {
    const h = new CommandHistory(['a', 'b']);
    h.prev('');
    h.push('c');
    expect(h.prev('')).toBe('c');
  });
});

function memoryStore(initial?: string): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SAVE_KEY, initial);
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

describe('save data', () => {
  it('round-trips through storage', () => {
    const store = memoryStore();
    const save = recordWin(emptySave(), 'pods', 3);
    writeSave(store, save);
    expect(loadSave(store)).toEqual(save);
  });

  it('starts fresh for missing, corrupt, malformed or unavailable storage', () => {
    expect(loadSave(memoryStore())).toEqual(emptySave());
    expect(loadSave(memoryStore('{not json'))).toEqual(emptySave());
    expect(loadSave(memoryStore('{"hello":1}'))).toEqual(emptySave());
    expect(loadSave(undefined)).toEqual(emptySave());
  });

  it('upgrades saves from before economy missions (no "best")', () => {
    const old = memoryStore(JSON.stringify({ done: { pods: 2 }, codex: ['pods'] }));
    expect(loadSave(old)).toEqual({ done: { pods: 2 }, codex: ['pods'], best: {} });
  });

  it('keeps the best stars / profit and adds the Codex entry once', () => {
    const save = emptySave();
    recordWin(save, 'm-cost', 2, 3.2);
    recordWin(save, 'm-cost', 1, 1.9);
    recordWin(save, 'm-cost', 3, 4.4);
    expect(save.done['m-cost']).toBe(3);
    expect(save.best['m-cost']).toBe(4.4);
    expect(save.codex).toEqual(['m-cost']);
    recordWin(save, 'pods', 1);
    expect(save.best.pods).toBeUndefined();
  });

  it('writeSave swallows storage errors (private mode)', () => {
    const broken: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(() => writeSave(broken, emptySave())).not.toThrow();
    expect(() => writeSave(undefined, emptySave())).not.toThrow();
  });
});

describe('calcStars', () => {
  it('rewards few command errors in tutorial missions', () => {
    const s = start('pods');
    expect(calcStars(s)).toBe(3);
    s.cmdErrors = 3;
    expect(calcStars(s)).toBe(2);
    s.cmdErrors = 9;
    expect(calcStars(s)).toBe(1);
  });

  it('uses failed requests in traffic missions', () => {
    const s = start('services'); // stars [1, 4]
    s.stats.failed = 1;
    expect(calcStars(s)).toBe(3);
    s.stats.failed = 4;
    expect(calcStars(s)).toBe(2);
    s.stats.failed = 5;
    expect(calcStars(s)).toBe(1);
  });

  it('uses profit thresholds in economy missions', () => {
    const s = start('m-cost'); // stars [2.6, 3.4]
    sim(s, 1);
    s.money.rev = 10;
    s.money.cost = 6; // profit 4
    expect(calcStars(s)).toBe(3);
    s.money.cost = 7.2; // 2.8
    expect(calcStars(s)).toBe(2);
    s.money.cost = 9; // 1
    expect(calcStars(s)).toBe(1);
  });

  it('caps at 2 stars after more than two hints', () => {
    const s = start('pods');
    s.hintsUsed = 2;
    expect(calcStars(s)).toBe(3);
    s.hintsUsed = 3;
    expect(calcStars(s)).toBe(2);
  });
});
