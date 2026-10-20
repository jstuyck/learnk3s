// ---------------------------------------------------------------------------
// UI glue: screens, campaign map, terminal, game loop.
// ---------------------------------------------------------------------------
import { runCommand } from '../core/cli';
import { hwPrompt } from '../core/hwshell';
import { burnRate, profit, revenueRate } from '../core/economy';
import { calcStars } from '../core/scoring';
import { newState, step } from '../core/sim';
import type { Campaign, Level, Line, State } from '../core/types';
import { CAMPAIGNS } from '../data/campaigns';
import { VH, VW, draw, podAt } from './render';
import { loadSave, recordWin, writeSave, emptySave } from './save';
import { initShell } from './shell';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

let save = loadSave(safeStorage());
let S: State | null = null;
let gameMode: 'campaign' | 'profit' = 'campaign';
let campaign: Campaign = CAMPAIGNS[0];
let curLevel = 0;
let speed = 1;
let paused = true;
let lastTs = 0;
let outcomeShown = false;
let shownDone = -1;
let selectedId: number | null = null;

const cv = $<HTMLCanvasElement>('cv');
const ctx = cv.getContext('2d')!;
const unlockAll = /[?&]unlock/.test(location.search);

function safeStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
const persist = () => writeSave(safeStorage(), save);

function isUnlocked(c: Campaign, i: number): boolean {
  return unlockAll || i === 0 || !!save.done[c.levels[i - 1].id];
}

// ---- screens --------------------------------------------------------------
function show(id: string): void {
  document.querySelectorAll('.screen').forEach(e => e.classList.toggle('hidden', e.id !== id));
  window.scrollTo(0, 0);
}

function openMode(mode: 'campaign' | 'profit'): void {
  gameMode = mode;
  campaign = CAMPAIGNS.find(c => c.mode === mode) ?? CAMPAIGNS[0];
  showMap();
}

function showMap(): void {
  paused = true;
  closeModal();
  const inMode = CAMPAIGNS.filter(c => c.mode === gameMode);
  if (campaign.mode !== gameMode) campaign = inMode[0];
  $('map-title').textContent = gameMode === 'profit' ? 'Profit Mode' : 'Campaign';
  const tabs = $('camp-tabs');
  tabs.innerHTML = '';
  tabs.style.display = inMode.length > 1 ? '' : 'none';
  for (const c of inMode) {
    const done = c.levels.filter(l => save.done[l.id]).length;
    const b = document.createElement('button');
    b.className = 'tab' + (c === campaign ? ' active' : '');
    b.innerHTML = '<b>' + c.name + '</b><span>' + c.sub + ' &middot; ' + done + '/' + c.levels.length + '</span>';
    b.onclick = () => { campaign = c; showMap(); };
    tabs.appendChild(b);
  }
  const m = $('map');
  m.innerHTML = '';
  const next = campaign.levels.findIndex(l => !save.done[l.id]);
  campaign.levels.forEach((L, i) => {
    const b = document.createElement('button');
    const done = save.done[L.id];
    const open = isUnlocked(campaign, i);
    b.className = 'lvl' + (done ? ' done' : '') + (i === next ? ' next' : '');
    b.disabled = !open;
    const stars = [1, 2, 3].map(n => '<span class="' + (n <= (done || 0) ? '' : 'off') + '">★</span>').join('');
    const best = L.econ && save.best[L.id] !== undefined ? '<div class="dim best">best $' + save.best[L.id].toFixed(2) + '</div>' : '';
    b.innerHTML = '<div class="num">' + (done ? '✓' : open ? i + 1 : '🔒') + '</div>' +
      '<div><h3>' + L.title + ' <span class="chip">' + L.tag + '</span></h3><p>' + L.blurb + '</p></div>' +
      '<div class="stars">' + stars + best + '</div>';
    b.onclick = () => startLevel(i);
    m.appendChild(b);
  });
  const modeLevels = inMode.flatMap(c => c.levels);
  $('map-progress').textContent = modeLevels.filter(l => save.done[l.id]).length + ' / ' + modeLevels.length + ' missions complete';
  show('screen-map');
}

// ---- modal ----------------------------------------------------------------
function openModal(html: string): void {
  $('modal-box').innerHTML = html;
  $('modal').classList.remove('hidden');
  $('modal-box').querySelector('button')?.focus();
}
function closeModal(): void { $('modal').classList.add('hidden'); }

function openCodex(): void {
  const sections = CAMPAIGNS.map(c => '<h3 class="codex-h">' + c.name + '</h3>' + c.levels.map(L => {
    const got = save.codex.includes(L.id);
    return got
      ? '<div class="codex-item"><h4>' + L.codex.title + '</h4><div>' + L.codex.text + '</div></div>'
      : '<div class="codex-item locked"><h4>??? <span class="dim">(' + L.tag + ')</span></h4><div class="dim">Complete this mission to unlock.</div></div>';
  }).join('')).join('');
  openModal('<h2>Codex</h2><div class="sub">What you have learned</div>' + sections +
    '<div class="modal-actions"><button class="btn primary" id="m-close">Close</button></div>');
  $('m-close').onclick = closeModal;
}

