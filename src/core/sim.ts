// ---------------------------------------------------------------------------
// Cluster simulation: nodes, pods, controllers, jobs, services, traffic, economy.
// No DOM access in here, so it can be tested headlessly.
// ---------------------------------------------------------------------------
import { IMAGES, portOf } from '../data/images';
import { newHardWay } from './hardway';
import { makeRng } from './rng';
import { burnRate, profit } from './economy';
import type {
  ClusterNode, CronJob, Deployment, Job, Labels, Level, Pod, Request, Resources, RevisionEntry, Service, State, Traffic,
} from './types';

export const CAP = 3;          // concurrent requests one pod can handle
export const PROC = 1.2;       // seconds to process one request
export const T_SVC = 0.5;      // travel time users -> service
export const T_POD = 0.4;      // travel time service -> pod
export const CREATE_TIME = 2;  // seconds from scheduled to Running
export const STALE = 1.5;      // seconds a dead pod stays in the endpoint list
export const NODE_CPU = 2000;  // millicores each node can hand out
export const DEFAULT_CPU = 100; // CPU request of a pod that sets none
export const MINUTE = 10;      // one simulated cron minute, in seconds
export const JOB_BACKOFF_LIMIT = 3;

export function newState(level: Level, seed: number = Date.now()): State {
  const s: State = {
    level, rng: makeRng(seed), t: 0, tt: 0,
    mode: level.traffic && !level.traffic.auto ? 'prep' : 'live',
    nodes: [], pods: [], deployments: [], services: [], configmaps: [], secrets: [], hpas: [], jobs: [], cronjobs: [],
    money: { rev: 0, cost: 0, pen: 0 }, recent: [], nodeSeq: level.nodes,
    reqs: [], fx: [], msgs: [],
    stats: { sent: 0, served: 0, failed: 0 },
    flags: {}, done: {}, peak: {}, cmdErrors: 0, hintsUsed: 0, nextId: 1,
    acc: { spawn: 0, recon: 0, obj: 0, hpa: 0 },
    evFired: {}, evArmed: {}, banner: null, cpPulse: 0, outcome: null, failReason: '',
  };
  if (level.hardway) s.hw = newHardWay();
  for (let i = 0; i < level.nodes; i++) s.nodes.push(makeNode('node-' + (i + 1), level.slots, false, 0));
  level.setup?.(s);
  settle(s);
  s.msgs.length = 0;
  return s;
}

// ---- helpers --------------------------------------------------------------
export const say = (s: State, text: string, cls?: string): void => { s.msgs.push({ t: text, c: cls || '' }); };
export const depOf = (s: State, name: string): Deployment | undefined => s.deployments.find(d => d.name === name);
export const ownedPods = (s: State, name: string): Pod[] => s.pods.filter(p => p.owner === name && p.phase !== 'Terminating');
export const readyCount = (s: State, name: string): number => s.pods.filter(p => p.owner === name && p.phase === 'Running').length;
const countable = (p: Pod): boolean => p.phase !== 'Terminating' && !(p.phase === 'Unknown' && p.phaseT >= STALE);
export const usedSlots = (s: State, n: ClusterNode): number => s.pods.filter(p => p.node === n.name).length;
export const usedCpu = (s: State, n: ClusterNode): number => s.pods.filter(p => p.node === n.name).reduce((a, p) => a + p.cpuReq, 0);
export const nodeReady = (s: State, n: ClusterNode): boolean => !n.down && !n.unsched && s.t >= n.bootUntil;
export const banner = (s: State, text: string): void => { s.banner = { text, until: s.t + 6 }; say(s, '[event] ' + text, 'evt'); };

/** The pod-template fields of a Deployment; they decide when pods must be replaced. */
type Template = Pick<RevisionEntry, 'image' | 'config' | 'secret' | 'res' | 'restart'>;
export const tplOf = (d: Template): string =>
  [d.image, d.config || '', d.secret || '', d.res.cpu, d.res.mem ?? '', d.restart].join('|');
