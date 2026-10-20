// ---------------------------------------------------------------------------
// Canvas renderer. Logical size 960x500; the canvas is scaled by CSS.
// ---------------------------------------------------------------------------
import { CREATE_TIME, T_POD, T_SVC, endpoints, readyCount, trafficRate, usedSlots } from '../core/sim';
import { apiserverUp, unitActive } from '../core/hardway';
import type { Machine } from '../core/hardway';
import type { ClusterNode, Pod, Request, Service, State } from '../core/types';

export const VW = 960;
export const VH = 500;
const USERS = { x: 60, y: VH / 2 };
const SVC_X = 200;
const SVC_W = 130;
const SVC_H = 60;
const NODE_X = 372;
const NODE_TOP = 58;

const PHASE_COLORS: Record<string, string> = {
  Running: '#3ddc84', ContainerCreating: '#f5c542', Pending: '#f5c542',
  CrashLoopBackOff: '#ff5c5c', ImagePullBackOff: '#ff9f43',
  Terminating: '#7d8aa8', Unknown: '#b48cff',
};

interface Rect { x: number; y: number; w: number; h: number }
interface Pt { x: number; y: number }

function nodeRect(s: State, i: number): Rect {
  const n = s.nodes.length, gap = 10, bottom = VH - 10;
  const h = (bottom - NODE_TOP - gap * (n - 1)) / n;
  return { x: NODE_X, y: NODE_TOP + i * (h + gap), w: VW - NODE_X - 12, h };
}
function podRect(s: State, p: Pod): Rect | null {
  if (!p.node) return null;
  const i = s.nodes.findIndex(n => n.name === p.node);
  if (i < 0) return null;
  const nr = nodeRect(s, i), slots = s.nodes[i].slots;
  const sw = (nr.w - 16 - (slots - 1) * 8) / slots;
  const sh = Math.min(nr.h - 34, 84);
  return { x: nr.x + 8 + p.slot * (sw + 8), y: nr.y + 28 + (nr.h - 34 - sh) / 2, w: sw, h: sh };
}
function svcRect(s: State, v: Service): Rect {
  const i = s.services.indexOf(v), n = s.services.length;
  const step = SVC_H + 18;
  const y0 = VH / 2 - (n * step - 18) / 2;
  return { x: SVC_X, y: y0 + i * step, w: SVC_W, h: SVC_H };
}
const mid = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

type Ctx = CanvasRenderingContext2D;

function rr(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
interface TxtOpts { bold?: boolean; size?: number; mono?: boolean; color?: string; align?: CanvasTextAlign }
function txt(c: Ctx, t: string, x: number, y: number, o: TxtOpts = {}): void {
  c.font = (o.bold ? 'bold ' : '') + (o.size || 12) + 'px ' + (o.mono ? 'Consolas, ui-monospace, monospace' : 'system-ui, sans-serif');
  c.fillStyle = o.color || '#e6ecff';
  c.textAlign = o.align || 'left';
  c.textBaseline = 'alphabetic';
  c.fillText(t, x, y);
}
const clip = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1) + '…' : t);

export function draw(c: Ctx, s: State, selectedId: number | null): void {
  c.clearRect(0, 0, VW, VH);
  c.fillStyle = '#0b1226'; c.fillRect(0, 0, VW, VH);
  c.strokeStyle = 'rgba(80,110,190,.07)'; c.lineWidth = 1;
  for (let x = 0; x < VW; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, VH); c.stroke(); }
  for (let y = 0; y < VH; y += 32) { c.beginPath(); c.moveTo(0, y); c.lineTo(VW, y); c.stroke(); }
  if (s.level.hardway === 'machines' && s.hw) { drawHardWay(c, s); return; }

  drawControlPlane(c, s);
  drawUsers(c, s);

  const traffic = !!s.level.traffic;
  if (traffic) {
    c.setLineDash([4, 6]); c.strokeStyle = 'rgba(120,150,230,.35)'; c.lineWidth = 1.5;
    for (const v of s.services) {
      const r = svcRect(s, v);
      c.beginPath(); c.moveTo(USERS.x + 26, USERS.y); c.lineTo(r.x, mid(r).y); c.stroke();
    }
    c.setLineDash([]);
  }
  for (const v of s.services) {
    const r = svcRect(s, v);
    for (const p of endpoints(s, v)) {
      const pr = podRect(s, p); if (!pr) continue;
      c.strokeStyle = p.phase === 'Running' ? 'rgba(91,141,255,.35)' : 'rgba(180,140,255,.3)';
      c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(r.x + r.w, mid(r).y); c.lineTo(pr.x, pr.y + pr.h / 2); c.stroke();
    }
  }
  drawServices(c, s, traffic);
  s.nodes.forEach((n, i) => drawNode(c, s, n, i));
  for (const p of s.pods) drawPod(c, s, p, selectedId);
  drawPending(c, s);
  drawRequests(c, s);
  drawFx(c, s);
  drawObjects(c, s);
  drawBanner(c, s);
  if (s.level.traffic && s.mode === 'prep') {
    txt(c, 'Prepare your cluster, then press ▶ Open to traffic', VW / 2 + 90, VH - 4, { size: 12, color: '#f5c542', align: 'center' });
  }
}