function openMission(): void {
  if (!S) return;
  const L = S.level;
  paused = true;
  const econ = L.econ
    ? '<div class="learned"><b>The numbers</b><br>Request earns <b>$' + L.econ.price.toFixed(2) + '</b> &middot; failed request costs <b>$' + L.econ.penalty.toFixed(2) +
      '</b> &middot; pod <b>$' + L.econ.podCost.toFixed(3) + '/s</b> &middot; node <b>$' + L.econ.nodeCost.toFixed(3) + '/s</b>' +
      (L.econ.spotCost ? ' &middot; spot node <b>$' + L.econ.spotCost.toFixed(3) + '/s</b>' : '') +
      '<br>Goal: profit <b>$' + L.econ.target.toFixed(2) + '</b> by <b>' + L.econ.duration + 's</b>. Traffic starts immediately.</div>'
    : '';
  openModal('<div class="sub">' + campaign.name + ' &middot; Mission ' + (curLevel + 1) + ' &middot; ' + L.tag + '</div><h2>' + L.title + '</h2>' + L.story + econ +
    (L.tutorial ? '<div class="learned"><b>How this tutorial works</b><br>The panel on the right walks you through <b>' + L.tutorial.length + ' steps</b>. Each one shows the command and explains what it does and why. Type it (Tab completes file names), or press <i>Run it for me</i>. Read the output, then move on. Take your time: understanding matters more than speed.</div>' : '') +
    '<p><b>Objectives</b></p><ul>' + L.objectives.map(o => '<li>' + o.text + '</li>').join('') + '</ul>' +
    '<div class="modal-actions"><button class="btn primary big" id="m-go">Begin mission</button></div>');
  $('m-go').onclick = () => { closeModal(); paused = false; $('term-input').focus(); };
}

// ---- level lifecycle ------------------------------------------------------
function startLevel(i: number): void {
  curLevel = i;
  const L: Level = campaign.levels[i];
  S = newState(L);
  outcomeShown = false; shownDone = -1; selectedId = null; speed = 1; paused = true;
  $('term-out').innerHTML = '';
  termPrint([{ t: 'Mission ' + (i + 1) + ': ' + L.title + '   (type "help" for commands, Tab to complete)', c: 'dim' }]);
  refreshPrompt();
  $<HTMLInputElement>('term-input').placeholder = L.hardway ? 'ls, ssh, scp, openssl, systemctl ...   (type help)' : 'kubectl ...   (type help)';
  $('g-title').textContent = L.title;
  $('g-tag').textContent = L.tag;
  $('st-max').textContent = L.traffic && !L.econ ? ' / ' + L.traffic.maxFail : '';
  $('g-stats').style.display = L.traffic ? '' : 'none';
  $('money').style.display = L.econ ? '' : 'none';
  $('btn-traffic').style.display = L.traffic && !L.traffic.auto ? '' : 'none';
  $<HTMLButtonElement>('btn-traffic').disabled = false;
  $('cheats').innerHTML = L.cheats.map(c => {
    const [cmd, d] = c.split(' | ');
    return '<li><code>' + cmd + '</code> <span class="dim">' + d + '</span></li>';
  }).join('');
  $('hints').innerHTML = '';
  $<HTMLButtonElement>('btn-hint').disabled = false;
  setSpeedButtons();
  renderObjectives();
  renderTutorial();
  show('screen-game');
  sizeCanvas();
  openMission();
}

/** The Hard Way is a tutorial: show the current step (what to run, and why) instead of hints. */
function renderTutorial(): void {
  const L = S?.level;
  const steps = L?.tutorial;
  $('tut-card').style.display = steps ? '' : 'none';
  $('card-cheats').style.display = steps ? 'none' : '';
  $('card-hints').style.display = steps ? 'none' : '';
  if (!S || !steps) return;
  const i = Math.min(S.tutStep ?? 0, steps.length);
  const done = i >= steps.length;
  $('tut-bar').style.width = Math.round((i / steps.length) * 100) + '%';
  $('tut-h').textContent = done ? 'Tutorial complete' : 'Step ' + (i + 1) + ' of ' + steps.length;
  $('tut-title').textContent = done ? 'You have done every step of this lab' : steps[i].title;
  $('tut-cmd').style.display = done ? 'none' : '';
  $('tut-cmd').textContent = done ? '' : steps[i].cmd;
  document.querySelectorAll<HTMLElement>('.tut-actions .btn').forEach(b => { b.style.display = done ? 'none' : ''; });
  $('tut-why').innerHTML = done ? 'Check the objectives below. Anything still open means a step did not have the effect it should: read the output above, and use <code>ls</code>, <code>cat</code> and <code>systemctl status</code> to look.' : steps[i].why;
}