/** What new pods are built from: the live spec, or the frozen one while a rollout is paused. */
export const templateOf = (d: Deployment): Template => d.frozen ?? d;
export const snapshot = (d: Template): RevisionEntry =>
  ({ image: d.image, config: d.config, secret: d.secret, res: { ...d.res }, restart: d.restart });

/** Record a spec change as a new revision (call after mutating the Deployment). */
export function recordRevision(d: Deployment): void {
  d.history.push(snapshot(d));
  if (!d.frozen) d.rollouts++;
}

export function selectorMatches(selector: Labels, labels: Labels): boolean {
  const keys = Object.keys(selector);
  return keys.length > 0 && keys.every(k => labels[k] === selector[k]);
}

export function makeNode(name: string, slots: number, spot: boolean, bootUntil: number): ClusterNode {
  return { name, slots, spot, down: false, downUntil: 0, bootUntil, unsched: false, announced: true };
}

function suffix(s: State): string {
  const a = 'bcdfghjklmnpqrstvwxz2456789';
  for (;;) {
    let r = '';
    for (let i = 0; i < 5; i++) r += a[Math.floor(s.rng() * a.length)];
    if (!s.pods.some(p => p.name.endsWith('-' + r))) return r;
  }
}

export function addDeployment(
  s: State,
  o: { name: string; image: string; replicas: number; config?: string; secret?: string; res?: Partial<Resources> },
): Deployment {
  const d: Deployment = {
    name: o.name, app: o.name, image: o.image, config: o.config || null, secret: o.secret || null,
    res: { cpu: o.res?.cpu ?? DEFAULT_CPU, mem: o.res?.mem ?? null }, restart: 0, frozen: null,
    replicas: o.replicas, createdAt: s.t, history: [], rollouts: 0,
  };
  d.history.push(snapshot(d));
  s.deployments.push(d);
  return d;
}

/** Create a Service. A string selector means app=<string>. */
export function addService(s: State, name: string, selector: string | Labels, port = 80, targetPort = port): Service {
  const v: Service = {
    name, selector: typeof selector === 'string' ? { app: selector } : { ...selector }, port, targetPort,
    createdAt: s.t, ip: '10.96.' + (s.services.length + 11) + '.' + (30 + s.services.length * 17),
  };
  s.services.push(v);
  return v;
}

export function makePod(
  s: State,
  o: {
    name: string; app: string; image: string; tpl?: string; config?: string | null; secret?: string | null; owner?: string | null;
    labels?: Labels; cpuReq?: number; memLimit?: number | null; command?: string[]; runFor?: number; willFail?: boolean;
  },
): Pod {
  const p: Pod = {
    id: s.nextId++, name: o.name, app: o.app, labels: { app: o.app, ...(o.labels || {}) }, image: o.image,
    tpl: o.tpl || o.image + '|||100||0',
    config: o.config || null, secret: o.secret || null, owner: o.owner || null,
    node: null, ranOn: null, slot: -1, phase: 'Pending', phaseT: 0, age: 0, restarts: 0,
    busy: [], util: 0, logs: [], reason: '', events: [], warned: false,
    cpuReq: o.cpuReq ?? DEFAULT_CPU, memLimit: o.memLimit ?? null, command: o.command || [],
    runFor: o.runFor, willFail: o.willFail,
  };
  s.pods.push(p);
  return p;
}
export function podEvent(s: State, p: Pod, type: 'Normal' | 'Warning', reason: string, msg: string): void {
  p.events.push({ t: s.t, type, reason, msg });
  if (p.events.length > 8) p.events.shift();
}
function spawnDepPod(s: State, d: Deployment): Pod {
  const T = templateOf(d);
  return makePod(s, {
    name: d.name + '-' + suffix(s), app: d.app, image: T.image, tpl: tplOf(T), config: T.config, secret: T.secret,
    owner: d.name, cpuReq: T.res.cpu, memLimit: T.res.mem,
  });
}
function removePod(s: State, p: Pod): void { s.pods = s.pods.filter(x => x !== p); }
export function terminate(s: State, p: Pod): void {
  if (p.phase === 'Terminating') return;
  p.phase = 'Terminating'; p.phaseT = 0;
  podEvent(s, p, 'Normal', 'Killing', 'Stopping container');
}