function drawControlPlane(c: Ctx, s: State): void {
  rr(c, NODE_X, 10, VW - NODE_X - 12, 36, 10);
  c.fillStyle = '#111c3a'; c.fill();
  c.strokeStyle = s.cpPulse > 0 ? 'rgba(91,141,255,' + (0.35 + 0.65 * s.cpPulse) + ')' : '#243256';
  c.lineWidth = 1.5; c.stroke();
  txt(c, 'CONTROL PLANE', NODE_X + 14, 33, { size: 11, bold: true, color: '#8da0c8' });
  ['API server', 'Scheduler', 'Controllers'].forEach((l, i) => {
    const x = NODE_X + 150 + i * 140;
    c.beginPath(); c.arc(x, 28, 5, 0, 7);
    c.fillStyle = s.cpPulse > 0 ? '#5b8dff' : '#2f4a8c'; c.fill();
    txt(c, l, x + 12, 32, { size: 12, color: '#b9ccff' });
  });
}

function drawUsers(c: Ctx, s: State): void {
  const tr = s.level.traffic;
  if (!tr) return;
  const { x, y } = USERS;
  for (let i = 0; i < 3; i++) {
    c.beginPath(); c.arc(x - 18 + i * 18, y - 8 + (i % 2) * 10, 11, 0, 7);
    c.fillStyle = '#243a72'; c.fill(); c.strokeStyle = '#5b8dff'; c.lineWidth = 1.5; c.stroke();
  }
  txt(c, 'Users', x, y + 38, { size: 13, bold: true, align: 'center', color: '#b9ccff' });
  if (s.mode === 'live') {
    txt(c, trafficRate(tr, s.tt).toFixed(1) + ' req/s', x, y + 54, { size: 11, align: 'center', color: '#8da0c8', mono: true });
  }
}

function drawServices(c: Ctx, s: State, traffic: boolean): void {
  if (!s.services.length) {
    if (traffic) {
      const r = { x: SVC_X, y: VH / 2 - SVC_H / 2, w: SVC_W, h: SVC_H };
      c.setLineDash([5, 5]); c.strokeStyle = 'rgba(255,92,92,.5)'; c.lineWidth = 1.5;
      rr(c, r.x, r.y, r.w, r.h, 12); c.stroke(); c.setLineDash([]);
      txt(c, 'no Service!', r.x + r.w / 2, r.y + 26, { size: 13, bold: true, align: 'center', color: '#ff8b8b' });
      txt(c, 'users can\'t reach pods', r.x + r.w / 2, r.y + 44, { size: 10, align: 'center', color: '#8da0c8' });
    }
    return;
  }
  for (const v of s.services) {
    const r = svcRect(s, v);
    rr(c, r.x, r.y, r.w, r.h, 12);
    c.fillStyle = '#17285a'; c.fill(); c.strokeStyle = '#5b8dff'; c.lineWidth = 2; c.stroke();
    txt(c, 'SERVICE', r.x + 10, r.y + 16, { size: 9, bold: true, color: '#8da0c8' });
    txt(c, clip(v.name, 14), r.x + 10, r.y + 33, { size: 14, bold: true });
    const n = endpoints(s, v).filter(p => p.phase === 'Running').length;
    txt(c, clip(Object.entries(v.selector).map(([k, x]) => k + '=' + x).join(','), 14) + ' → ' + n + (v.targetPort !== v.port ? '  :' + v.port + '→' + v.targetPort : ''), r.x + 10, r.y + 50, { size: 10, color: n ? '#9fb6ee' : '#ff8b8b', mono: true });
  }
}

