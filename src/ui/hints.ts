// Hints are plain sentences with commands inside. This finds the commands so the UI can show them in a code font
// and let the player click them into the terminal.

export interface Segment { text: string; cmd: boolean }

const STARTS = [
  'kubectl', 'cloud', 'ssh', 'scp', 'ssh-keygen', 'ssh-copy-id', 'openssl', 'systemctl', 'journalctl', 'etcdctl', 'curl', 'wget', 'tar', 'git',
  'apt-get', 'mv', 'cp', 'cat', 'ls', 'echo', 'export', 'envsubst', 'sed', 'while', 'for', 'head', 'grep', 'ip', 'swapoff', 'modprobe', 'sysctl',
  'mkdir', 'chmod', 'cd', 'exit', 'hostnamectl', 'POD_NAME', 'NODE_PORT', 'NODE_NAME', 'NODE_0_IP', 'NODE_1_IP', 'NODE_0_SUBNET', 'NODE_1_SUBNET', 'SUBNET', 'ARCH',
];
const START = new RegExp('(?:^|(?<=[\\s(:]))(?:' + STARTS.join('|') + ')(?=[\\s=]|$)', 'g');

const STOP = new Set(['to', 'shows', 'show', 'and', 'vs', 'too', 'tells', 'beats', 'removes', 'filters', 'lists', 'should', 'covers', 'ends', 'is', 'are', 'says', 'works',
  'fails', 'prints', 'waits', 'resolves', 'reads', 'finds', 'the', 'a', 'an', 'of', 'that', 'which', 'it', 'one', 'you', 'your', 'on', 'then', 'or', 'afterwards', 'below', 'above',
  'here', 'there', 'explain', 'explains', 'give', 'gives', 'when', 'if', 'so', 'from', 'fixes']);

/** Splits on whitespace outside quotes and $( ), keeping the end offset of every token. */
function tokens(text: string, from: number): { raw: string; start: number; end: number }[] {
  const out: { raw: string; start: number; end: number }[] = [];
  let i = from;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    let quote: string | null = null;
    let depth = 0;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === '$' && text[i + 1] === '(') { depth++; i++; continue; }
      if (ch === ')' && depth > 0) { depth--; continue; }
      if (!depth && /\s/.test(ch)) break;
    }
    out.push({ raw: text.slice(start, i), start, end: i });
  }
  return out;
}

/** Where the command that starts at `from` ends: at the first word that is clearly prose. */
function commandEnd(text: string, from: number): number {
  let end = from;
  const toks = tokens(text, from);
  for (let k = 0; k < toks.length; k++) {
    const { raw, start } = toks[k];
    const bare = raw.replace(/[.,:]+$/, '');
    const word = bare.replace(/\)+$/, '');
    const afterFlag = k > 0 && /^--?[\w-]+$/.test(toks[k - 1].raw);   // a value such as NodePort after --type
    if (k > 0 && (STOP.has(word) || STOP.has(word.toLowerCase()) || (/^[A-Z][a-z]/.test(word) && !afterFlag) || (raw.startsWith('(') && !raw.startsWith('$(')))) break;
    // unbalanced closing parenthesis ends the command before it
    const open = (bare.match(/\(/g) ?? []).length, close = (bare.match(/\)/g) ?? []).length;
    if (close > open) { end = start + bare.length - (close - open); break; }
    end = start + bare.length;
    if (raw.length > bare.length) break;                    // trailing , : ; or . ends the command
  }
  return end;
}

export function splitHint(text: string): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  START.lastIndex = 0;
  for (;;) {
    START.lastIndex = pos;
    const m = START.exec(text);
    if (!m) break;
    const end = commandEnd(text, m.index);
    const cmd = text.slice(m.index, end).trimEnd();
    // a lone word such as "for" or "cat" in a sentence is not a command: require an argument or kubectl-style words
    const looksLikeCommand = /\s/.test(cmd) || ['ls', 'exit'].includes(cmd);
    const loopOk = !/^(for|while)\b/.test(cmd) || /\bdo\b/.test(cmd);
    if (!looksLikeCommand || !loopOk || /^(ip|cat|head|cd|ls|mv|cp)\s+(the|a|an|each|every|your|you|is|are|it)\b/i.test(cmd)) { pos = m.index + m[0].length; continue; }
    if (m.index > out.reduce((a, s) => a + s.text.length, 0)) out.push({ text: text.slice(out.reduce((a, s) => a + s.text.length, 0), m.index), cmd: false });
    out.push({ text: cmd, cmd: true });
    pos = m.index + cmd.length;
  }
  const used = out.reduce((a, s) => a + s.text.length, 0);
  if (used < text.length) out.push({ text: text.slice(used), cmd: false });
  return out;
}

export const escapeHtml = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML for a hint: commands in a clickable code span carrying the command in data-cmd. */
export function renderHint(text: string): string {
  return splitHint(text).map(s => (s.cmd
    ? '<span class="hcmd" role="button" tabindex="0" title="Click to put this command in the terminal" data-cmd="' + escapeHtml(s.text) + '">' + escapeHtml(s.text) + '</span>'
    : escapeHtml(s.text))).join('');
}