// ---- batch command semantics (Jobs, `run --restart=Never`) ----------------------
export interface CommandPlan { runFor: number; fail: boolean; output: string[] }

/** What a container command does in the simulator: how long it runs, whether it fails, what it prints. */
export function planCommand(command: string[], podName: string): CommandPlan {
  let text = command.join(' ').trim();
  text = text.replace(/^(\/bin\/)?(ba)?sh -c\s+/, '').replace(/^(['"])(.*)\1$/, '$2').trim();
  const sleep = /(?:^|\s|;|&&)sleep\s+(\d+)/.exec(text);
  const runFor = sleep ? Math.min(120, Number(sleep[1])) : 2;
  const fail = /^(false|exit\s+[1-9]\d*)\b/.test(text) || /&&\s*(false|exit\s+[1-9])/.test(text);
  const output: string[] = [];
  for (const part of text.split(/&&|;/).map(x => x.trim())) {
    const echo = /^echo\s+(.*)$/.exec(part);
    if (echo) output.push(echo[1].replace(/^(['"])(.*)\1$/, '$2'));
    else if (part === 'date') output.push('Mon Oct 19 23:30:00 UTC 2026');
    else if (part === 'hostname') output.push(podName);
  }
  return { runFor, fail, output };
}

// ---- pod lifecycle --------------------------------------------------------
function crash(s: State, p: Pod, logs: string[], exitCode: number, reason = 'Error'): void {
  const batch = p.owner?.startsWith('job/') || p.runFor !== undefined;
  p.phase = batch ? 'Error' : 'CrashLoopBackOff';
  p.logs = logs; p.reason = reason;
  if (batch) { p.ranOn = p.node; p.node = null; p.slot = -1; }
  podEvent(s, p, 'Warning', batch ? 'BackoffLimitExceeded' : 'BackOff',
    batch ? 'Container exited with code ' + exitCode : 'Back-off restarting failed container (exit code ' + exitCode + ')');
  if (reason === 'OOMKilled') podEvent(s, p, 'Warning', 'OOMKilled', 'Container exceeded its memory limit of ' + p.memLimit + 'Mi');
}

function finishCreating(s: State, p: Pod): void {
  const img = IMAGES[p.image];
  p.phaseT = 0;
  if (!img) {
    p.phase = 'ImagePullBackOff';
    p.logs = ['container is waiting to start: image "' + p.image + '" can not be pulled'];
    podEvent(s, p, 'Warning', 'Failed', 'Failed to pull image "' + p.image + '": repository does not exist or may require authorization');
    podEvent(s, p, 'Warning', 'BackOff', 'Back-off pulling image "' + p.image + '"');
    return;
  }
  if (img.crash) { crash(s, p, img.crash.slice(), 2); return; }
  if (img.memNeed !== undefined && p.memLimit !== null && p.memLimit < img.memNeed) {
    crash(s, p, [], 137, 'OOMKilled');
    return;
  }
  if (img.needs) {
    const cm = p.config ? s.configmaps.find(c => c.name === p.config) : undefined;
    const sec = p.secret ? s.secrets.find(c => c.name === p.secret) : undefined;
    const want = img.src || 'configmap';
    const fromCm = cm ? cm.data[img.needs] : undefined;
    const fromSec = sec ? sec.data[img.needs] : undefined;
    const val = want === 'secret' ? fromSec : fromCm;
    let logs: string[] | null = null;
    if (val === undefined) {
      if (want === 'secret' && fromCm !== undefined) {
        logs = ['FATAL: ' + img.needs + ' came from a ConfigMap, but this app only accepts credentials from a Secret',
          'hint: a ConfigMap is plain text and not access-controlled. Credentials belong in a Secret.'];
      } else if (want === 'secret') {
        logs = ['FATAL: environment variable ' + img.needs + ' is not set', 'hint: credentials belong in a Secret, injected as environment variables'];
      } else {
        logs = ['FATAL: environment variable ' + img.needs + ' is not set', 'hint: this app reads its settings from the environment (e.g. injected from a ConfigMap)'];
      }
    } else if (img.value && val !== img.value) {
      logs = want === 'secret'
        ? ['FATAL: payment provider rejected key "' + val.slice(0, 6) + '...": 401 Unauthorized', 'hint: check the API key in the release notes']
        : ['FATAL: cannot connect to database at "' + val + '": connection refused', 'hint: check the DB_URL in the release notes'];
    }
    if (logs) { crash(s, p, logs, 1); return; }
  }
  p.phase = 'Running';
  podEvent(s, p, 'Normal', 'Started', 'Started container');
}

/** A batch pod's command has finished: Completed, or Error when the command failed. */
function finishBatchPod(s: State, p: Pod): void {
  const plan = planCommand(p.command, p.name);
  p.ranOn = p.node; p.node = null; p.slot = -1;
  if (p.willFail ?? plan.fail) {
    p.phase = 'Error'; p.logs = plan.output.concat(['(command exited with code 1)']); p.reason = 'Error';
    podEvent(s, p, 'Warning', 'Failed', 'Container exited with code 1');
  } else {
    p.phase = 'Completed'; p.logs = plan.output; p.reason = 'Completed';
    podEvent(s, p, 'Normal', 'Completed', 'Container exited with code 0');
  }
  p.phaseT = 0;
}

function stepPod(s: State, p: Pod, dt: number): void {
  p.age += dt; p.phaseT += dt;
  if (p.phase === 'ContainerCreating' && p.phaseT >= CREATE_TIME) finishCreating(s, p);
  else if (p.phase === 'Running' && p.runFor !== undefined && p.phaseT >= p.runFor) finishBatchPod(s, p);
  else if (p.phase === 'CrashLoopBackOff' && p.phaseT >= 5) {
    p.phaseT = 0; p.restarts++;
    podEvent(s, p, 'Warning', 'BackOff', 'Back-off restarting failed container');
  } else if (p.phase === 'Terminating' && p.phaseT >= 1.2) removePod(s, p);
  else if (p.phase === 'Unknown' && p.phaseT >= 4) removePod(s, p);
  const target = p.phase === 'Running' ? p.busy.length / CAP : 0;
  p.util += (target - p.util) * Math.min(1, dt * 1.6);
}

// ---- scheduler & controllers ---------------------------------------------
function schedule(s: State): void {
  for (const p of s.pods) {
    if (p.phase !== 'Pending' || p.node) continue;
    const withSlot = s.nodes.filter(n => nodeReady(s, n) && usedSlots(s, n) < n.slots);
    const cands = withSlot.filter(n => usedCpu(s, n) + p.cpuReq <= NODE_CPU);
    if (!cands.length) {
      if (!p.warned) {
        p.warned = true;
        const cpuBlocked = withSlot.length > 0;
        podEvent(s, p, 'Warning', 'FailedScheduling', '0/' + s.nodes.length + ' nodes are available: ' +
          (cpuBlocked ? withSlot.length + ' Insufficient cpu (pod requests ' + p.cpuReq + 'm, a node has ' + NODE_CPU + 'm).'
            : 'no free capacity (nodes are full, cordoned or NotReady).'));
      }
      continue;
    }
    const same = (n: ClusterNode) => s.pods.filter(x => x.node === n.name && x.app === p.app && x.phase !== 'Terminating').length;
    cands.sort((a, b) => same(a) - same(b) || usedSlots(s, a) - usedSlots(s, b));
    const n = cands[0];
    const taken = new Set(s.pods.filter(x => x.node === n.name).map(x => x.slot));
    let slot = 0; while (taken.has(slot)) slot++;
    p.node = n.name; p.slot = slot; p.phase = 'ContainerCreating'; p.phaseT = 0;
    podEvent(s, p, 'Normal', 'Scheduled', 'Successfully assigned default/' + p.name + ' to ' + n.name);
    podEvent(s, p, 'Normal', 'Pulling', 'Pulling image "' + p.image + '"');
    s.cpPulse = 1;
  }
}

function reconcileDeployment(s: State, d: Deployment): void {
  const tpl = tplOf(templateOf(d));
  let owned = s.pods.filter(p => p.owner === d.name && countable(p));
  const isReady = (p: Pod) => p.phase === 'Running';
  // anything of an old template that is not serving gets removed right away
  for (const p of owned.filter(p => p.tpl !== tpl && !isReady(p))) { terminate(s, p); s.cpPulse = 1; }
  owned = owned.filter(p => p.phase !== 'Terminating');
  const cur = owned.filter(p => p.tpl === tpl);
  const old = owned.filter(p => p.tpl !== tpl);
  const ready = owned.filter(isReady).length;

  if (!old.length) {
    if (owned.length < d.replicas) { for (let i = owned.length; i < d.replicas; i++) spawnDepPod(s, d); s.cpPulse = 1; }
    else if (owned.length > d.replicas) {
      const victims = owned.slice().sort((a, b) => (Number(isReady(a)) - Number(isReady(b))) || (a.age - b.age));
      for (const p of victims.slice(0, owned.length - d.replicas)) terminate(s, p);
      s.cpPulse = 1;
    }
    return;
  }
  // rolling update: maxSurge 1, maxUnavailable 0
  if (cur.filter(isReady).length >= d.replicas) {
    for (const p of old) terminate(s, p);
    s.cpPulse = 1; return;
  }
  if (cur.length < d.replicas && owned.length < d.replicas + 1) { spawnDepPod(s, d); s.cpPulse = 1; }
  else if (ready > d.replicas) {
    const victim = old.filter(isReady).sort((a, b) => b.age - a.age)[0];
    if (victim) { terminate(s, victim); s.cpPulse = 1; }
  }
}

// ---- Jobs & CronJobs ----------------------------------------------------------
export const jobPods = (s: State, job: string): Pod[] => s.pods.filter(p => p.owner === 'job/' + job);

export function createJob(s: State, o: { name: string; image: string; command: string[]; owner?: string | null }): Job {
  const j: Job = {
    name: o.name, image: o.image, command: o.command, status: 'Running', owner: o.owner ?? null,
    createdAt: s.t, doneAt: null, nextTry: s.t,
  };
  s.jobs.push(j);
  return j;
}

export function deleteJob(s: State, j: Job): void {
  s.jobs = s.jobs.filter(x => x !== j);
  for (const p of jobPods(s, j.name)) terminate(s, p);
}

function reconcileJob(s: State, j: Job): void {
  if (j.status !== 'Running') return;
  const pods = jobPods(s, j.name).filter(p => p.phase !== 'Terminating');
  const failed = pods.filter(p => p.phase === 'Error').length;
  const active = pods.filter(p => p.phase !== 'Error' && p.phase !== 'Completed');
  if (pods.some(p => p.phase === 'Completed')) { j.status = 'Complete'; j.doneAt = s.t; say(s, 'job/' + j.name + ' completed', 'ok'); return; }
  if (failed > JOB_BACKOFF_LIMIT) {
    j.status = 'Failed'; j.doneAt = s.t;
    active.forEach(p => terminate(s, p));
    say(s, 'job/' + j.name + ' failed: BackoffLimitExceeded (Job has reached the specified backoff limit)', 'err');
    return;
  }
  if (!active.length && s.t >= j.nextTry) {
    const plan = planCommand(j.command, j.name);
    makePod(s, {
      name: j.name + '-' + suffix(s), app: j.name, labels: { 'job-name': j.name }, image: j.image, owner: 'job/' + j.name,
      command: j.command, runFor: plan.runFor, willFail: plan.fail,
    });
    j.nextTry = s.t + 2 * (failed + 1);   // growing back-off between attempts
    s.cpPulse = 1;
  }
}

/** Parse the minute field of a cron expression into a period (seconds). Null = unsupported. */
export function cronPeriod(schedule: string): number | null {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const m = /^\*\/(\d+)$/.exec(f[0]);
  if (f[0] === '*') return MINUTE;
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 59) return Number(m[1]) * MINUTE;
  if (/^\d+$/.test(f[0]) && Number(f[0]) <= 59) return 60 * MINUTE;  // "at minute N of every hour"
  return null;
}

export function createCronJob(s: State, o: { name: string; schedule: string; image: string; command: string[] }): CronJob | null {
  const period = cronPeriod(o.schedule);
  if (period === null) return null;
  const c: CronJob = {
    ...o, period, suspend: false, createdAt: s.t, nextRun: s.t + period, lastSchedule: null, counter: 0,
  };
  s.cronjobs.push(c);
  return c;
}

function reconcileCron(s: State, c: CronJob): void {
  if (!c.suspend && s.t >= c.nextRun) {
    c.counter++;
    createJob(s, { name: c.name + '-' + (29000000 + c.counter), image: c.image, command: c.command, owner: c.name });
    c.lastSchedule = s.t; c.nextRun += c.period;
    say(s, '[cron] ' + c.name + ' created job ' + c.name + '-' + (29000000 + c.counter), 'dim');
  }
  // successfulJobsHistoryLimit: keep the 3 newest finished jobs
  const finished = s.jobs.filter(j => j.owner === c.name && j.status !== 'Running').sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0));
  for (const j of finished.slice(0, Math.max(0, finished.length - 3))) deleteJob(s, j);
}

function reconcile(s: State): void {
  for (const n of s.nodes) {
    if (n.down && s.t >= n.downUntil) { n.down = false; say(s, n.name + ' is back online (Ready).', 'ok'); }
    if (!n.announced && s.t >= n.bootUntil) { n.announced = true; say(s, n.name + ' joined the cluster (Ready).', 'ok'); }
  }
  s.peak.nodes = Math.max(s.peak.nodes || 0, s.nodes.length);
  for (const d of s.deployments) {
    reconcileDeployment(s, d);
    s.peak[d.name] = Math.max(s.peak[d.name] || 0, d.replicas);
  }
  for (const c of s.cronjobs.slice()) reconcileCron(s, c);
  for (const j of s.jobs.slice()) reconcileJob(s, j);
  schedule(s);
  // self-heal tracking for the tutorial
  if (s.flags.deletedOwned && !s.flags.selfHealed) {
    const d = depOf(s, s.flags.deletedOwned);
    if (d && readyCount(s, d.name) >= d.replicas && !s.pods.some(p => p.owner === d.name && p.phase === 'Terminating')) s.flags.selfHealed = true;
  }
}

function stepHpa(s: State): void {
  for (const h of s.hpas) {
    const d = depOf(s, h.dep);
    if (!d) continue;
    d.replicas = Math.max(h.min, Math.min(h.max, d.replicas));
    const run = s.pods.filter(p => p.owner === d.name && p.phase === 'Running');
    if (!run.length) continue;
    h.current = run.reduce((a, p) => a + p.util, 0) / run.length;
    let desired = Math.ceil(run.length * h.current / (h.cpu / 100) - 1e-6);
    if (h.current > 0.85) desired = Math.max(desired, Math.ceil(run.length * 1.6)); // saturated pods hide real demand
    desired = Math.max(h.min, Math.min(h.max, desired));
    h.recs = (h.recs || []).filter(r => s.t - r.t < 10);
    h.recs.push({ t: s.t, d: desired });
    const calm = Math.max(...h.recs.map(r => r.d)); // scale-in stabilisation window
    if (desired > d.replicas && s.t - h.lastScale >= 2) {
      d.replicas = desired; h.lastScale = s.t;
      say(s, '[hpa] ' + d.name + ' CPU at ' + Math.round(h.current * 100) + '% -> scaling out to ' + desired + ' replicas', 'warn');
    } else if (calm < d.replicas && s.t - h.lastScale >= 6) {
      d.replicas = calm; h.lastScale = s.t;
      say(s, '[hpa] ' + d.name + ' load dropped -> scaling in to ' + calm + ' replicas', 'warn');
    }
  }
}

// ---- events ---------------------------------------------------------------
export function nodeDown(s: State, name: string, dur: number, msg?: string): void {
  const n = s.nodes.find(x => x.name === name);
  if (!n) return;
  n.down = true; n.downUntil = s.t + dur;
  for (const p of s.pods) {
    if (p.node === name && p.phase !== 'Terminating') {
      p.phase = 'Unknown'; p.phaseT = 0;
      podEvent(s, p, 'Warning', 'NodeNotReady', 'Node ' + name + ' is not ready');
    }
  }
  banner(s, msg || (name + ' just lost power! (NotReady for ' + dur + 's)'));
}
export function reclaimSpot(s: State): void {
  const spots = s.nodes.filter(n => n.spot && !n.down && s.t >= n.bootUntil);
  if (!spots.length) { banner(s, 'The cloud provider reclaimed spot capacity. (You had none, lucky!)'); return; }
  const n = spots[0];
  nodeDown(s, n.name, 20, 'Spot instance ' + n.name + ' was reclaimed by the cloud provider! (back in 20s)');
}
export function setImage(s: State, depName: string, image: string): void {
  const d = depOf(s, depName);
  if (!d) return;
  d.image = image;
  recordRevision(d);
}

function stepEvents(s: State): void {
  (s.level.events || []).forEach((ev, i) => {
    if (s.evFired[i]) return;
    if (ev.at !== undefined) {
      if (s.tt >= ev.at) { s.evFired[i] = true; ev.run(s); }
    } else if (ev.when) {
      if (s.evArmed[i] === undefined && ev.when(s)) s.evArmed[i] = s.tt;
      if (s.evArmed[i] !== undefined && s.tt >= s.evArmed[i] + (ev.delay || 0)) { s.evFired[i] = true; ev.run(s); }
    }
  });
}

// ---- traffic --------------------------------------------------------------
export function endpoints(s: State, svc: Service): Pod[] {
  return s.pods.filter(p => selectorMatches(svc.selector, p.labels) && (p.phase === 'Running' || (p.phase === 'Unknown' && p.phaseT < STALE)));
}
/** The Service users call for a traffic profile. */
export const trafficService = (s: State, tr: Traffic): Service | undefined =>
  s.services.find(v => v.name === tr.app) ?? s.services.find(v => v.selector.app === tr.app);
const podLoad = (s: State, p: Pod): number => p.busy.length + s.reqs.filter(r => r.stage === 'toPod' && r.pod === p).length;

function failReq(s: State, r: Request, where: 'users' | 'svc' | 'pod'): void {
  r.dead = true;
  s.stats.failed++;
  if (s.level.econ) s.money.pen += s.level.econ.penalty;
  s.fx.push({ kind: 'fail', where, svc: r.svc, pod: r.pod, t: 0 });
}
function spawnRequest(s: State, tr: Traffic): void {
  s.stats.sent++;
  const svc = trafficService(s, tr);
  const r: Request = { stage: 'toSvc', t: 0, svc, pod: null, dead: false };
  if (!svc) { failReq(s, r, 'users'); return; }
  s.reqs.push(r);
}
function routeRequest(s: State, r: Request): void {
  const eps = r.svc ? endpoints(s, r.svc) : [];
  if (!eps.length) { failReq(s, r, 'svc'); return; }
  let pick = eps[Math.floor(s.rng() * eps.length)];
  if (pick.phase === 'Running' && podLoad(s, pick) >= CAP) {
    const alt = eps.filter(p => p.phase === 'Running' && podLoad(s, p) < CAP).sort((a, b) => podLoad(s, a) - podLoad(s, b))[0];
    if (alt) pick = alt;
  }
  r.pod = pick; r.stage = 'toPod'; r.t = 0;
}
function arriveAtPod(s: State, r: Request): void {
  const p = r.pod;
  if (!p || p.phase !== 'Running' || p.busy.length >= CAP) { failReq(s, r, 'pod'); return; }
  if (r.svc && r.svc.targetPort !== portOf(p.image)) { failReq(s, r, 'pod'); return; }   // connection refused
  p.busy.push(r);
  r.stage = 'proc'; r.t = 0; r.endAt = s.t + PROC * (0.8 + 0.4 * s.rng());
}
function stepReqs(s: State, dt: number): void {
  for (const r of s.reqs) {
    if (r.dead) continue;
    r.t += dt;
    if (r.stage === 'toSvc' && r.t >= T_SVC) routeRequest(s, r);
    else if (r.stage === 'toPod' && r.t >= T_POD) arriveAtPod(s, r);
    else if (r.stage === 'proc' && r.pod) {
      // a terminating pod finishes the requests it already accepted (graceful shutdown)
      if (r.pod.phase !== 'Running' && r.pod.phase !== 'Terminating') { r.pod.busy = r.pod.busy.filter(x => x !== r); failReq(s, r, 'pod'); }
      else if (r.endAt !== undefined && s.t >= r.endAt) {
        r.pod.busy = r.pod.busy.filter(x => x !== r);
        r.dead = true; s.stats.served++;
        if (s.level.econ) { s.money.rev += s.level.econ.price; s.recent.push(s.t); }
        s.fx.push({ kind: 'ok', where: 'pod', pod: r.pod, t: 0 });
      }
    }
  }
  s.reqs = s.reqs.filter(r => !r.dead);
  for (const f of s.fx) f.t += dt;
  s.fx = s.fx.filter(f => f.t < 0.9);
}
export function trafficRate(tr: Traffic, tt: number): number {
  for (const seg of tr.profile) if (tt >= seg.from && tt < seg.to) return seg.rps;
  return 0;
}

// ---- objectives & main step ----------------------------------------------
export function checkObjectives(s: State): void {
  for (const o of s.level.objectives) {
    if (s.done[o.id]) continue;
    let ok = false;
    try { ok = !!o.check(s); } catch { ok = false; }
    if (ok) { s.done[o.id] = true; say(s, '✔ Objective complete: ' + o.text, 'ok'); }
  }
  if (!s.outcome && s.level.objectives.every(o => s.done[o.id])) s.outcome = 'win';
}

export function step(s: State, dt: number): void {
  if (s.outcome) return;
  s.t += dt;
  const live = s.mode === 'live';
  const tr = s.level.traffic;
  const E = s.level.econ;
  if (live && tr) s.tt += dt;
  for (const p of s.pods.slice()) stepPod(s, p, dt);
  s.acc.recon += dt;
  if (s.acc.recon >= 0.4) { s.acc.recon = 0; reconcile(s); }
  s.acc.hpa += dt;
  if (s.acc.hpa >= 1) { s.acc.hpa = 0; stepHpa(s); }
  if (live && tr) {
    s.acc.spawn += trafficRate(tr, s.tt) * dt;
    while (s.acc.spawn >= 1) { s.acc.spawn -= 1; spawnRequest(s, tr); }
    stepEvents(s);
  }
  stepReqs(s, dt);
  if (E && live) s.money.cost += burnRate(s).total * dt;
  s.cpPulse = Math.max(0, s.cpPulse - dt * 1.5);
  s.acc.obj += dt;
  if (s.acc.obj >= 0.25) {
    s.acc.obj = 0;
    checkObjectives(s);
    if (!s.outcome && E && s.tt >= E.duration) {
      const miss = s.level.objectives.filter(o => !s.done[o.id]).map(o => o.text);
      s.outcome = 'fail';
      s.failReason = profit(s) < E.target
        ? 'The day is over: profit $' + profit(s).toFixed(2) + ' is below the $' + E.target.toFixed(2) + ' target.'
        : 'The day is over, but not every objective was met: ' + miss.join('; ') + '.';
    }
    if (!s.outcome && E && profit(s) < -E.bankrupt) {
      s.outcome = 'fail'; s.failReason = 'Bankrupt! You lost more than $' + E.bankrupt.toFixed(0) + '.';
    }
    if (!s.outcome && tr && s.stats.failed > tr.maxFail) {
      s.outcome = 'fail';
      s.failReason = 'Too many requests failed (' + s.stats.failed + '/' + tr.maxFail + ' allowed).';
    }
  }
}

/** Start-up: run controllers and fast-forward pod creation so seeded objects are already running. */
function settle(s: State): void {
  for (let i = 0; i < 4; i++) {
    reconcile(s);
    for (const p of s.pods) if (p.phase === 'ContainerCreating') finishCreating(s, p);
  }
  for (const p of s.pods) { p.age = 30; p.events.forEach(e => { e.t = -30; }); }
  s.t = 0;
}