function drawNode(c: Ctx, s: State, n: ClusterNode, i: number): void {
  const r = nodeRect(s, i);
  const booting = s.t < n.bootUntil;
  rr(c, r.x, r.y, r.w, r.h, 12);
  c.fillStyle = n.down ? 'rgba(255,92,92,.08)' : '#101a36'; c.fill();
  c.strokeStyle = n.down ? '#ff5c5c' : n.spot ? '#c9a8ff' : '#2c3f72'; c.lineWidth = 1.5;
  if (booting) c.setLineDash([6, 4]);
  c.stroke(); c.setLineDash([]);
  txt(c, n.name, r.x + 12, r.y + 19, { size: 13, bold: true, color: n.down ? '#ff8b8b' : '#b9ccff' });
  const status = booting ? 'Provisioning…' : n.down ? 'NotReady' : n.unsched ? 'Ready, cordoned' : 'Ready';
  const col = booting ? '#f5c542' : n.down ? '#ff5c5c' : n.unsched ? '#f5c542' : '#3ddc84';
  txt(c, status, r.x + 84, r.y + 19, { size: 11, color: col });
  const E = s.level.econ;
  if (E) {
    const cost = n.spot ? E.spotCost : E.nodeCost;
    txt(c, (n.spot ? 'SPOT ' : '') + '$' + cost.toFixed(3) + '/s', r.x + r.w - 90, r.y + 19, { size: 11, align: 'right', color: n.spot ? '#c9a8ff' : '#f5c542', mono: true });
  }
  txt(c, usedSlots(s, n) + '/' + n.slots + ' pods', r.x + r.w - 12, r.y + 19, { size: 11, align: 'right', color: '#8da0c8', mono: true });
  const sw = (r.w - 16 - (n.slots - 1) * 8) / n.slots;
  const sh = Math.min(r.h - 34, 84);
  for (let k = 0; k < n.slots; k++) {
    c.setLineDash([3, 5]); c.strokeStyle = 'rgba(120,150,230,.18)'; c.lineWidth = 1;
    rr(c, r.x + 8 + k * (sw + 8), r.y + 28 + (r.h - 34 - sh) / 2, sw, sh, 8); c.stroke();
    c.setLineDash([]);
  }
}

function drawPod(c: Ctx, s: State, p: Pod, selectedId: number | null): void {
  const r = podRect(s, p); if (!r) return;
  const col = PHASE_COLORS[p.phase] || '#fff';
  c.save();
  c.globalAlpha = p.phase === 'Terminating' ? Math.max(0.15, 1 - p.phaseT / 1.2) : 1;
  rr(c, r.x, r.y, r.w, r.h, 8);
  c.fillStyle = '#0d1a38'; c.fill();
  c.fillStyle = col + '24'; c.fill();
  c.strokeStyle = col; c.lineWidth = p.id === selectedId ? 3 : 1.6;
  if (p.phase === 'Unknown') c.setLineDash([4, 3]);
  c.stroke(); c.setLineDash([]);
  const lim = Math.max(8, Math.floor(r.w / 7));
  txt(c, clip(p.name, lim), r.x + 8, r.y + 17, { size: 11, bold: true });
  txt(c, clip(p.image, lim + 2), r.x + 8, r.y + 31, { size: 10, color: '#8da0c8', mono: true });
  let label: string = p.phase === 'ContainerCreating' ? 'Creating…' : p.phase;
  if (p.phase === 'CrashLoopBackOff' && p.restarts) label += ' ↺' + p.restarts;
  txt(c, clip(label, lim + 4), r.x + 8, r.y + 46, { size: 10, bold: true, color: col });
  if (r.h > 56) {
    rr(c, r.x + 8, r.y + r.h - 14, r.w - 16, 6, 3); c.fillStyle = '#1b2a52'; c.fill();
    if (p.phase === 'Running') {
      const u = Math.min(1, p.util);
      rr(c, r.x + 8, r.y + r.h - 14, Math.max(4, (r.w - 16) * u), 6, 3);
      c.fillStyle = u > 0.85 ? '#ff5c5c' : u > 0.6 ? '#f5c542' : '#3ddc84'; c.fill();
    }
  }
  for (let i = 0; i < p.busy.length; i++) {
    c.beginPath(); c.arc(r.x + r.w - 12 - i * 11, r.y + 13, 4, 0, 7); c.fillStyle = '#ffd666'; c.fill();
  }
  if (p.phase === 'ContainerCreating') {
    const f = Math.min(1, p.phaseT / CREATE_TIME);
    rr(c, r.x + 8, r.y + r.h - 14, (r.w - 16) * f, 6, 3); c.fillStyle = '#f5c542'; c.fill();
  }
  c.restore();
}