function renderObjectives(): void {
  if (!S) return;
  const st = S;
  $('objectives').innerHTML = st.level.objectives.map(o =>
    '<li class="' + (st.done[o.id] ? 'done' : '') + '"><span class="box">✓</span><span>' + o.text + '</span></li>').join('');
  shownDone = Object.keys(st.done).length;
}

const starHtml = (n: number): string =>
  '<div class="bigstars">' + [1, 2, 3].map(k => '<span class="' + (k <= n ? '' : 'off') + '">★</span>').join('') + '</div>';

function endLevel(): void {
  if (!S) return;
  outcomeShown = true;
  const L = S.level;
  if (S.outcome === 'win') {
    const st = calcStars(S);
    recordWin(save, L.id, st, L.econ ? profit(S) : undefined);
    persist();
    const last = curLevel === campaign.levels.length - 1;
    const detail = L.econ
      ? 'Profit $' + profit(S).toFixed(2) + ' &middot; ' + S.stats.served + ' served, ' + S.stats.failed + ' failed'
      : L.traffic
        ? S.stats.served + ' served, ' + S.stats.failed + ' failed'
        : S.cmdErrors + ' command error' + (S.cmdErrors === 1 ? '' : 's');
    openModal('<div class="sub">Mission complete</div><h2>' + L.title + '</h2>' + starHtml(st) +
      '<p class="dim" style="text-align:center">' + detail + (S.hintsUsed > 2 ? ' &middot; many hints used' : '') + '</p>' +
      '<div class="learned"><b>Codex unlocked: ' + L.codex.title + '</b><br>' + L.codex.text + '</div>' +
      (last ? '<p><b>You finished the ' + campaign.name + ' campaign!</b> Replay any mission to earn all three stars.</p>' : '') +
      '<div class="modal-actions">' +
      (last ? '' : '<button class="btn primary" id="m-next">Next mission &rarr;</button>') +
      '<button class="btn" id="m-replay">Replay</button><button class="btn" id="m-map">Campaign map</button></div>');
    if (!last) $('m-next').onclick = () => startLevel(curLevel + 1);
    $('m-replay').onclick = () => startLevel(curLevel);
    $('m-map').onclick = showMap;
  } else {
    openModal('<div class="sub">Mission failed</div><h2>' + L.title + '</h2><p>' + S.failReason + '</p>' +
      '<p class="dim">Tip: check <code>kubectl get pods</code>, <code>kubectl get services</code>' + (L.econ ? ' and <code>cloud cost</code>' : '') +
      ' to see what went wrong. Pods take a few seconds to become Ready.</p>' +
      '<div class="modal-actions"><button class="btn primary" id="m-retry">Try again</button><button class="btn" id="m-map">Campaign map</button></div>');
    $('m-retry').onclick = () => startLevel(curLevel);
    $('m-map').onclick = showMap;
  }
}

// ---- terminal -------------------------------------------------------------
function termPrint(lines: Line[]): void {
  const out = $('term-out');
  for (const l of lines) {
    const d = document.createElement('div');
    if (l.c) d.className = l.c;
    d.textContent = l.t;
    out.appendChild(d);
  }
  while (out.childNodes.length > 300 && out.firstChild) out.removeChild(out.firstChild);
  out.scrollTop = out.scrollHeight;
}
const termClear = (): void => { $('term-out').innerHTML = ''; };

const history = initShell({
  input: $<HTMLInputElement>('term-input'),
  prompt: document.querySelector('.prompt') as HTMLElement,
  form: $<HTMLFormElement>('term-form'),
  getState: () => S,
  promptText: () => (S?.hw ? hwPrompt(S) : '$'),
  print: termPrint,
  clear: termClear,
});

function submitCommand(raw: string): void {
  const line = raw.trim();
  if (!line) return;
  history.push(line);
  const shownPrompt = S?.hw ? hwPrompt(S) : '$';
  termPrint([{ t: shownPrompt + ' ' + line, c: 'cmd' }]);
  if (line === 'clear') { termClear(); return; }
  if (!S || S.outcome) return;
  termPrint(runCommand(S, line));
  refreshPrompt();
  renderTutorial();
}
function refreshPrompt(): void {
  (document.querySelector('.prompt') as HTMLElement).textContent = S?.hw ? hwPrompt(S) : '$';
}
$<HTMLFormElement>('term-form').addEventListener('submit', e => {
  e.preventDefault();
  const i = $<HTMLInputElement>('term-input');
  submitCommand(i.value);
  i.value = '';
});

