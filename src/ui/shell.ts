// Shell niceties for the terminal input: Tab completion, history, Ctrl+R search, Ctrl+L/C/U.
import { commonPrefix, completeLine } from '../core/completion';
import type { Line, State } from '../core/types';
import { CommandHistory } from './history';

const HIST_KEY = 'kubequest.history';

export interface ShellOptions {
  input: HTMLInputElement;
  prompt: HTMLElement;
  form: HTMLFormElement;
  getState(): State | null;
  /** the prompt text (the Hard Way shows root@host:dir#) */
  promptText(): string;
  print(lines: Line[]): void;
  clear(): void;
}

function loadEntries(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HIST_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function initShell(o: ShellOptions): CommandHistory {
  const hist = new CommandHistory(loadEntries());
  const { input, prompt } = o;
  let tabCount = 0;
  let rs: { query: string; idx: number; failed: boolean; saved: string } | null = null;

  const save = () => { try { localStorage.setItem(HIST_KEY, JSON.stringify(hist.entries)); } catch { /* ignore */ } };
  const emptyState = { pods: [], deployments: [], services: [], configmaps: [], secrets: [], hpas: [], nodes: [] } as unknown as State;

  const doTab = () => {
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos), after = input.value.slice(pos);
    const { start, options } = completeLine(o.getState() ?? emptyState, before);
    if (!options.length) return;
    const cur = before.slice(start), cp = commonPrefix(options);
    const setAt = (text: string, tail: string) => {
      input.value = before.slice(0, start) + text + tail + after;
      const c = start + text.length + tail.length;
      input.setSelectionRange(c, c);
    };
    if (options.length === 1) {
      setAt(options[0], /[=/]$/.test(options[0]) ? '' : ' '); tabCount = 0;
    } else if (cp.length > cur.length) {
      setAt(cp, ''); tabCount = 0;
    } else if (++tabCount >= 2) {
      o.print([{ t: '$ ' + before, c: 'cmd' }, { t: options.join('   '), c: 'dim' }]); tabCount = 0;
    }
  };

  const rsRender = () => {
    if (!rs) return;
    prompt.textContent = (rs.failed ? '(failed reverse-i-search)`' : '(reverse-i-search)`') + rs.query + "':";
    input.value = rs.idx >= 0 ? hist.entries[rs.idx] : '';
  };
  const rsSearch = (from: number) => {
    if (!rs) return;
    const i = hist.search(rs.query, from);
    if (i >= 0) { rs.idx = i; rs.failed = false; } else rs.failed = true;
    rsRender();
  };
  const rsEnd = (accept: boolean) => {
    if (!rs) return;
    input.value = accept && rs.idx >= 0 ? hist.entries[rs.idx] : rs.saved;
    rs = null; prompt.textContent = o.promptText();
  };

  input.addEventListener('keydown', e => {
    const k = e.key;
    if (rs) {
      if (k === 'Enter') { e.preventDefault(); rsEnd(true); o.form.requestSubmit(); }
      else if (k === 'Escape' || (e.ctrlKey && (k === 'g' || k === 'c'))) { e.preventDefault(); rsEnd(false); }
      else if (e.ctrlKey && k === 'r') { e.preventDefault(); rsSearch((rs.idx < 0 ? hist.entries.length : rs.idx) - 1); }
      else if (k === 'Backspace') { e.preventDefault(); rs.query = rs.query.slice(0, -1); rsSearch(hist.entries.length - 1); }
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); rs.query += k;
        rsSearch(rs.idx >= 0 && hist.entries[rs.idx].includes(rs.query) ? rs.idx : hist.entries.length - 1);
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(k)) { e.preventDefault(); rsEnd(true); }
      return;
    }
    if (k !== 'Tab') tabCount = 0;
    if (k === 'Tab') { e.preventDefault(); doTab(); }
    else if (e.ctrlKey && k === 'r') { e.preventDefault(); rs = { query: '', idx: -1, failed: false, saved: input.value }; rsRender(); }
    else if (e.ctrlKey && k === 'l') { e.preventDefault(); o.clear(); }
    else if (e.ctrlKey && k === 'c' && input.selectionStart === input.selectionEnd) {
      e.preventDefault(); o.print([{ t: '$ ' + input.value + '^C', c: 'cmd' }]); input.value = ''; hist.resetCursor();
    } else if (e.ctrlKey && k === 'u') {
      e.preventDefault(); input.value = input.value.slice(input.selectionStart ?? 0); input.setSelectionRange(0, 0);
    } else if (k === 'ArrowUp') { e.preventDefault(); input.value = hist.prev(input.value); }
    else if (k === 'ArrowDown') { e.preventDefault(); input.value = hist.next(input.value); }
  });

  // persist after every submitted command (main.ts pushes into `hist`)
  o.form.addEventListener('submit', () => { queueMicrotask(save); });
  return hist;
}