function drawPending(c: Ctx, s: State): void {
  drawFinished(c, s);
  const pend = s.pods.filter(p => !p.node && p.phase === 'Pending');
  if (!pend.length) return;
  txt(c, 'PENDING (unscheduled)', 14, 66, { size: 10, bold: true, color: '#f5c542' });
  pend.slice(0, 6).forEach((p, i) => {
    const x = 14 + (i % 2) * 88, y = 74 + Math.floor(i / 2) * 40;
    rr(c, x, y, 82, 34, 7); c.fillStyle = 'rgba(245,197,66,.12)'; c.fill();
    c.setLineDash([3, 3]); c.strokeStyle = '#f5c542'; c.lineWidth = 1.3; c.stroke(); c.setLineDash([]);
    txt(c, clip(p.name, 12), x + 6, y + 14, { size: 10, bold: true });
    txt(c, 'no node fits', x + 6, y + 27, { size: 9, color: '#f5c542' });
  });
}

/** Completed / failed batch pods hold no node, so they get their own shelf on the left. */
const finishedPods = (s: State): Pod[] => s.pods.filter(p => p.phase === 'Completed' || p.phase === 'Error').slice(-6);
function finishedRect(s: State, p: Pod): Rect | null {
  const i = finishedPods(s).indexOf(p);
  return i < 0 ? null : { x: 14 + (i % 2) * 150, y: 222 + Math.floor(i / 2) * 40, w: 144, h: 34 };
}
function drawFinished(c: Ctx, s: State): void {
  const list = finishedPods(s);
  if (!list.length) return;
  txt(c, 'FINISHED (no node needed)', 14, 214, { size: 10, bold: true, color: '#8da0c8' });
  for (const p of list) {
    const r = finishedRect(s, p)!;
    const col = p.phase === 'Completed' ? '#3ddc84' : '#ff5c5c';
    rr(c, r.x, r.y, r.w, r.h, 7); c.fillStyle = col + '1c'; c.fill(); c.strokeStyle = col; c.lineWidth = 1.3; c.stroke();
    txt(c, clip(p.name, 20), r.x + 6, r.y + 14, { size: 10, bold: true });
    txt(c, p.phase + (p.ranOn ? ' on ' + p.ranOn : ''), r.x + 6, r.y + 27, { size: 9, color: col });
  }
}

function reqPos(s: State, r: Request): Pt {
  if (r.stage === 'toSvc') {
    const a = { x: USERS.x + 26, y: USERS.y };
    const target = r.svc ? svcRect(s, r.svc) : null;
    const b = target ? { x: target.x, y: mid(target).y } : a;
    return lerp(a, b, Math.min(1, r.t / T_SVC));
  }
  const sr = r.svc ? svcRect(s, r.svc) : null;
  const pr = r.pod ? podRect(s, r.pod) : null;
  if (!sr) return USERS;
  if (!pr) return mid(sr);
  return lerp({ x: sr.x + sr.w, y: mid(sr).y }, { x: pr.x, y: pr.y + pr.h / 2 }, Math.min(1, r.t / T_POD));
}
function drawRequests(c: Ctx, s: State): void {
  for (const r of s.reqs) {
    if (r.stage === 'proc') continue;
    const p = reqPos(s, r);
    c.beginPath(); c.arc(p.x, p.y, 4.5, 0, 7);
    c.fillStyle = '#7fb0ff'; c.shadowColor = '#5b8dff'; c.shadowBlur = 8; c.fill(); c.shadowBlur = 0;
  }
}
function drawFx(c: Ctx, s: State): void {
  for (const f of s.fx) {
    const k = f.t / 0.9;
    c.save(); c.globalAlpha = 1 - k;
    let x: number | undefined, y = 0;
    if (f.where === 'users') { x = USERS.x + 50; y = USERS.y - 10; }
    else if (f.where === 'svc' && f.svc) { const r = svcRect(s, f.svc); x = r.x + r.w + 6; y = mid(r).y; }
    else if (f.pod) { const r = podRect(s, f.pod); if (r) { x = r.x + r.w / 2; y = r.y + 4; } }
    if (x !== undefined) {
      y -= k * 22;
      if (f.kind === 'fail') txt(c, '✕ ' + (f.where === 'pod' ? '503' : f.where === 'svc' ? 'no endpoints' : 'refused'), x, y, { size: 12, bold: true, color: '#ff5c5c', align: 'center' });
      else txt(c, '✓', x, y, { size: 15, bold: true, color: '#3ddc84', align: 'center' });
    }
    c.restore();
  }
}