// ---- canvas ---------------------------------------------------------------
function sizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  cv.width = VW * dpr; cv.height = VH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', sizeCanvas);
cv.addEventListener('click', e => {
  if (!S) return;
  const r = cv.getBoundingClientRect();
  const x = (e.clientX - r.left) * VW / r.width, y = (e.clientY - r.top) * VH / r.height;
  const p = podAt(S, x, y);
  selectedId = p ? p.id : null;
  if (p && !S.outcome) submitCommand('kubectl describe pod ' + p.name);
});

// ---- controls -------------------------------------------------------------
function setSpeedButtons(): void {
  document.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.classList.toggle('active', Number(b.dataset.speed) === speed));
}
document.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.addEventListener('click', () => { speed = Number(b.dataset.speed); setSpeedButtons(); }));
$('btn-traffic').addEventListener('click', () => {
  if (!S || S.mode === 'live') return;
  S.mode = 'live';
  termPrint([{ t: 'Traffic is now flowing to the cluster.', c: 'warn' }]);
  $('term-input').focus();
});
$('btn-hint').addEventListener('click', () => {
  if (!S) return;
  const hs = S.level.hints, n = $('hints').children.length;
  if (n >= hs.length) return;
  const li = document.createElement('li'); li.textContent = hs[n]; $('hints').appendChild(li);
  S.hintsUsed++;
  if (n + 1 >= hs.length) $<HTMLButtonElement>('btn-hint').disabled = true;
});
$('btn-brief').addEventListener('click', openMission);
$('tut-run').addEventListener('click', () => {
  const step = S?.level.tutorial?.[S.tutStep ?? 0];
  if (step && S && !S.outcome) { paused = false; submitCommand(step.cmd); }
});
$('tut-type').addEventListener('click', () => {
  const step = S?.level.tutorial?.[S.tutStep ?? 0];
  if (!step) return;
  const input = $<HTMLInputElement>('term-input');
  input.value = step.cmd;
  input.focus();
});
$('tut-skip').addEventListener('click', () => {
  if (!S?.level.tutorial) return;
  S.tutStep = (S.tutStep ?? 0) + 1;
  renderTutorial();
});
$('btn-restart').addEventListener('click', () => startLevel(curLevel));
$('btn-game-map').addEventListener('click', showMap);
$('btn-start').addEventListener('click', () => openMode('campaign'));
$('btn-profit').addEventListener('click', () => openMode('profit'));
$('btn-map-title').addEventListener('click', () => show('screen-title'));
$('btn-codex').addEventListener('click', openCodex);
$('btn-codex-title').addEventListener('click', openCodex);
$('btn-reset').addEventListener('click', () => {
  openModal('<h2>Reset progress?</h2><p>This erases all stars and Codex entries saved in this browser.</p>' +
    '<div class="modal-actions"><button class="btn danger" id="m-yes">Reset</button><button class="btn" id="m-no">Cancel</button></div>');
  $('m-yes').onclick = () => { save = emptySave(); persist(); showMap(); };
  $('m-no').onclick = closeModal;
});

// ---- HUD ------------------------------------------------------------------
const money = (x: number): string => (x < 0 ? '-' : '') + '$' + Math.abs(x).toFixed(2);

function updateHud(st: State): void {
  const E = st.level.econ;
  $('st-served').textContent = String(st.stats.served);
  $('st-failed').textContent = String(st.stats.failed);
  $('st-time').textContent = Math.floor(st.level.traffic ? st.tt : st.t) + (E ? '/' + E.duration : '') + 's';
  if (E) {
    const p = profit(st), net = revenueRate(st) - burnRate(st).total;
    const el = $('st-profit');
    el.textContent = money(p);
    el.className = p >= E.target ? 'ok' : p < 0 ? 'bad' : '';
    $('st-target').textContent = ' / ' + money(E.target);
    const r = $('st-rate');
    r.textContent = (net >= 0 ? '+' : '-') + '$' + Math.abs(net).toFixed(2) + '/s';
    r.className = net >= 0 ? 'ok' : 'bad';
    $('st-burn').textContent = 'burn $' + burnRate(st).total.toFixed(2) + '/s';
  }
  if (st.mode === 'live') $('btn-traffic').style.display = 'none';
}

// ---- main loop ------------------------------------------------------------
function frame(ts: number): void {
  const dt = Math.min(0.1, (ts - lastTs) / 1000 || 0);
  lastTs = ts;
  if (S && !$('screen-game').classList.contains('hidden')) {
    if (!paused && speed > 0 && !S.outcome) for (let i = 0; i < speed; i++) step(S, dt);
    if (S.msgs.length) { termPrint(S.msgs); S.msgs.length = 0; }
    if (Object.keys(S.done).length !== shownDone) renderObjectives();
    updateHud(S);
    draw(ctx, S, selectedId);
    if (S.outcome && !outcomeShown) endLevel();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
