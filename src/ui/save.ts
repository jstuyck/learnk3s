// Progress persistence. Storage is injected so it can be tested without a browser.
export interface SaveData {
  /** level id -> best star rating */
  done: Record<string, number>;
  /** level ids whose Codex entry is unlocked */
  codex: string[];
  /** level id -> best profit (economy missions) */
  best: Record<string, number>;
}

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export const SAVE_KEY = 'kubequest.v1';
export const emptySave = (): SaveData => ({ done: {}, codex: [], best: {} });

export function loadSave(store: KeyValueStore | undefined): SaveData {
  try {
    const v = JSON.parse(store?.getItem(SAVE_KEY) ?? 'null') as Partial<SaveData> | null;
    if (v && v.done && v.codex) return { done: v.done, codex: v.codex, best: v.best ?? {} };
  } catch { /* corrupt or unavailable storage: start fresh */ }
  return emptySave();
}

export function writeSave(store: KeyValueStore | undefined, data: SaveData): void {
  try { store?.setItem(SAVE_KEY, JSON.stringify(data)); } catch { /* private mode etc. */ }
}

/** Record a finished mission; keeps the best stars / profit. Mutates and returns `data`. */
export function recordWin(data: SaveData, levelId: string, stars: number, profitMade?: number): SaveData {
  data.done[levelId] = Math.max(data.done[levelId] || 0, stars);
  if (!data.codex.includes(levelId)) data.codex.push(levelId);
  if (profitMade !== undefined) data.best[levelId] = Math.max(data.best[levelId] ?? -Infinity, profitMade);
  return data;
}