function drawObjects(c: Ctx, s: State): void {
  const lines: { t: string; col: string }[] = [];
  for (const d of s.deployments) lines.push({ t: 'Deployment ' + d.name + '  ' + readyCount(s, d.name) + '/' + d.replicas + ' ready', col: '#9fb6ee' });
  for (const h of s.hpas) lines.push({ t: 'HPA ' + h.dep + '  ' + h.min + '–' + h.max + ' @ ' + h.cpu + '%', col: '#c9a8ff' });
  for (const m of s.configmaps) lines.push({ t: 'ConfigMap ' + m.name, col: '#8fd9b6' });
  for (const m of s.secrets) lines.push({ t: 'Secret ' + m.name, col: '#ffb8a8' });
  for (const j of s.jobs) lines.push({ t: 'Job ' + j.name + '  ' + j.status, col: j.status === 'Failed' ? '#ff8b8b' : '#8fd9b6' });
  for (const cj of s.cronjobs) lines.push({ t: 'CronJob ' + cj.name + '  ' + cj.schedule + (cj.suspend ? ' (suspended)' : ''), col: '#c9a8ff' });
  if (!lines.length) return;
  const shown = lines.slice(-6);
  let y = VH - 10 - (shown.length - 1) * 16;
  for (const l of shown) { txt(c, clip(l.t, 40), 14, y, { size: 11, color: l.col, mono: true }); y += 16; }
}

function drawBanner(c: Ctx, s: State): void {
  if (!s.banner || s.t > s.banner.until) return;
  const w = Math.min(560, 40 + s.banner.text.length * 7.2), x = (VW - w) / 2 + 100;
  rr(c, x, 54, w, 30, 15);
  c.fillStyle = 'rgba(60,35,10,.92)'; c.fill(); c.strokeStyle = '#ff9f43'; c.lineWidth = 1.5; c.stroke();
  txt(c, '⚠ ' + s.banner.text, x + w / 2, 74, { size: 13, bold: true, color: '#ffc27a', align: 'center' });
}

export function podAt(s: State, x: number, y: number): Pod | null {
  for (let i = s.pods.length - 1; i >= 0; i--) {
    const p = s.pods[i], r = podRect(s, p) ?? finishedRect(s, p);
    if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return p;
  }
  return null;
}

// ---- The Hard Way: the four lab machines --------------------------------------------------------------------------------
type Check = [label: string, ok: boolean];

function machineChecks(s: State, m: Machine): Check[] {
  const f = (p: string) => !!m.files[p];
  if (m.name === 'jumpbox') {
    return [['SSH key pair', s.hw!.keyGenerated], ['repository cloned', f('/root/kubernetes-the-hard-way/ca.conf')], ['kubectl installed', !!m.files['/usr/local/bin/kubectl']?.exec],
      ['certificate authority', f('/root/kubernetes-the-hard-way/ca.crt')], ['kubeconfig for kubectl', f('/root/.kube/config')]];
  }
  if (m.name === 'server') {
    return [['SSH access', m.hasKey], ['hostname set', m.hostname === 'server'], ['certificates in place', f('/var/lib/kubernetes/kube-api-server.crt')], ['encryption config', f('/var/lib/kubernetes/encryption-config.yaml')],
      ['pod routes (' + m.routes.length + '/2)', m.routes.length >= 2]];
  }
  return [['SSH access', m.hasKey], ['hostname set', m.hostname === m.name], ['swap off', !m.swap], ['kubelet certificate', f('/var/lib/kubelet/kubelet.crt')], ['pod network ready', f('/etc/cni/net.d/10-bridge.conf') && m.modules.includes('br_netfilter')],
    ['route to other node', m.routes.length >= 1]];
}

