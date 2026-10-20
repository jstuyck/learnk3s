// The Hard Way terminal: a small POSIX-ish shell (variables, $(...), pipes, redirects, for / while-read loops, brace
// expansion, globs) running on the lab machines of hardway.ts, plus the commands the guide uses.
import type { FileEntry, FileMeta, HardWay, Machine } from './hardway';
import {
  ARCHIVES, CERT_SPECS, KNOWN_UNITS, REPO_DIR, apiserverUp, basename, cloneRepo, dirname, isDir, kubeconfigProblem, listDir, mkdirs,
  networkReady, normalize, renderKubeconfig, unitActive, unitProblems, writeFile,
} from './hardway';
import { makeNode } from './sim';
import type { Line, State } from './types';

interface Res { out: string[]; lines: Line[]; code: number }
interface Sh { s: State; hw: HardWay; m: Machine; cwd: string; persist: boolean; depth: number; plain: (s: State, line: string) => Line[] }
interface Tok { w: string; q: boolean; op?: '>' | '>>' | '<' }

const ok = (...out: string[]): Res => ({ out, lines: out.map(t => ({ t })), code: 0 });
const fail = (msg: string, code = 1): Res => ({ out: [], lines: [{ t: msg, c: 'err' }], code });
const join = (...rs: Res[]): Res => ({ out: rs.flatMap(r => r.out), lines: rs.flatMap(r => r.lines), code: rs[rs.length - 1]?.code ?? 0 });

// ---- tokenizer ---------------------------------------------------------------------------------------------------------------------
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return text.length;
}

function expandVars(sh: Sh, text: string, inDouble: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '$') { out += ch; continue; }
    if (text[i + 1] === '(') {
      const end = matchParen(text, i + 1);
      const r = runLine({ ...sh, persist: false, depth: sh.depth + 1 }, text.slice(i + 2, end));
      const val = r.out.join('\n').replace(/\n+$/, '');
      out += inDouble ? val : val.replace(/\n/g, ' ');
      i = end;
    } else if (text[i + 1] === '{') {
      const end = text.indexOf('}', i);
      out += sh.hw.vars[text.slice(i + 2, end < 0 ? undefined : end)] ?? '';
      i = end < 0 ? text.length : end;
    } else {
      const m = /^[A-Za-z_]\w*/.exec(text.slice(i + 1));
      if (m) { out += sh.hw.vars[m[0]] ?? ''; i += m[0].length; } else out += '$';
    }
  }
  return out;
}

function tokenize(sh: Sh, text: string): Tok[] {
  const toks: Tok[] = [];
  let cur = '';
  let has = false;
  let quoted = false;
  const push = () => { if (has) toks.push({ w: cur, q: quoted }); cur = ''; has = false; quoted = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      cur += text.slice(i + 1, end < 0 ? undefined : end); has = quoted = true; i = end < 0 ? text.length : end;
    } else if (ch === '"') {
      let j = i + 1, raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && '"\\$`'.includes(text[j + 1])) { raw += '\u0001' + text[j + 1]; j += 2; continue; }
        if (text[j] === '$' && text[j + 1] === '(') { const e = matchParen(text, j + 1); raw += text.slice(j, e + 1); j = e + 1; continue; }
        raw += text[j++];
      }
      cur += expandVars(sh, raw, true).replace(/\u0001(.)/g, '$1'); has = quoted = true; i = j;
    } else if (/\s/.test(ch)) push();
    else if (ch === '>' || ch === '<') {
      push();
      if (ch === '>' && text[i + 1] === '>') { toks.push({ w: '>>', q: false, op: '>>' }); i++; } else toks.push({ w: ch, q: false, op: ch });
    } else if (ch === '\\' && i + 1 < text.length) { cur += text[++i]; has = true; }
    else if (ch === '$') {
      let j = i + 1, raw = '$';
      if (text[j] === '(') { const e = matchParen(text, j); raw = text.slice(i, e + 1); j = e + 1; }
      else if (text[j] === '{') { const e = text.indexOf('}', j); raw = text.slice(i, e + 1); j = e + 1; }
      else { const m = /^[A-Za-z_]\w*/.exec(text.slice(j)); if (m) { raw = '$' + m[0]; j += m[0].length; } }
      const val = expandVars(sh, raw, false);
      cur += val; has = has || val.length > 0 || raw === '$'; i = j - 1;
    } else if (ch === '~' && !has && (i + 1 === text.length || text[i + 1] === '/' || /\s/.test(text[i + 1]))) { cur += '/root'; has = true; }
    else { cur += ch; has = true; }
  }
  push();
  return toks;
}

/** Split on separators outside quotes and $( ). */
function splitOutside(text: string, seps: string[]): { parts: string[]; ops: string[] } {
  const parts: string[] = [], ops: string[] = [];
  let cur = '', q: string | null = null, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '\\') { cur += ch + (text[++i] ?? ''); continue; }
    if (ch === '$' && text[i + 1] === '(') { depth++; cur += '$('; i++; continue; }
    if (ch === ')' && depth > 0) { depth--; cur += ch; continue; }
    if (!depth) {
      const sep = seps.find(x => text.startsWith(x, i) && !(x === '|' && text[i + 1] === '|'));
      if (sep) { parts.push(cur); ops.push(sep); cur = ''; i += sep.length - 1; continue; }
    }
    cur += ch;
  }
  parts.push(cur);
  return { parts, ops };
}

function braces(w: string): string[] {
  const open = w.indexOf('{');
  if (open < 0) return [w];
  let depth = 0, close = -1;
  for (let i = open; i < w.length; i++) { if (w[i] === '{') depth++; else if (w[i] === '}' && --depth === 0) { close = i; break; } }
  if (close < 0) return [w];
  const inner = w.slice(open + 1, close);
  const alts: string[] = [];
  let d = 0, cur = '';
  for (const ch of inner) { if (ch === '{') d++; if (ch === '}') d--; if (ch === ',' && !d) { alts.push(cur); cur = ''; } else cur += ch; }
  alts.push(cur);
  if (alts.length < 2) return [w];
  return alts.flatMap(a => braces(w.slice(0, open) + a + w.slice(close + 1)));
}

function glob(sh: Sh, w: string): string[] {
  if (!/[*?]/.test(w)) return [w];
  const abs = normalize(w, sh.cwd);
  const re = new RegExp('^' + abs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
  const hits = Object.keys(sh.m.files).filter(f => re.test(f)).sort();
  if (!hits.length) return [w];
  return hits.map(h => (w.startsWith('/') ? h : h.slice(normalize('.', sh.cwd).length === 1 ? 1 : normalize('.', sh.cwd).length + 1)));
}

// ---- files ---------------------------------------------------------------------------------------------------------------------------
const abs = (sh: Sh, p: string): string => normalize(p, sh.cwd);
const readFile = (sh: Sh, p: string): FileEntry | undefined => sh.m.files[abs(sh, p)];

function inferMeta(path: string, text: string, hw: HardWay): FileMeta | undefined {
  if (basename(path) === 'encryption-config.yaml' || text.includes('kind: EncryptionConfiguration')) {
    const m = /secret:\s*(\S*)/.exec(text);
    const val = m?.[1] ?? '';
    let ok = false;
    try { ok = [16, 24, 32].includes(atob(val).length); } catch { ok = false; }
    void hw;
    return { kind: 'encryption', keyOk: ok };
  }
  return undefined;
}

function write(sh: Sh, path: string, lines: string[], append: boolean): void {
  const p = abs(sh, path);
  const prev = append ? sh.m.files[p]?.text ?? '' : '';
  const text = prev + (lines.length ? lines.join('\n') + '\n' : '');
  writeFile(sh.m, p, { text, meta: inferMeta(p, text, sh.hw), exec: sh.m.files[p]?.exec });
}

const clone = (e: FileEntry): FileEntry => ({ text: e.text, exec: e.exec, meta: e.meta ? JSON.parse(JSON.stringify(e.meta)) as FileMeta : undefined });
const BIN_SIZE: Record<string, string> = { kubectl: '54M', 'kube-apiserver': '88M', 'kube-controller-manager': '82M', 'kube-scheduler': '64M', 'kube-proxy': '66M', kubelet: '74M', etcd: '24M', etcdctl: '18M', containerd: '53M', runc: '10M', crictl: '49M' };
const sizeOf = (name: string, e: FileEntry, human: boolean): string => {
  const n = e.meta?.kind === 'bin' ? (BIN_SIZE[name] ?? '10M') : null;
  return n && human ? n : String(n ? parseInt(n) * 1048576 : e.text.length);
};

// ---- commands -----------------------------------------------------------------------------------------------------------------------
type Cmd = (sh: Sh, a: string[], stdin: string[] | null) => Res;

function opt(a: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < a.length; i++) {
    for (const n of names) {
      if (a[i] === n) return a[i + 1];
      if (a[i].startsWith(n + '=')) return a[i].slice(n.length + 1);
    }
  }
  return undefined;
}
const positional = (a: string[], withValue: string[] = []): string[] => {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (withValue.includes(a[i])) { i++; continue; }
    if (a[i].startsWith('-') && a[i].length > 1) continue;
    out.push(a[i]);
  }
  return out;
};

