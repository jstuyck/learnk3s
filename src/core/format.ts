// kubectl-style tables. Column sets mirror the real tool (extra columns only with -o wide).
import { endpoints, NODE_CPU, ownedPods, readyCount, tplOf } from './sim';
import type { Pod, State } from './types';

type Row = (string | number)[];

/** Left-aligned text table, kubectl style. */
export function table(rows: Row[]): string[] {
  const w: number[] = [];
  rows.forEach(r => r.forEach((c, i) => { w[i] = Math.max(w[i] || 0, String(c).length); }));
  return rows.map(r => r.map((c, i) => String(c).padEnd(w[i] + 3)).join('').trimEnd());
}

/** 5s, 2m10s, 1h3m ... like kubectl's AGE column. */
export function fmtAge(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  if (t < 120) return t + 's';
  if (t < 3600) return Math.floor(t / 60) + 'm' + (t % 60 ? (t % 60) + 's' : '');
  return Math.floor(t / 3600) + 'h' + (Math.floor(t / 60) % 60 ? (Math.floor(t / 60) % 60) + 'm' : '');
}
export const ageStr = (s: State, t: number): string => fmtAge(s.t - t);

export const podIp = (s: State, p: Pod): string =>
  p.node ? '10.244.' + (s.nodes.findIndex(n => n.name === p.node) + 1) + '.' + ((p.id % 250) + 2) : '<none>';

/** "app=web" style label selector; undefined selector matches everything. */
export const matchesSelector = (p: Pod, selector?: string): boolean => {
  if (!selector) return true;
  return selector.split(',').every(term => {
    const m = /^([\w./-]+)(!=|==|=)(.*)$/.exec(term.trim());
    if (!m) return false;
    const have = p.labels[m[1]];
    return m[2] === '!=' ? have !== m[3] : have === m[3];
  });
};

export const labelText = (labels: Record<string, string>): string =>
  Object.entries(labels).map(([k, v]) => k + '=' + v).join(',');

/** STATUS column: kubectl shows the reason (e.g. OOMKilled) for a crashed container. */
export const podStatus = (p: Pod): string =>
  p.phase === 'CrashLoopBackOff' && p.reason === 'OOMKilled' && p.restarts === 0 ? 'OOMKilled' : p.phase;

export function podRows(s: State, wide = false, selector?: string, showLabels = false, list: Pod[] = s.pods): Row[] {
  const head = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'].concat(wide ? ['IP', 'NODE'] : [], showLabels ? ['LABELS'] : []);
  const rows: Row[] = [head];
  for (const p of list.filter(x => matchesSelector(x, selector))) {
    rows.push(
      [p.name, p.phase === 'Running' ? '1/1' : '0/1', podStatus(p), p.restarts, fmtAge(p.age)]
        .concat(wide ? [podIp(s, p), p.node || p.ranOn || '<none>'] : [], showLabels ? [labelText(p.labels)] : []),
    );
  }
  return rows;
}

export function depRows(s: State, wide = false): Row[] {
  const rows: Row[] = [['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'].concat(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])];
  for (const d of s.deployments) {
    const own = ownedPods(s, d.name);
    rows.push([
      d.name, readyCount(s, d.name) + '/' + d.replicas, own.filter(p => p.tpl === tplOf(d)).length, readyCount(s, d.name), fmtAge(s.t - d.createdAt),
    ].concat(wide ? [d.name, d.image, 'app=' + d.app] : []));
  }
  return rows;
}

export function svcRows(s: State, wide = false): Row[] {
  const rows: Row[] = [['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'].concat(wide ? ['SELECTOR'] : [])];
  for (const v of s.services) {
    rows.push([v.name, 'ClusterIP', v.ip, '<none>', v.port + '/TCP', fmtAge(s.t - v.createdAt)].concat(wide ? [labelText(v.selector)] : []));
  }
  return rows;
}

export function endpointRows(s: State): Row[] {
  const rows: Row[] = [['NAME', 'ENDPOINTS', 'AGE']];
  for (const v of s.services) {
    const eps = endpoints(s, v).filter(p => p.phase === 'Running').map(p => podIp(s, p) + ':' + v.targetPort);
    rows.push([v.name, eps.length ? eps.join(',') : '<none>', fmtAge(s.t - v.createdAt)]);
  }
  return rows;
}

export function nodeRows(s: State, showLabels = false): Row[] {
  const rows: Row[] = [['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'].concat(showLabels ? ['LABELS'] : [])];
  for (const n of s.nodes) {
    const st = s.t < n.bootUntil ? 'NotReady' : n.down ? 'NotReady' : n.unsched ? 'Ready,SchedulingDisabled' : 'Ready';
    const labels = 'kubernetes.io/hostname=' + n.name + ',node.kubernetes.io/capacity-type=' + (n.spot ? 'spot' : 'on-demand');
    rows.push([n.name, st, '<none>', fmtAge(s.t + 3600), 'v1.30.2'].concat(showLabels ? [labels] : []));
  }
  return rows;
}

/** `kubectl top pods`: a pod is requested at 500m CPU, so a saturated pod sits near 500m. */
export const POD_CPU_REQUEST_M = 500;
const podMem = (p: Pod): number => 40 + (p.id % 17);
export function topRows(s: State, sortBy?: 'cpu' | 'memory'): Row[] {
  const rows: Row[] = [['NAME', 'CPU(cores)', 'MEMORY(bytes)']];
  const running = s.pods.filter(x => x.phase === 'Running');
  if (sortBy) running.sort((a, b) => (sortBy === 'cpu' ? b.util - a.util : podMem(b) - podMem(a)));
  for (const p of running) rows.push([p.name, Math.round(p.util * POD_CPU_REQUEST_M) + 'm', podMem(p) + 'Mi']);
  return rows;
}

/** `kubectl top nodes`: CPU is what the node's running pods use; memory is a flat base plus a share per pod. */
export function topNodeRows(s: State): Row[] {
  const rows: Row[] = [['NAME', 'CPU(cores)', 'CPU%', 'MEMORY(bytes)', 'MEMORY%']];
  for (const n of s.nodes) {
    if (n.down || s.t < n.bootUntil) { rows.push([n.name, '<unknown>', '<unknown>', '<unknown>', '<unknown>']); continue; }
    const ps = s.pods.filter(p => p.node === n.name && p.phase === 'Running');
    const cpu = Math.round(ps.reduce((a, p) => a + p.util * POD_CPU_REQUEST_M, 0));
    const mem = 300 + ps.reduce((a, p) => a + podMem(p), 0);
    rows.push([n.name, cpu + 'm', Math.round((cpu / NODE_CPU) * 100) + '%', mem + 'Mi', Math.round((mem / 4096) * 100) + '%']);
  }
  return rows;
}

export function jobRows(s: State): Row[] {
  const rows: Row[] = [['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE']];
  for (const j of s.jobs) {
    const dur = fmtAge((j.doneAt ?? s.t) - j.createdAt);
    rows.push([j.name, j.status, (j.status === 'Complete' ? 1 : 0) + '/1', dur, fmtAge(s.t - j.createdAt)]);
  }
  return rows;
}

export function cronRows(s: State): Row[] {
  const rows: Row[] = [['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'LAST SCHEDULE', 'AGE']];
  for (const c of s.cronjobs) {
    const active = s.jobs.filter(j => j.owner === c.name && j.status === 'Running').length;
    rows.push([c.name, c.schedule, '<none>', c.suspend ? 'True' : 'False', active, c.lastSchedule === null ? '<none>' : fmtAge(s.t - c.lastSchedule), fmtAge(s.t - c.createdAt)]);
  }
  return rows;
}