function unitsOf(m: Machine): string[] {
  return m.name === 'server' ? ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler'] : m.name.startsWith('node') ? ['containerd', 'kubelet', 'kube-proxy'] : [];
}

function drawHardWay(c: Ctx, s: State): void {
  const hw = s.hw!;
  const names = ['jumpbox', 'server', 'node-0', 'node-1'];
  const gap = 12, w = (VW - 24 - gap * 3) / 4, top = 38, h = VH - top - 22;
  txt(c, 'Kubernetes The Hard Way', 14, 22, { size: 14, bold: true, color: '#b9ccff' });
  txt(c, 'You are on: ' + hw.active + (hw.stack.length ? '   (exit to go back)' : ''), VW - 14, 22, { size: 12, align: 'right', color: '#f5c542', mono: true });
  c.setLineDash([4, 6]); c.strokeStyle = 'rgba(120,150,230,.3)'; c.lineWidth = 1.5;
  for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(12 + (w + gap) * i - gap, top + 30); c.lineTo(12 + (w + gap) * i, top + 30); c.stroke(); }
  c.setLineDash([]);
  names.forEach((n, i) => {
    const m = hw.machines[n];
    const x = 12 + i * (w + gap);
    const here = hw.active === n;
    rr(c, x, top, w, h, 12);
    c.fillStyle = here ? '#14224a' : '#101a36'; c.fill();
    c.strokeStyle = here ? '#5b8dff' : '#2c3f72'; c.lineWidth = here ? 2.5 : 1.5; c.stroke();
    txt(c, n, x + 12, top + 24, { size: 16, bold: true });
    txt(c, n === 'jumpbox' ? 'admin workstation' : n === 'server' ? 'control plane' : 'worker, pods ' + m.subnet, x + 12, top + 41, { size: 10, color: '#8da0c8' });
    txt(c, 'hostname ' + m.hostname, x + 12, top + 60, { size: 11, mono: true, color: m.hostname === n || n === 'jumpbox' ? '#9fb6ee' : '#f5c542' });
    txt(c, m.ip, x + 12, top + 75, { size: 11, mono: true, color: '#8da0c8' });
    let y = top + 100;
    const units = unitsOf(m);
    if (units.length) {
      txt(c, 'SERVICES', x + 12, y, { size: 9, bold: true, color: '#8da0c8' }); y += 16;
      for (const u of units) {
        const st = m.units[u];
        const col = st?.active ? '#3ddc84' : st?.journal.length ? '#ff5c5c' : '#3a4a78';
        c.beginPath(); c.arc(x + 18, y - 4, 5, 0, 7); c.fillStyle = col; c.fill();
        txt(c, clip(u, Math.floor((w - 40) / 6.6)), x + 30, y, { size: 11, mono: true, color: st?.active ? '#d9e4ff' : '#8da0c8' });
        y += 18;
      }
      y += 8;
    }
    txt(c, 'CHECKLIST', x + 12, y, { size: 9, bold: true, color: '#8da0c8' }); y += 16;
    for (const [label, ok] of machineChecks(s, m)) {
      txt(c, ok ? '✓' : '·', x + 14, y, { size: 12, bold: true, color: ok ? '#3ddc84' : '#586a99' });
      txt(c, clip(label, Math.floor((w - 40) / 6.2)), x + 30, y, { size: 11, color: ok ? '#d9e4ff' : '#8da0c8' });
      y += 18;
    }
  });
  txt(c, apiserverUp(hw) ? 'API server is answering on server.kubernetes.local:6443' : unitActive(hw, 'server', 'etcd') ? 'etcd is up; the control plane is not' : 'No cluster yet', VW / 2, VH - 6, { size: 11, align: 'center', color: apiserverUp(hw) ? '#3ddc84' : '#8da0c8' });
}
