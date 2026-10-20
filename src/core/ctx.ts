// Shared plumbing for the kubectl command implementations.
import type { Deployment, Pod, State } from './types';

export type Kind =
  | 'pod' | 'deployment' | 'service' | 'node' | 'configmap' | 'secret' | 'hpa' | 'endpoints' | 'job' | 'cronjob' | 'all';

export const KIND: Record<string, Kind> = {
  po: 'pod', pod: 'pod', pods: 'pod',
  deploy: 'deployment', deployment: 'deployment', deployments: 'deployment',
  svc: 'service', service: 'service', services: 'service',
  no: 'node', node: 'node', nodes: 'node',
  cm: 'configmap', configmap: 'configmap', configmaps: 'configmap',
  secret: 'secret', secrets: 'secret',
  hpa: 'hpa', horizontalpodautoscaler: 'hpa',
  ep: 'endpoints', endpoints: 'endpoints',
  job: 'job', jobs: 'job',
  cj: 'cronjob', cronjob: 'cronjob', cronjobs: 'cronjob',
  all: 'all',
};

export type FlagValue = string | true;
export interface Parsed { pos: string[]; flags: Record<string, FlagValue>; all: Record<string, FlagValue[]> }

/** Flags that never take a value, so they must not swallow the next word. */
const BOOLEAN_FLAGS = new Set([
  'spot', 'show-labels', 'ignore-daemonsets', 'delete-emptydir-data', 'force', 'help', 'all', 'all-namespaces',
  'overwrite', 'stdin', 'tty', 'previous',
]);
const SHORT: Record<string, string> = { o: 'output', l: 'selector', n: 'namespace', h: 'help', A: 'all-namespaces', p: 'patch', i: 'stdin', t: 'tty' };

export function parseArgs(toks: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, FlagValue> = {};
  const all: Record<string, FlagValue[]> = {};
  const put = (k: string, v: FlagValue) => { flags[k] = v; (all[k] = all[k] || []).push(v); };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('--') && t.length > 2) {
      let k = t.slice(2);
      let v: FlagValue = true;
      const eq = k.indexOf('=');
      if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
      else if (!BOOLEAN_FLAGS.has(k) && toks[i + 1] !== undefined && !toks[i + 1].startsWith('-')) v = toks[++i];
      put(k, v);
    } else if (/^-[a-zA-Z]/.test(t) && !/^-\d/.test(t)) {
      // combined booleans like -it
      if (t.length > 2 && [...t.slice(1)].every(ch => BOOLEAN_FLAGS.has(SHORT[ch] ?? ch))) {
        for (const ch of t.slice(1)) put(SHORT[ch] ?? ch, true);
        continue;
      }
      const k = SHORT[t[1]] ?? t[1];
      if (BOOLEAN_FLAGS.has(k)) put(k, true);
      else if (t.length > 2) put(k, t.slice(2).replace(/^=/, ''));         // -owide, -lapp=web
      else if (toks[i + 1] !== undefined) put(k, toks[++i]);
      else put(k, true);
    } else pos.push(t);
  }
  return { pos, flags, all };
}

/** Shell-style word splitting: single and double quotes group words and are removed. */
export function splitWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) words.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (cur || has) words.push(cur);
  return words;
}

export interface ResRef { kind: Kind | null; name: string | null }

/** "deployment/web" or "deployment web" */
export function resRef(pos: string[]): ResRef | null {
  if (!pos.length) return null;
  const a = pos[0];
  if (a.includes('/')) { const [k, n] = a.split('/'); return { kind: KIND[k] || null, name: n }; }
  return { kind: KIND[a] || null, name: pos[1] || null };
}

export const strFlag = (v: FlagValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export const NONE = 'No resources found in default namespace.';

export interface Out {
  say(t: string, c?: string): void;
  err(t: string): void;
  ok(t: string): void;
  emit(rows: (string | number)[][]): void;
}

/** Everything a command handler needs. */
export interface Ctx extends Out {
  s: State;
  verb: string;
  pos: string[];
  flags: Record<string, FlagValue>;
  all: Record<string, FlagValue[]>;
  /** the words after a standalone "--" (the container command) */
  cmdArgs: string[];
  notFound(kind: string, name: string): void;
  needNum(v: FlagValue | undefined, lo: number, hi: number, name: string): number | null;
  getDep(name: string): Deployment | undefined;
  findPod(name: string): Pod | undefined;
}

/** "a=b,c=d" -> {a:b, c:d}; null when malformed. */
export function parseLabels(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of text.split(',').filter(Boolean)) {
    const m = /^([A-Za-z0-9_./-]+)=([A-Za-z0-9_.-]*)$/.exec(part.trim());
    if (!m) return null;
    out[m[1]] = m[2];
  }
  return out;
}