function resolveHost(sh: Sh, host: string): Machine | null {
  const byIp = Object.values(sh.hw.machines).find(m => m.ip === host);
  if (byIp) return byIp;
  const hosts = sh.m.files['/etc/hosts']?.text ?? '';
  for (const line of hosts.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length > 1 && f.slice(1).includes(host)) { const m = Object.values(sh.hw.machines).find(x => x.ip === f[0]); if (m) return m; }
  }
  return null;
}

function hexdump(text: string): string[] {
  const out: string[] = [];
  const b = [...text].map(ch => ch.charCodeAt(0) & 255);
  for (let i = 0; i < b.length; i += 16) {
    const row = b.slice(i, i + 16);
    const hex = row.map(x => x.toString(16).padStart(2, '0'));
    const left = hex.slice(0, 8).join(' ').padEnd(23), right = hex.slice(8).join(' ').padEnd(23);
    out.push(i.toString(16).padStart(8, '0') + '  ' + left + '  ' + right + '  |' + row.map(x => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('') + '|');
  }
  out.push(b.length.toString(16).padStart(8, '0'));
  return out;
}

const sedExpr = (expr: string): { re: RegExp; repl: string } | null => {
  const m = /^s(.)(.*?)(?<!\\)\1(.*?)(?<!\\)\1([gi]*)$/.exec(expr);
  if (!m) return null;
  let re: RegExp;
  try { re = new RegExp(m[2], m[4]); } catch { return null; }
  return { re, repl: m[3].replace(/\\t/g, '\t').replace(/\\n/g, '\n') };
};

const CMDS: Record<string, Cmd> = {
  echo: (_sh, a) => {
    const flags = a.filter((x, i) => i < 2 && /^-[ne]+$/.test(x));
    const text = a.slice(flags.length).join(' ');
    return ok(flags.some(f => f.includes('e')) ? text.replace(/\\n/g, '\n') : text);
  },
  pwd: sh => ok(sh.cwd),
  whoami: () => ok('root'),
  hostname: sh => ok(sh.m.hostname),
  date: () => ok('Sun Oct 19 06:51:42 UTC 2026'),
  uname: (_sh, a) => ok(a.includes('-a') ? 'Linux debian 6.1.0-32-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.129-1 x86_64 GNU/Linux' : a.includes('-r') ? '6.1.0-32-amd64' : [a.includes('-o') ? 'GNU/Linux' : '', a.includes('-m') || !a.length ? 'x86_64' : ''].filter(Boolean).join(' ')),
  dpkg: (_sh, a) => (a.includes('--print-architecture') ? ok('amd64') : fail('dpkg: only --print-architecture is available here')),
  clear: () => ok(),
  true: () => ok(),
  cd: (sh, a) => {
    const p = abs(sh, a[0] ?? '~');
    if (!isDir(sh.m, p)) return fail('bash: cd: ' + (a[0] ?? '') + ': No such file or directory');
    sh.cwd = p;
    if (sh.persist) sh.hw.cwd[sh.m.name] = p;
    return ok();
  },
  cat: (sh, a, stdin) => {
    const files = positional(a);
    if (!files.length) return ok(...(stdin ?? []));
    const rs: Res[] = files.map(f => {
      const e = readFile(sh, f);
      if (e) return ok(...e.text.replace(/\n$/, '').split('\n'));
      return fail('cat: ' + f + (isDir(sh.m, abs(sh, f)) ? ': Is a directory' : ': No such file or directory'));
    });
    return { ...join(...rs), code: rs.some(r => r.code) ? 1 : 0 };
  },
  ls: (sh, a) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const long = flags.includes('l'), human = flags.includes('h');
    const paths = positional(a);
    const targets = paths.length ? paths : ['.'];
    const out: Res[] = [];
    for (const t of targets) {
      const p = abs(sh, t);
      const file = sh.m.files[p];
      if (file) { out.push(ok(long ? '-rw-r--r-- 1 root root ' + sizeOf(basename(p), file, human) + ' Oct 19 06:51 ' + t : t)); continue; }
      if (!isDir(sh.m, p)) { out.push(fail("ls: cannot access '" + t + "': No such file or directory", 2)); continue; }
      const kids = listDir(sh.m, p).filter(k => flags.includes('a') || !k.name.startsWith('.'));
      if (targets.length > 1) out.push(ok(t + ':'));
      if (long) {
        out.push(ok('total ' + kids.length));
        for (const k of kids) {
          const f = sh.m.files[p === '/' ? '/' + k.name : p + '/' + k.name];
          out.push(ok((k.dir ? 'drwxr-xr-x' : f?.exec ? '-rwxr-xr-x' : '-rw-r--r--') + ' 1 root root ' + (f ? sizeOf(k.name, f, human) : '4.0K') + ' Oct 19 06:51 ' + k.name));
        }
      } else if (kids.length) out.push(ok(kids.map(k => k.name).join('  ')));
    }
    return { ...join(...out), code: out.some(r => r.code) ? 2 : 0 };
  },
  mkdir: (sh, a) => {
    const parents = a.includes('-p');
    const rs = positional(a).map(d => {
      const p = abs(sh, d);
      if (isDir(sh.m, p) || sh.m.files[p]) return parents ? ok() : fail("mkdir: cannot create directory '" + d + "': File exists");
      if (!parents && !isDir(sh.m, dirname(p))) return fail("mkdir: cannot create directory '" + d + "': No such file or directory");
      mkdirs(sh.m, p);
      return ok();
    });
    return { ...join(...rs), code: rs.some(r => r.code) ? 1 : 0 };
  },
  touch: (sh, a) => { for (const f of positional(a)) if (!readFile(sh, f)) writeFile(sh.m, abs(sh, f), { text: '' }); return ok(); },
  chmod: (sh, a) => {
    const [mode, ...files] = positional(a);
    const rs = files.map(f => {
      const p = abs(sh, f);
      const e = sh.m.files[p];
      if (e) { if (/x|[1357]/.test(mode)) e.exec = true; return ok(); }
      return isDir(sh.m, p) ? ok() : fail("chmod: cannot access '" + f + "': No such file or directory");
    });
    return { ...join(...rs), code: rs.some(r => r.code) ? 1 : 0 };
  },
  rm: (sh, a) => {
    const recursive = a.some(x => /^-.*r/.test(x)), force = a.some(x => /^-.*f/.test(x));
    for (const f of positional(a)) {
      const p = abs(sh, f);
      if (sh.m.files[p]) delete sh.m.files[p];
      else if (recursive && isDir(sh.m, p)) { for (const k of Object.keys(sh.m.files)) if (k.startsWith(p + '/')) delete sh.m.files[k]; for (const d of Object.keys(sh.m.dirs)) if (d === p || d.startsWith(p + '/')) delete sh.m.dirs[d]; }
      else if (!force) return fail("rm: cannot remove '" + f + "': No such file or directory");
    }
    return ok();
  },
  cp: (sh, a) => copyMove(sh, a, false),
  mv: (sh, a) => copyMove(sh, a, true),
  head: (sh, a, stdin) => {
    const c = opt(a, '-c');
    if (c !== undefined) {
      if (positional(a, ['-c'])[0] === '/dev/urandom') {
        let s = '';
        for (let i = 0; i < Number(c); i++) { let v = 33 + Math.floor(sh.s.rng() * 200); if (v >= 127 && v <= 160) v += 40; s += String.fromCharCode(v); }
        return ok(s);
      }
      return ok((stdin ?? []).join('\n').slice(0, Number(c)));
    }
    const n = Number(opt(a, '-n') ?? (a.find(x => /^-\d+$/.test(x)) ?? '-10').slice(1));
    const file = positional(a, ['-n'])[0];
    const lines = file ? readFile(sh, file)?.text.replace(/\n$/, '').split('\n') : stdin;
    return lines ? ok(...lines.slice(0, n)) : fail('head: cannot open ' + file);
  },
  base64: (_sh, a, stdin) => {
    const text = (stdin ?? []).join('\n');
    if (a.includes('-d') || a.includes('--decode')) { try { return ok(atob(text)); } catch { return fail('base64: invalid input'); } }
    return ok(btoa(text));
  },
  wc: (sh, a, stdin) => {
    const file = positional(a)[0];
    const lines = file ? readFile(sh, file)?.text.replace(/\n$/, '').split('\n') ?? [] : stdin ?? [];
    return ok(a.includes('-l') ? String(lines.length) : lines.length + ' ' + lines.join(' ').split(/\s+/).filter(Boolean).length + ' ' + lines.join('\n').length);
  },
  grep: (sh, a, stdin) => {
    const [pat, ...files] = positional(a);
    if (pat === undefined) return fail('Usage: grep [OPTION]... PATTERNS [FILE]...', 2);
    let re: RegExp;
    try { re = new RegExp(pat, a.includes('-i') ? 'i' : ''); } catch { re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
    const invert = a.includes('-v');
    const src: { name: string; lines: string[] }[] = files.length
      ? files.map(f => ({ name: f, lines: readFile(sh, f)?.text.replace(/\n$/, '').split('\n') ?? [] }))
      : [{ name: '', lines: stdin ?? [] }];
    const hits = src.flatMap(x => x.lines.filter(l => re.test(l) !== invert).map(l => (files.length > 1 ? x.name + ':' : '') + l));
    if (a.includes('-c')) return ok(String(hits.length));
    return { ...ok(...hits), code: hits.length ? 0 : 1 };
  },
  cut: (sh, a, stdin) => {
    let d = opt(a, '-d') ?? '\t';
    const dAttached = a.find(x => /^-d.+/.test(x));
    if (dAttached) d = dAttached.slice(2);
    const fieldSpec = opt(a, '-f') ?? a.find(x => /^-f.+/.test(x))?.slice(2) ?? '1';
    const fields = fieldSpec.split(',').map(Number);
    const file = positional(a, ['-d', '-f'])[0];
    const lines = file ? readFile(sh, file)?.text.replace(/\n$/, '').split('\n') ?? [] : stdin ?? [];
    return ok(...lines.map(l => (l.includes(d) ? fields.map(f => l.split(d)[f - 1] ?? '').join(d) : l)));
  },
  hexdump: (_sh, _a, stdin) => ok(...hexdump((stdin ?? []).join('\n'))),
  envsubst: (sh, _a, stdin) => ok(...(stdin ?? []).map(l => l.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, x: string | undefined, y: string | undefined) => sh.hw.vars[(x ?? y) as string] ?? ''))),
  sed: (sh, a, stdin) => {
    const inPlace = a.includes('-i');
    const [expr, ...files] = positional(a);
    const e = expr ? sedExpr(expr) : null;
    if (!e) return fail("sed: -e expression #1: only s/regex/replacement/[g] is supported here");
    const apply = (l: string) => l.replace(e.re, e.repl);
    if (!files.length) return ok(...(stdin ?? []).map(apply));
    const rs: Res[] = files.map(f => {
      const file = readFile(sh, f);
      if (!file) return fail('sed: can\'t read ' + f + ': No such file or directory');
      const lines = file.text.replace(/\n$/, '').split('\n').map(apply);
      if (inPlace) { file.text = lines.join('\n') + '\n'; return ok(); }
      return ok(...lines);
    });
    return join(...rs);
  },
  export: (sh, a) => { for (const x of a) { const i = x.indexOf('='); if (i > 0) sh.hw.vars[x.slice(0, i)] = x.slice(i + 1); } return ok(); },
  exit: sh => {
    if (!sh.persist || !sh.hw.stack.length) return ok('logout');
    sh.hw.active = sh.hw.stack.pop() as string;
    return ok('logout', 'Connection to ' + sh.m.name + ' closed.');
  },
  help: () => ok(...HW_HELP),
  git: (sh, a) => {
    if (a[0] !== 'clone') return fail('git: only "git clone" is available in this lab');
    if (sh.m.name !== 'jumpbox') return fail('bash: git: command not found');
    const url = positional(a.slice(1)).pop() ?? '';
    if (!url.includes('kubernetes-the-hard-way')) return fail("fatal: repository '" + url + "' not found");
    const dest = normalize('kubernetes-the-hard-way', sh.cwd);
    if (isDir(sh.m, dest)) return fail("fatal: destination path 'kubernetes-the-hard-way' already exists and is not an empty directory.", 128);
    cloneRepo(sh.m);
    sh.hw.cloned = true;
    return ok("Cloning into 'kubernetes-the-hard-way'...", 'remote: Enumerating objects: 238, done.', 'Receiving objects: 100% (238/238), 1.13 MiB | 6.24 MiB/s, done.');
  },
  wget: (sh, a) => {
    const quiet = a.includes('-q');
    const dir = opt(a, '-P') ?? '.';
    const list = opt(a, '-i');
    let urls = positional(a, ['-P', '-i']);
    if (list) {
      const f = readFile(sh, list);
      if (!f) return fail(list + ': No such file or directory');
      urls = f.text.split('\n').filter(Boolean);
    }
    if (!urls.length) return fail('wget: missing URL');
    const out: string[] = [];
    for (const u of urls) {
      const name = basename(u);
      const exec = !(name in ARCHIVES) && !name.endsWith('.tgz');
      const bin = exec;
      writeFile(sh.m, abs(sh, dir + '/' + name), { text: bin ? 'ELF 64-bit LSB executable, x86-64: ' + name : 'gzip compressed data: ' + name, meta: bin ? { kind: 'bin' } : undefined });
      if (!quiet) out.push(name + '   100%[===================>]  ' + (BIN_SIZE[name.replace(/[-_.].*$/, '')] ?? '12M') + '   saved');
    }
    if (quiet && a.includes('--show-progress')) out.push(...urls.map(u => basename(u) + '   100%[===================>]  saved'));
    return ok(...out);
  },
  tar: (sh, a) => {
    const flagWord = a.find(x => /^-[a-zA-Z]+$/.test(x) && x.includes('x')) ?? '';
    if (!flagWord) return fail('tar: this lab supports extraction only (tar -xvf FILE [-C DIR])');
    const verbose = flagWord.includes('v');
    const dir = opt(a, '-C') ?? '.';
    const strip = Number(opt(a, '--strip-components') ?? (a.indexOf('--strip-components') >= 0 ? a[a.indexOf('--strip-components') + 1] : '0')) || 0;
    const skipValue = ['-C', '--strip-components'];
    const rest = positional(a.filter(x => !/^--strip-components=/.test(x) && x !== '--no-same-owner'), skipValue).filter(x => x !== flagWord);
    // -xvf FILE: the first positional after the flags is the archive
    const archive = a.includes('-f') ? a[a.indexOf('-f') + 1] : flagWord.endsWith('f') ? rest[0] : rest[0];
    const wanted = rest.filter(x => x !== archive);
    const members = ARCHIVES[basename(archive ?? '')];
    if (!archive || !readFile(sh, archive)) return fail('tar: ' + (archive ?? '') + ': Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now', 2);
    if (!members) return fail('tar: This does not look like a tar archive', 2);
    const dest = abs(sh, dir);
    if (!isDir(sh.m, dest)) return fail('tar: ' + dir + ': Cannot open: No such file or directory', 2);
    const out: string[] = [];
    for (const mem of members) {
      const clean = mem.replace(/^\.\//, '');
      if (wanted.length && !wanted.some(w => clean === w.replace(/^\.\//, '') || clean.startsWith(w.replace(/\/$/, '') + '/'))) continue;
      const parts = clean.split('/');
      if (parts.length <= strip) continue;
      const target = dest + '/' + parts.slice(strip).join('/');
      const name = basename(target);
      writeFile(sh.m, target, { text: name === 'README.md' ? '# etcd' : 'ELF 64-bit LSB executable, x86-64: ' + name, meta: name === 'README.md' ? undefined : { kind: 'bin' }, exec: true });
      out.push(mem);
    }
    if (wanted.length && !out.length) return fail('tar: ' + wanted[0] + ': Not found in archive\ntar: Exiting with failure status due to previous errors', 2);
    return ok(...(verbose ? out : []));
  },
  'ssh-keygen': sh => {
    if (sh.m.name !== 'jumpbox') return fail('bash: ssh-keygen: command not found');
    writeFile(sh.m, '/root/.ssh/id_rsa', { text: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU...\n-----END OPENSSH PRIVATE KEY-----\n' });
    writeFile(sh.m, '/root/.ssh/id_rsa.pub', { text: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7 root@jumpbox\n' });
    sh.hw.keyGenerated = true;
    return ok('Generating public/private rsa key pair.', 'Your identification has been saved in /root/.ssh/id_rsa', 'Your public key has been saved in /root/.ssh/id_rsa.pub');
  },
  'ssh-copy-id': (sh, a) => {
    if (!sh.hw.keyGenerated) return fail('/usr/bin/ssh-copy-id: ERROR: No identities found (run ssh-keygen first)');
    const t = positional(a, ['-i'])[0]?.replace(/^.*@/, '') ?? '';
    const m = resolveHost(sh, t);
    if (!m || m.name === 'jumpbox') return fail('ssh: Could not resolve hostname ' + t + ': Name or service not known');
    m.hasKey = true;
    return ok('Number of key(s) added: 1', '', "Now try logging into the machine, with: \"ssh 'root@" + t + "'\"");
  },
  ssh: (sh, a) => {
    const rest = a.filter((x, i) => !(x === '-n' || x === '-q' || x === '-t' || x === '-tt' || x === '-o' || (i > 0 && a[i - 1] === '-o')));
    const target = rest[0] ?? '';
    if (!target) return fail('usage: ssh [-n] user@host [command]');
    const host = target.replace(/^.*@/, '');
    const m = resolveHost(sh, host);
    if (!m) return fail('ssh: Could not resolve hostname ' + host + ': Name or service not known', 255);
    if (m.name === sh.m.name) return fail('ssh: already on ' + m.name);
    if (sh.m.name !== 'jumpbox' || !sh.hw.keyGenerated || !m.hasKey) {
      return fail('root@' + m.ip + ': Permission denied (publickey).' + (sh.hw.keyGenerated ? '   (copy your key with ssh-copy-id first)' : '   (create a key with ssh-keygen first)'), 255);
    }
    const cmd = rest.slice(1).join(' ');
    if (!cmd) {
      if (!sh.persist) return fail('error: interactive ssh does not work inside a script; pass a command');
      sh.hw.stack.push(sh.hw.active); sh.hw.active = m.name;
      return ok('Linux ' + m.hostname + ' 6.1.0-32-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.129-1 x86_64', '', 'Last login: Sun Oct 19 06:40:11 2026 from ' + sh.m.ip, '(type "exit" to return to ' + sh.m.name + ')');
    }
    return runLine({ ...sh, m, cwd: sh.hw.cwd[m.name] ?? '/root', persist: false, depth: sh.depth + 1 }, cmd);
  },
  scp: (sh, a) => {
    const args = positional(a, ['-i', '-o']);
    const dst = args.pop() ?? '';
    const srcs = args;
    if (!srcs.length) return fail('usage: scp source ... target');
    const remote = (x: string) => /^[\w.-]+@[^:]+:/.test(x);
    const split = (x: string) => { const i = x.indexOf(':'); return { host: x.slice(0, i).replace(/^.*@/, ''), path: x.slice(i + 1) }; };
    if (sh.m.name !== 'jumpbox' || !sh.hw.keyGenerated) return fail('Permission denied (publickey).', 255);
    const out: string[] = [];
    const copyOne = (from: Machine, fromPath: string, to: Machine, toPath: string, toIsDir: boolean): string | null => {
      const src = from.files[fromPath];
      if (!src) return fromPath + ': No such file or directory';
      const target = toIsDir ? toPath.replace(/\/$/, '') + '/' + basename(fromPath) : toPath;
      writeFile(to, target, clone(src));
      out.push(basename(fromPath).padEnd(30) + '100%   ' + (src.text.length > 1000 ? Math.round(src.text.length / 1024) + 'KB' : src.text.length + 'B') + '  1.0MB/s   00:00');
      return null;
    };
    if (remote(dst)) {
      const { host, path } = split(dst);
      const to = resolveHost(sh, host);
      if (!to || to.name === 'jumpbox') return fail('ssh: Could not resolve hostname ' + host + ': Name or service not known', 255);
      if (!to.hasKey) return fail('root@' + to.ip + ': Permission denied (publickey).', 255);
      const p = path === '' || path === '.' || path === '~' ? '/root/' : normalize(path, '/root') + (path.endsWith('/') ? '/' : '');
      const toIsDir = p.endsWith('/') || srcs.length > 1 || isDir(to, p);
      for (const s of srcs) {
        const e = copyOne(sh.m, abs(sh, s), to, p, toIsDir);
        if (e) return { ...join(ok(...out), fail('scp: ' + s + ': No such file or directory')), code: 1 };
      }
      return ok(...out);
    }
    if (remote(srcs[0])) {
      const { host, path } = split(srcs[0]);
      const from = resolveHost(sh, host);
      if (!from || !from.hasKey) return fail('Permission denied (publickey).', 255);
      const e = copyOne(from, normalize(path, '/root'), sh.m, abs(sh, dst), isDir(sh.m, abs(sh, dst)));
      return e ? fail('scp: ' + e) : ok(...out);
    }
    return fail('scp: one of the paths must look like root@HOST:PATH');
  },
  'apt-get': (sh, a) => {
    if (sh.m.name === 'jumpbox' && a.includes('install')) return ok('E: this lab is not asking you to install packages on the jumpbox');
    if (!a.includes('install')) return ok('Reading package lists... Done');
    const pkgs = a.slice(a.indexOf('install') + 1).filter(x => !x.startsWith('-'));
    for (const p of pkgs) if (!sh.m.packages.includes(p)) sh.m.packages.push(p);
    return ok('Reading package lists... Done', ...pkgs.map(p => 'Setting up ' + p + ' ...'));
  },
  swapon: sh => ok(...(sh.m.swap ? ['NAME      TYPE      SIZE USED PRIO', '/dev/dm-1 partition 975M   0B   -2'] : [])),
  swapoff: sh => { sh.m.swap = false; return ok(); },
  modprobe: (sh, a) => { const mod = (a[0] ?? '').replace(/-/g, '_'); if (!mod) return fail('modprobe: missing module name'); if (!sh.m.modules.includes(mod)) sh.m.modules.push(mod); return ok(); },
  lsmod: sh => ok('Module                  Size  Used by', ...sh.m.modules.map(m => m.padEnd(22) + ' 12288  0')),
  sysctl: (sh, a) => {
    const f = opt(a, '-p');
    if (f === undefined) return fail('sysctl: use -p FILE');
    const file = readFile(sh, f);
    if (!file) return fail('sysctl: cannot open "' + f + '": No such file or directory');
    return ok(...file.text.split('\n').filter(Boolean));
  },
  hostnamectl: (sh, a) => {
    if (a[0] !== 'set-hostname' || !a[1]) return ok('   Static hostname: ' + sh.m.hostname);
    sh.m.hostname = a[1];
    writeFile(sh.m, '/etc/hostname', { text: a[1] + '\n' });
    return ok();
  },
  ip: (sh, a) => {
    if (a[0] !== 'route') return fail('ip: this lab supports "ip route" and "ip route add"');
    const base = ['default via 10.240.0.1 dev eth0', '10.240.0.0/24 dev eth0 proto kernel scope link src ' + sh.m.ip];
    if (a[1] !== 'add') return ok(...base, ...sh.m.routes.map(r => r + ' dev eth0'));
    const [, , dest, via, gw] = a;
    if (!dest || via !== 'via' || !gw) return fail('Usage: ip route add DEST via GATEWAY');
    if (!Object.values(sh.hw.machines).some(m => m.ip === gw)) return fail('Error: Nexthop has invalid gateway.', 2);
    if (sh.m.routes.some(r => r.startsWith(dest + ' '))) return fail('RTNETLINK answers: File exists', 2);
    sh.m.routes.push(dest + ' via ' + gw);
    return ok();
  },
  systemctl: (sh, a) => systemctl(sh, a),
  journalctl: (sh, a) => {
    const name = (opt(a, '-u') ?? '').replace(/\.service$/, '');
    const u = sh.m.units[name];
    if (!u) return ok('-- No entries --');
    return ok(...u.journal.map(l => 'Oct 19 06:52:11 ' + sh.m.hostname + ' ' + name + '[412]: ' + l));
  },
  openssl: (sh, a) => openssl(sh, a),
  curl: (sh, a) => curl(sh, a),
  etcdctl: (sh, a) => {
    if (!sh.m.units.etcd?.active) return fail('{"level":"warn","msg":"retrying of unary invoker failed","error":"rpc error: code = DeadlineExceeded desc = latest balancer error: connection error"}\nError: context deadline exceeded');
    sh.s.flags.usedEtcdctl = true;
    if (a[0] === 'member' && a[1] === 'list') return ok('8e9e05c52164694d, started, controller, http://127.0.0.1:2380, http://127.0.0.1:2379, false');
    if (a[0] === 'endpoint') return ok('127.0.0.1:2379 is healthy: successfully committed proposal: took = 2.1ms');
    if (a[0] === 'get') {
      const key = a[1] ?? '';
      const m = /^\/registry\/secrets\/([\w-]+)\/([\w-]+)$/.exec(key);
      const sec = m && sh.s.secrets.find(x => x.name === m[2]);
      if (!sec) return ok();
      sh.s.flags.checkedEncryption = true;
      const enc = sh.hw.machines.server.files['/var/lib/kubernetes/encryption-config.yaml']?.meta;
      const body = enc?.kind === 'encryption' && enc.keyOk
        ? 'k8s:enc:aescbc:v1:key1:' + btoa(JSON.stringify(sec.data)).replace(/=/g, '') + '\u0003È'
        : 'k8s\u0000\n\u000c\n\u0002v1\u0012\u0006Secret\u0012¢\u0001\n\u0000' + Object.entries(sec.data).map(([k, v]) => k + '\u0012' + String.fromCharCode(v.length) + v).join('');
      return ok(key, body);
    }
    return fail('etcdctl: supported here: member list, endpoint health, get KEY');
  },
  kubectl: (sh, a) => kubectl(sh, a),
};

const HW_HELP = [
  'This terminal is a shell on the lab machines. You start on the jumpbox.',
  '',
  '  ssh root@server            move to a machine (type "exit" to come back)    ssh root@node-0 "cmd; cmd"   run one command there',
  '  scp FILES root@HOST:DIR    copy files to a machine                          ls cat cd mkdir cp mv rm chmod tar wget git',
  '  grep cut head base64 sed envsubst hexdump wc   (pipes, > >> <, $(...), $VAR, for / while read loops work)',
  '  openssl  systemctl  journalctl  apt-get  ip route  modprobe  sysctl  swapoff  etcdctl  curl  kubectl',
  '',
  'Heredocs and interactive editors are not available; the guide\'s ready-made files are in the repository you clone.',
];

function copyMove(sh: Sh, a: string[], move: boolean): Res {
  const verb = move ? 'mv' : 'cp';
  const recursive = a.some(x => /^-.*[rR]/.test(x));
  const args = positional(a);
  if (args.length < 2) return fail(verb + ": missing destination file operand after '" + (args[0] ?? '') + "'");
  const dstRaw = args.pop() as string;
  const dst = abs(sh, dstRaw);
  const dstIsDir = dstRaw.endsWith('/') || isDir(sh.m, dst);
  if (args.length > 1 && !dstIsDir) return fail(verb + ": target '" + dstRaw + "' is not a directory");
  for (const src of args) {
    const p = abs(sh, src);
    const e = sh.m.files[p];
    if (e) {
      const target = dstIsDir ? dst + '/' + basename(p) : dst;
      if (!dstIsDir && !isDir(sh.m, dirname(target))) return fail(verb + ": cannot create regular file '" + dstRaw + "': No such file or directory");
      if (dstIsDir && !isDir(sh.m, dst)) return fail(verb + ": cannot move '" + src + "' to '" + dstRaw + "': No such file or directory");
      writeFile(sh.m, target, clone(e));
      if (move) delete sh.m.files[p];
    } else if (isDir(sh.m, p)) {
      if (!recursive && !move) return fail(verb + ": -r not specified; omitting directory '" + src + "'");
      const base = dstIsDir ? dst + '/' + basename(p) : dst;
      for (const k of Object.keys(sh.m.files)) if (k.startsWith(p + '/')) { writeFile(sh.m, base + k.slice(p.length), clone(sh.m.files[k])); if (move) delete sh.m.files[k]; }
      mkdirs(sh.m, base);
    } else return fail(verb + ": cannot stat '" + src + "': No such file or directory");
  }
  return ok();
}

// ---- systemctl -------------------------------------------------------------------------------------------------------------------------
function systemctl(sh: Sh, a: string[]): Res {
  const m = sh.m;
  const sub = a[0];
  const names = a.slice(1).filter(x => !x.startsWith('-')).map(x => x.replace(/\.service$/, ''));
  const unitFile = (n: string) => m.files['/etc/systemd/system/' + n + '.service'];
  const SYSTEM = ['systemd-hostnamed', 'ssh', 'sshd', 'networking'];
  if (sub === 'daemon-reload') {
    for (const f of Object.keys(m.files)) {
      const mt = /^\/etc\/systemd\/system\/([\w-]+)\.service$/.exec(f);
      if (mt) { m.units[mt[1]] ??= { enabled: false, active: false, loaded: false, journal: [] }; m.units[mt[1]].loaded = true; }
    }
    return ok();
  }
  if (!['enable', 'disable', 'start', 'stop', 'restart', 'status', 'is-active', 'is-enabled'].includes(sub)) return fail('Unknown command verb ' + (sub ?? '') + '.');
  if (!names.length) return fail('Too few arguments.');
  const out: Res[] = [];
  for (const n of names) {
    if (SYSTEM.includes(n)) { out.push(sub === 'is-active' ? ok('active') : ok()); continue; }
    const file = unitFile(n);
    const u = m.units[n];
    if (sub === 'enable' || sub === 'disable') {
      if (!file) { out.push(fail('Failed to ' + sub + ' unit: Unit file ' + n + '.service does not exist.')); continue; }
      m.units[n] ??= { enabled: false, active: false, loaded: false, journal: [] };
      m.units[n].enabled = sub === 'enable';
      out.push(ok(sub === 'enable' ? 'Created symlink /etc/systemd/system/multi-user.target.wants/' + n + '.service → /etc/systemd/system/' + n + '.service.' : 'Removed /etc/systemd/system/multi-user.target.wants/' + n + '.service.'));
      if (a.includes('--now') && sub === 'enable') out.push(startUnit(sh, n));
    } else if (sub === 'start' || sub === 'restart') {
      if (!file || !u?.loaded) { out.push(fail('Failed to ' + sub + ' ' + n + '.service: Unit ' + n + '.service not found.' + (file ? '  (run systemctl daemon-reload after adding a unit file)' : ''))); continue; }
      u.active = false;
      out.push(startUnit(sh, n));
    } else if (sub === 'stop') {
      if (!u) { out.push(fail('Failed to stop ' + n + '.service: Unit ' + n + '.service not loaded.')); continue; }
      u.active = false; out.push(ok());
    } else if (sub === 'is-active') out.push({ ...ok(u?.active ? 'active' : u?.journal.length ? 'failed' : 'inactive'), code: u?.active ? 0 : 3 });
    else if (sub === 'is-enabled') out.push({ ...ok(u?.enabled ? 'enabled' : 'disabled'), code: u?.enabled ? 0 : 1 });
    else {
      if (!file || !u) { out.push({ ...fail('Unit ' + n + '.service could not be found.'), code: 4 }); continue; }
      const desc = /Description=(.*)/.exec(file.text)?.[1] ?? n;
      const failed = !u.active && u.journal.length > 0 && !u.journal[u.journal.length - 1].startsWith('Stopped');
      const lines = [
        (u.active ? '● ' : failed ? '× ' : '○ ') + n + '.service - ' + desc,
        '     Loaded: ' + (u.loaded ? 'loaded' : 'stub') + ' (/etc/systemd/system/' + n + '.service; ' + (u.enabled ? 'enabled' : 'disabled') + '; preset: enabled)',
        '     Active: ' + (u.active ? 'active (running) since Sun 2026-10-19 06:52:11 UTC; 4s ago' : failed ? 'failed (Result: exit-code) since Sun 2026-10-19 06:52:11 UTC' : 'inactive (dead)'),
        ...u.journal.slice(-4).map(l => 'Oct 19 06:52:11 ' + m.hostname + ' ' + n + '[412]: ' + l),
      ];
      out.push({ ...ok(...lines), code: u.active ? 0 : 3 });
    }
  }
  return { ...join(...out), code: out.some(r => r.code) ? out.find(r => r.code)?.code ?? 1 : 0 };
}

function startUnit(sh: Sh, n: string): Res {
  const u = sh.m.units[n];
  if (!KNOWN_UNITS.includes(n)) { u.active = true; return ok(); }
  const problems = unitProblems(sh.hw, sh.m, n);
  if (problems.length) {
    u.active = false;
    u.journal = problems;
    return fail('Job for ' + n + '.service failed because the control process exited with error code.\nSee "systemctl status ' + n + '.service" and "journalctl -xeu ' + n + '.service" for details.');
  }
  u.active = true;
  u.journal = ['Started ' + n + '.service.'];
  return ok();
}

// ---- openssl ------------------------------------------------------------------------------------------------------------------------------
function openssl(sh: Sh, a: string[]): Res {
  const sub = a[0];
  const outPath = opt(a, '-out');
  const need = (p: string | undefined, what: string): FileEntry | string => {
    const e = p ? readFile(sh, p) : undefined;
    return e ?? (p ? p + ': No such file or directory (' + what + ')' : 'missing ' + what);
  };
  if (sub === 'genrsa') {
    if (!outPath) return fail('openssl genrsa: use -out FILE');
    writeFile(sh.m, abs(sh, outPath), { text: '-----BEGIN RSA PRIVATE KEY-----\nMIIJKAIBAAKCAgEA' + btoa(outPath).repeat(3) + '\n-----END RSA PRIVATE KEY-----\n', meta: { kind: 'key' } });
    return ok();
  }
  if (sub === 'req') {
    const key = need(opt(a, '-key'), 'private key'), conf = need(opt(a, '-config'), 'config');
    if (typeof key === 'string') return fail('Could not open file or uri for loading private key from ' + key);
    if (typeof conf === 'string') return fail('Can\'t open ' + conf);
    if (!outPath) return fail('openssl req: use -out FILE');
    if (a.includes('-x509')) {
      writeFile(sh.m, abs(sh, outPath), { text: '-----BEGIN CERTIFICATE-----\nMIIFnzCCA4egAwIBAgIUQ0EgUm9vdA\n-----END CERTIFICATE-----\n', meta: { kind: 'cert', section: 'ca', ca: true, sans: [], cn: 'CA' } });
      return ok();
    }
    const section = opt(a, '-section') ?? '';
    if (!new RegExp('^\\[' + section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]', 'm').test(conf.text) || !section) return fail('Error: can\'t find section "' + section + '" in ' + opt(a, '-config') + '  (try one of the [sections] in ca.conf)');
    writeFile(sh.m, abs(sh, outPath), { text: '-----BEGIN CERTIFICATE REQUEST-----\nMIIEWTCCAkECAQAwOzELMAkGA1UEBhMCVVMx' + btoa(section) + '\n-----END CERTIFICATE REQUEST-----\n', meta: { kind: 'csr', section } });
    return ok();
  }
  if (sub === 'x509') {
    if (a.includes('-req')) {
      const csr = need(opt(a, '-in'), 'certificate request'), ca = need(opt(a, '-CA'), 'CA certificate'), caKey = need(opt(a, '-CAkey'), 'CA key');
      if (typeof csr === 'string') return fail('Can\'t open ' + csr);
      if (typeof ca === 'string') return fail('Could not open file or uri for loading CA certificate from ' + ca);
      if (typeof caKey === 'string') return fail('Could not open file or uri for loading CA private key from ' + caKey);
      if (csr.meta?.kind !== 'csr') return fail('Error: unable to load certificate request (' + opt(a, '-in') + ' is not a CSR)');
      if (!outPath) return fail('openssl x509: use -out FILE');
      const caDir = dirname(abs(sh, opt(a, '-CA') as string));
      if (a.includes('-CAcreateserial')) writeFile(sh.m, caDir + '/ca.srl', { text: '4B5D1E0C\n' });
      else if (!sh.m.files[caDir + '/ca.srl']) return fail('Error: ca.srl: No such file or directory  (add -CAcreateserial the first time you sign)');
      const spec = CERT_SPECS[csr.meta.section];
      const sans = a.includes('-copy_extensions') ? spec.sans : [];
      writeFile(sh.m, abs(sh, outPath), { text: '-----BEGIN CERTIFICATE-----\nMIIFxjCCA66gAwIBAgIUb2s' + btoa(csr.meta.section) + '\n-----END CERTIFICATE-----\n', meta: { kind: 'cert', section: csr.meta.section, ca: false, sans, cn: spec.cn } });
      return ok('Certificate request self-signature ok', 'subject=C = US, ST = Washington, L = Seattle, CN = ' + spec.cn);
    }
    const cert = need(opt(a, '-in'), 'certificate');
    if (typeof cert === 'string') return fail('Could not open file or uri for loading certificate from ' + cert);
    const c = cert.meta;
    if (c?.kind !== 'cert') return fail('Could not read certificate from ' + opt(a, '-in'));
    if (!a.includes('-text')) return ok('subject=CN = ' + c.cn);
    const spec = CERT_SPECS[c.section];
    sh.s.flags.inspectedCert = true;
    return ok(
      'Certificate:', '    Data:', '        Version: 3 (0x2)', '        Signature Algorithm: sha256WithRSAEncryption',
      '        Issuer: C = US, ST = Washington, L = Seattle, CN = CA',
      '        Validity', '            Not Before: Oct 19 06:40:00 2026 GMT', '            Not After : Oct 19 06:40:00 2036 GMT',
      '        Subject: C = US' + (spec?.org ? ', O = ' + spec.org : '') + ', CN = ' + c.cn,
      '        X509v3 extensions:', '            X509v3 Basic Constraints: ', '                CA:' + (c.ca ? 'TRUE' : 'FALSE'),
      ...(c.sans.length ? ['            X509v3 Subject Alternative Name: ', '                ' + c.sans.map(x => (x.startsWith('IP:') ? 'IP Address:' + x.slice(3) : 'DNS:' + x)).join(', ')] : ['            (no Subject Alternative Name: the request extensions were not copied; use -copy_extensions copyall)']),
    );
  }
  return fail('openssl: supported here: genrsa, req, x509');
}

// ---- curl -------------------------------------------------------------------------------------------------------------------------------------
const VERSION_JSON = ['{', '  "major": "1",', '  "minor": "32",', '  "gitVersion": "v1.32.3",', '  "goVersion": "go1.23.6",', '  "platform": "linux/amd64"', '}'];

function curl(sh: Sh, a: string[]): Res {
  const url = positional(a, ['--cacert', '-o', '-H', '-X']).find(x => /^https?:\/\//.test(x));
  if (!url) return fail('curl: no URL specified');
  const m = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
  if (!m) return fail('curl: (3) URL rejected: Bad hostname');
  const [, scheme, host, portRaw] = m;
  const port = Number(portRaw ?? (scheme === 'https' ? 443 : 80));
  const target = host === 'localhost' || host === '127.0.0.1' ? sh.m : resolveHost(sh, host);
  if (!target) return fail('curl: (6) Could not resolve host: ' + host + '   (add it to /etc/hosts, see the compute resources lab)', 6);
  if (port === 6443) {
    if (target.name !== 'server') return fail('curl: (7) Failed to connect to ' + host + ' port 6443: Connection refused', 7);
    if (!apiserverUp(sh.hw)) return fail('curl: (7) Failed to connect to ' + host + ' port 6443 after 3 ms: Couldn\'t connect to server', 7);
    const cacert = opt(a, '--cacert');
    if (scheme === 'https' && !cacert && !a.includes('-k')) return fail('curl: (60) SSL certificate problem: unable to get local issuer certificate\nMore details here: https://curl.se/docs/sslcerts.html', 60);
    if (cacert && !readFile(sh, cacert)) return fail('curl: (77) error setting certificate file: ' + cacert, 77);
    sh.s.flags.curledApi = true;
    return ok(...VERSION_JSON);
  }
  // NodePort of a Service: http://NODE_IP:PORT
  const svc = sh.s.services.find(v => v.nodePort === port);
  if (svc && target.name.startsWith('node')) {
    const node = sh.s.nodes.find(n => n.name === target.name);
    if (!node || s0(sh.s, node.name)) return fail('curl: (7) Failed to connect to ' + host + ' port ' + port + ': Connection refused', 7);
    const pods = sh.s.pods.filter(p => p.phase === 'Running' && Object.entries(svc.selector).every(([k, v]) => p.labels[k] === v));
    if (!pods.length) return fail('curl: (7) Failed to connect to ' + host + ' port ' + port + ': Connection refused   (the Service has no ready endpoints)', 7);
    const pod = pods.find(p => p.node === target.name) ?? pods[0];
    if (pod.node !== target.name) {
      const dest = sh.hw.machines[pod.node ?? ''];
      if (dest?.subnet && !target.routes.some(r => r.startsWith(dest.subnet + ' '))) {
        return fail('curl: (28) Failed to connect to ' + host + ' port ' + port + ' after 130000 ms: Timed out   (the pod runs on ' + pod.node + ' (' + dest.subnet + ') and ' + target.name + ' has no route to that pod network; see the pod network routes lab)', 28);
      }
    }
    sh.s.flags.curledNodePort = true;
    return ok(...(a.includes('-I') ? ['HTTP/1.1 200 OK', 'Server: nginx/1.27.4', 'Content-Type: text/html', 'Content-Length: 615'] : ['<!DOCTYPE html>', '<html>', '<head><title>Welcome to nginx!</title></head>', '<body><h1>Welcome to nginx!</h1></body>', '</html>']));
  }
  return fail('curl: (7) Failed to connect to ' + host + ' port ' + port + ': Connection refused', 7);
}
const s0 = (s: State, node: string): boolean => (s.nodes.find(n => n.name === node)?.bootUntil ?? 0) > s.t;

// ---- kubectl on the lab machines -------------------------------------------------------------------------------------------------------------
const quote = (x: string): string => (/^[\w@%+=:,./{}[\]*-]+$/.test(x) ? x : x.includes("'") ? '"' + x + '"' : "'" + x + "'");

function kcLoad(sh: Sh, path: string): Extract<FileMeta, { kind: 'kubeconfig' }> {
  const meta = sh.m.files[path]?.meta;
  return meta?.kind === 'kubeconfig' ? JSON.parse(JSON.stringify(meta)) as typeof meta : { kind: 'kubeconfig' };
}
function kcSave(sh: Sh, path: string, meta: Extract<FileMeta, { kind: 'kubeconfig' }>): void {
  writeFile(sh.m, path, { text: renderKubeconfig(meta), meta });
}

function configCmd(sh: Sh, a: string[], kubeconfig: string | undefined): Res {
  const path = kubeconfig ? abs(sh, kubeconfig) : '/root/.kube/config';
  const sub = a[0];
  const name = a[1];
  const embed = opt(a, '--embed-certs') === 'true' || a.includes('--embed-certs');
  const meta = kcLoad(sh, path);
  if (sub === 'current-context') return meta.current ? ok(meta.current) : fail('error: current-context is not set');
  if (sub === 'view') return ok(...renderKubeconfig(meta).trimEnd().split('\n'));
  if (!name && sub !== 'view') return fail('error: NAME is required');
  if (sub === 'set-cluster') {
    const ca = opt(a, '--certificate-authority');
    if (ca && !readFile(sh, ca)) return fail('error: could not read certificate-authority file ' + ca + ': open ' + ca + ': no such file or directory');
    meta.cluster = { name, server: opt(a, '--server') ?? 'https://localhost:6443', ca: !!ca };
    kcSave(sh, path, meta);
    return ok('Cluster "' + name + '" set.');
  }
  if (sub === 'set-credentials') {
    const crtPath = opt(a, '--client-certificate'), keyPath = opt(a, '--client-key');
    if (!crtPath || !keyPath) return fail('error: --client-certificate and --client-key are both required');
    const crt = readFile(sh, crtPath), key = readFile(sh, keyPath);
    if (!crt || crt.meta?.kind !== 'cert') return fail('error: could not read client-certificate file ' + crtPath + ': open ' + crtPath + ': no such file or directory');
    if (!key) return fail('error: could not read client-key file ' + keyPath + ': open ' + keyPath + ': no such file or directory');
    meta.user = { name, section: crt.meta.section, embedded: embed, cert: abs(sh, crtPath) };
    kcSave(sh, path, meta);
    return ok('User "' + name + '" set.');
  }
  if (sub === 'set-context') {
    const cluster = opt(a, '--cluster') ?? meta.cluster?.name ?? '', user = opt(a, '--user') ?? meta.user?.name ?? '';
    const existed = meta.context?.name === name;
    meta.context = { name, cluster, user };
    kcSave(sh, path, meta);
    return ok('Context "' + name + '" ' + (existed ? 'modified.' : 'created.'));
  }
  if (sub === 'use-context') {
    if (meta.context?.name !== name) return fail('error: no context exists with the name: "' + name + '"');
    meta.current = name;
    kcSave(sh, path, meta);
    return ok('Switched to context "' + name + '".');
  }
  return fail('error: supported here: kubectl config set-cluster|set-credentials|set-context|use-context|current-context|view');
}

/** Can this machine reach the API server with this kubeconfig? Returns the identity or an error line. */
function connect(sh: Sh, kubeconfig: string | undefined): { user: string } | { error: string } {
  const path = kubeconfig ? abs(sh, kubeconfig) : abs(sh, sh.hw.vars.KUBECONFIG ?? '/root/.kube/config');
  const e = sh.m.files[path];
  if (!e || e.meta?.kind !== 'kubeconfig') {
    return { error: kubeconfig ? 'error: unable to load config: stat ' + kubeconfig + ': no such file or directory' : 'The connection to the server localhost:8080 was refused - did you specify the right host or port?' };
  }
  const prob = kubeconfigProblem(sh.m, path);
  if (prob) return { error: 'error: ' + prob };
  const meta = e.meta;
  const url = /^https:\/\/([^/:]+):(\d+)/.exec(meta.cluster?.server ?? '');
  if (!url) return { error: 'error: invalid server URL in ' + path };
  const [, host, port] = url;
  const target = host === '127.0.0.1' || host === 'localhost' ? sh.m : resolveHost(sh, host);
  if (!target) return { error: 'Unable to connect to the server: dial tcp: lookup ' + host + ': no such host   (add it to /etc/hosts)' };
  if (target.name !== 'server' || port !== '6443' || !apiserverUp(sh.hw)) return { error: 'The connection to the server ' + host + ':' + port + ' was refused - did you specify the right host or port?' };
  const crt = sh.hw.machines.server.files['/var/lib/kubernetes/kube-api-server.crt']?.meta;
  const sans = crt?.kind === 'cert' ? crt.sans : [];
  const want = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 'IP:' + host : host;
  if (!sans.includes(want)) {
    return { error: 'Unable to connect to the server: tls: failed to verify certificate: x509: ' + (sans.length ? 'certificate is valid for ' + sans.map(x => x.replace(/^IP:/, '')).join(', ') + ', not ' + host : 'certificate relies on legacy Common Name field, use SANs instead (the API server certificate has no SANs)') };
  }
  return { user: meta.user?.section ?? '' };
}

function kubectl(sh: Sh, argv: string[]): Res {
  let kubeconfig: string | undefined;
  const a: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--kubeconfig') kubeconfig = argv[++i];
    else if (argv[i].startsWith('--kubeconfig=')) kubeconfig = argv[i].slice(13);
    else a.push(argv[i]);
  }
  const exe = sh.m.files['/usr/local/bin/kubectl'];
  if (!exe) return fail('bash: kubectl: command not found', 127);
  if (!exe.exec) return fail('bash: /usr/local/bin/kubectl: Permission denied   (chmod +x it)', 126);
  const verb = a[0];
  sh.s.flags.ranKubectl = true;
  if (!verb || verb === '--help' || verb === 'help') return { ...ok(), lines: sh.plain(sh.s, 'kubectl --help'), out: [] };
  if (verb === 'config') return configCmd(sh, a.slice(1), kubeconfig);
  if (verb === 'version' && a.includes('--client')) return ok('Client Version: v1.32.3', 'Kustomize Version: v5.5.0');
  const conn = connect(sh, kubeconfig);
  if ('error' in conn) return fail(conn.error);
  if (verb === 'version') return ok('Client Version: v1.32.3', 'Kustomize Version: v5.5.0', 'Server Version: v1.32.3');
  if (verb === 'cluster-info') return ok('Kubernetes control plane is running at https://server.kubernetes.local:6443', '', "To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.");
  if (conn.user !== 'admin') {
    return fail('Error from server (Forbidden): ' + (a[1] ?? 'resources') + ' is forbidden: User "' + (CERT_SPECS[conn.user]?.cn ?? conn.user) + '" cannot ' + (verb === 'get' ? 'list' : verb) + ' resource "' + (a[1] ?? 'resources') + '" at the cluster scope');
  }
  if (verb === 'apply') {
    const f = opt(a, '-f') ?? opt(a, '--filename');
    const file = f ? readFile(sh, f) : undefined;
    if (!f || !file) return fail('error: the path "' + (f ?? '') + '" does not exist');
    if (basename(f) !== 'kube-apiserver-to-kubelet.yaml') return fail('error: this lab only applies kube-apiserver-to-kubelet.yaml');
    sh.hw.rbacApplied = true;
    return ok('clusterrole.rbac.authorization.k8s.io/system:kube-apiserver-to-kubelet created', 'clusterrolebinding.rbac.authorization.k8s.io/system:kube-apiserver created');
  }
  syncCluster(sh.s);
  if (['logs', 'exec', 'port-forward', 'top'].includes(verb) && !sh.hw.rbacApplied) {
    return fail('Error from server (Forbidden): the API server may not talk to the kubelet: nodes/proxy is forbidden for user "kubernetes" (apply kube-apiserver-to-kubelet.yaml, the RBAC for kubelet authorization)');
  }
  if (verb === 'port-forward') {
    const pod = sh.s.pods.find(p => p.name === a[1]?.replace(/^pod\//, ''));
    const node = pod?.node ? sh.hw.machines[pod.node] : undefined;
    if (node && !node.packages.includes('socat')) return fail('error: unable to do port forwarding: socat not found on ' + node.name + '   (apt-get install socat)');
  }
  const lines = sh.plain(sh.s, 'kubectl ' + argv.map(quote).join(' '));
  const failed = lines.some(l => l.c === 'err' && /^(error|Error|usage|Unable)/.test(l.t));
  if (!failed && sh.m.name === 'jumpbox') sh.s.flags.jumpboxKubectl = true;
  if (!failed && verb === 'get' && /^(no|node|nodes)$/.test(a[1] ?? '')) sh.s.flags.listedNodes = true;
  return { out: lines.filter(l => l.c !== 'err').map(l => l.t), lines, code: failed ? 1 : 0 };
}

// ---- keeping the simulated cluster in step with the machines ----------------------------------------------------------------------------------------
/** Worker nodes appear in the cluster when their kubelet runs, and are Ready once containerd and the pod network are set up. */
export function syncCluster(s: State): void {
  const hw = s.hw;
  if (!hw) return;
  for (const name of ['node-0', 'node-1']) {
    const m = hw.machines[name];
    const live = unitActive(hw, name, 'kubelet') && apiserverUp(hw);
    const node = s.nodes.find(n => n.name === m.hostname);
    if (live && !node) { const n = makeNode(m.hostname, 6, false, 0); s.nodes.push(n); s.nodes.sort((x, y) => x.name.localeCompare(y.name)); }
    if (!live && node) { s.nodes = s.nodes.filter(n => n !== node); continue; }
    const n = s.nodes.find(x => x.name === m.hostname);
    if (n) n.bootUntil = networkReady(m) && unitActive(hw, name, 'containerd') ? 0 : Infinity;
  }
}

// ---- the executor ----------------------------------------------------------------------------------------------------------------------------------------
function runSimple(sh: Sh, toks: Tok[], stdin: string[] | null): { res: Res; redirect?: { file: string; append: boolean } } {
  let redirect: { file: string; append: boolean } | undefined;
  let input = stdin;
  const words: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.op) {
      const f = toks[++i]?.w;
      if (!f) return { res: fail('bash: syntax error near unexpected token `newline\'', 2) };
      if (t.op === '<') {
        const e = readFile(sh, f);
        if (!e) return { res: fail('bash: ' + f + ': No such file or directory') };
        input = e.text.replace(/\n$/, '').split('\n');
      } else redirect = { file: f, append: t.op === '>>' };
      continue;
    }
    const expanded = t.q ? [t.w] : braces(t.w).flatMap(w => glob(sh, w));
    words.push(...expanded);
  }
  if (!words.length) return { res: ok() };
  // leading VAR=value assignments
  let k = 0;
  while (k < words.length && /^[A-Za-z_]\w*=/.test(words[k])) { const i = words[k].indexOf('='); sh.hw.vars[words[k].slice(0, i)] = words[k].slice(i + 1); k++; }
  const argv = words.slice(k);
  if (!argv.length) return { res: ok() };
  const [name, ...args] = argv;
  const fn = CMDS[name.includes('/') ? basename(name) : name];
  if (!fn) return { res: fail('bash: ' + name + ': command not found', 127) };
  if (name === 'etcdctl' || name === 'kubectl') {
    const exe = sh.m.files['/usr/local/bin/' + name];
    if (!exe) return { res: fail('bash: ' + name + ': command not found', 127) };
    if (!exe.exec) return { res: fail('bash: /usr/local/bin/' + name + ': Permission denied   (chmod +x it)', 126) };
  }
  return { res: fn(sh, args, input), redirect };
}

function runPipeline(sh: Sh, text: string): Res {
  const { parts } = splitOutside(text, ['|']);
  let stdin: string[] | null = null;
  const errs: Line[] = [];
  let last: Res = ok();
  for (let i = 0; i < parts.length; i++) {
    const toks = tokenize(sh, parts[i].trim());
    const { res, redirect } = runSimple(sh, toks, stdin);
    if (redirect) {
      write(sh, redirect.file, res.out, redirect.append);
      last = { out: [], lines: res.lines.filter(l => l.c === 'err'), code: res.code };
    } else last = res;
    if (i < parts.length - 1) { errs.push(...last.lines.filter(l => l.c === 'err')); stdin = last.out; }
  }
  return { out: last.out, lines: [...errs, ...last.lines], code: last.code };
}

function runBody(sh: Sh, body: string): Res {
  const { parts, ops } = splitOutside(body, [';', '&&']);
  const rs: Res[] = [];
  let code = 0;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].trim()) continue;
    if (i > 0 && ops[i - 1] === '&&' && code !== 0) continue;
    const r = runPipeline(sh, parts[i]);
    rs.push(r); code = r.code;
  }
  return rs.length ? join(...rs) : ok();
}

export function runLine(sh: Sh, raw: string): Res {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return ok();
  if (sh.depth > 8) return fail('bash: too deeply nested');
  let m = /^for\s+(\w+)\s+in\s+(.+?)\s*;\s*do\s+(.+?)\s*;?\s*done\s*$/s.exec(line);
  if (m) {
    const items = tokenize(sh, m[2]).flatMap(t => (t.q ? [t.w] : braces(t.w)));
    const rs: Res[] = [];
    for (const it of items) { sh.hw.vars[m[1]] = it; rs.push(runBody(sh, m[3])); }
    return rs.length ? join(...rs) : ok();
  }
  m = /^while\s+read\s+([\w\s]+?)\s*;\s*do\s+(.+?)\s*;?\s*done\s*<\s*(\S+)\s*$/s.exec(line);
  if (m) {
    const file = readFile(sh, m[3]);
    if (!file) return fail('bash: ' + m[3] + ': No such file or directory');
    const names = m[1].split(/\s+/);
    const rs: Res[] = [];
    for (const l of file.text.split('\n').filter(Boolean)) {
      const f = l.split(/\s+/);
      names.forEach((n, i) => { sh.hw.vars[n] = i === names.length - 1 ? f.slice(i).join(' ') : f[i] ?? ''; });
      rs.push(runBody(sh, m[2]));
    }
    return rs.length ? join(...rs) : ok();
  }
  return runBody(sh, line);
}

export const hwPrompt = (s: State): string => {
  const hw = s.hw;
  if (!hw) return '$';
  const m = hw.machines[hw.active];
  const cwd = hw.cwd[hw.active];
  const shown = cwd === '/root' ? '~' : cwd.startsWith('/root/') ? '~' + cwd.slice(5) : cwd;
  return 'root@' + m.hostname + ':' + shown + '#';
};

/** Run one line typed in a Hard Way mission. `plain` runs the ordinary simulated kubectl. */
export function runHw(s: State, line: string, plain: (s: State, line: string) => Line[]): Line[] {
  const hw = s.hw as HardWay;
  const before = s.cmdErrors;
  const sh: Sh = { s, hw, m: hw.machines[hw.active], cwd: hw.cwd[hw.active], persist: true, depth: 0, plain };
  const res = runLine(sh, line);
  syncCluster(s);
  if (res.code !== 0 && s.cmdErrors === before) s.cmdErrors++;
  return res.lines;
}

/** Run a line silently (used to fast-forward a mission to the state the previous labs leave behind). */
export function runHwSilently(s: State, line: string, plain: (s: State, line: string) => Line[]): void {
  runHw(s, line, plain);
  s.cmdErrors = 0;
}

export { REPO_DIR };

