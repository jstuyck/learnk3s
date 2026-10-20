// Elite kubectl: structured output (-o json|yaml|name|jsonpath|custom-columns), --sort-by, --field-selector,
// bulk delete, rollout revisions, events filters, logs -l/--previous/--tail, top nodes.
import type { Ctx } from './ctx';
import { KIND, strFlag } from './ctx';
import { ageStr, depRows, matchesSelector, nodeRows, podIp, podRows, svcRows, topNodeRows, topRows } from './format';
import { keyOf, ownedPods, readyCount, terminate, tplOf } from './sim';
import { logsOfJob } from './cmd-batch';
import { systemPodCmd } from './system';
import type { ClusterNode, Deployment, Line, Pod, Service, State } from './types';

type Doc = Record<string, unknown>;

// ---- object documents (what `-o json` would print) ------------------------------------------------
/** The pod *phase* of the Kubernetes API, which is coarser than the STATUS column. */
export function podPhase(p: Pod): string {
  switch (p.phase) {
    case 'Running': case 'CrashLoopBackOff': case 'Terminating': return 'Running';
    case 'Completed': return 'Succeeded';
    case 'Error': return 'Failed';
    case 'Unknown': return 'Unknown';
    default: return 'Pending';
  }
}

const stamp = (seconds: number): string => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const pruneEmpty = (o: Doc): Doc => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

function podDoc(s: State, p: Pod): Doc {
  const waiting = p.phase === 'CrashLoopBackOff' || p.phase === 'ImagePullBackOff';
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: pruneEmpty({
      name: p.name, namespace: p.ns, labels: p.labels, creationTimestamp: stamp(s.t - p.age),
      ownerReferences: p.owner ? [{ kind: p.owner.startsWith('job/') ? 'Job' : 'ReplicaSet', name: p.owner.replace(/^.*\//, '') }] : undefined,
    }),
    spec: pruneEmpty({
      nodeName: p.node ?? p.ranOn ?? undefined,
      containers: [{
        name: p.app, image: p.image,
        resources: { requests: { cpu: p.cpuReq + 'm' }, limits: p.memLimit === null ? {} : { memory: p.memLimit + 'Mi' } },
      }],
    }),
    status: pruneEmpty({
      phase: podPhase(p), podIP: p.node ? podIp(s, p) : undefined,
      containerStatuses: [{
        name: p.app, image: p.image, ready: p.phase === 'Running', restartCount: p.restarts,
        state: waiting ? { waiting: { reason: p.phase } } : p.phase === 'Running' ? { running: {} } : { terminated: { reason: p.reason || p.phase } },
      }],
    }),
  };
}

function nodeDoc(s: State, n: ClusterNode): Doc {
  const ready = !n.down && s.t >= n.bootUntil;
  return {
    apiVersion: 'v1', kind: 'Node',
    metadata: { name: n.name, labels: { 'kubernetes.io/hostname': n.name, 'node.kubernetes.io/capacity-type': n.spot ? 'spot' : 'on-demand' } },
    spec: pruneEmpty({ unschedulable: n.unsched ? true : undefined }),
    status: { capacity: { pods: String(n.slots) }, allocatable: { pods: String(n.slots) }, conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
  };
}

function deploymentDoc(s: State, d: Deployment): Doc {
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: d.name, namespace: d.ns, labels: { app: d.app }, creationTimestamp: stamp(d.createdAt) },
    spec: {
      replicas: d.replicas, selector: { matchLabels: { app: d.app } },
      template: { metadata: { labels: { app: d.app } }, spec: { containers: [{ name: d.name, image: d.image, resources: { requests: { cpu: d.res.cpu + 'm' }, limits: d.res.mem === null ? {} : { memory: d.res.mem + 'Mi' } } }] } },
    },
    status: { replicas: ownedPods(s, d.key).length, readyReplicas: readyCount(s, d.key), updatedReplicas: ownedPods(s, d.key).filter(p => p.tpl === tplOf(d)).length },
  };
}

function serviceDoc(_s: State, v: Service): Doc {
  return {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: v.name, namespace: v.ns, creationTimestamp: stamp(v.createdAt) },
    spec: { type: v.nodePort ? 'NodePort' : 'ClusterIP', clusterIP: v.ip, selector: v.selector, ports: [pruneEmpty({ port: v.port, targetPort: v.targetPort, nodePort: v.nodePort, protocol: 'TCP' })] },
    status: { loadBalancer: {} },
  };
}

// ---- a small JSONPath ---------------------------------------------------------------------------------------
class PathError extends Error {}

function walk(root: unknown, path: string): unknown[] {
  let cur: unknown[] = [root];
  let rest = path.trim().replace(/^[@$]/, '');
  while (rest.length) {
    let m: RegExpExecArray | null;
    const next: unknown[] = [];
    if ((m = /^\[\?\(@((?:\.[\w-]+)+)\s*==\s*"?([^")]*)"?\)\]/.exec(rest))) {
      const sub = m[1]; const want = m[2];
      for (const x of cur) for (const item of Array.isArray(x) ? x : [x]) if (String(walk(item, sub)[0]) === want) next.push(item);
    } else if ((m = /^\[(\*|\d+)\]/.exec(rest))) {
      for (const x of cur) if (Array.isArray(x)) { if (m[1] === '*') next.push(...x); else if (x[Number(m[1])] !== undefined) next.push(x[Number(m[1])]); }
    } else if ((m = /^\['([^']*)'\]/.exec(rest)) || (m = /^\.((?:\\\.|[^.\[\]])+)/.exec(rest))) {
      const key = m[1].replace(/\\\./g, '.');
      for (const x of cur) if (x && typeof x === 'object' && !Array.isArray(x) && key in (x as Doc)) next.push((x as Doc)[key]);
    } else throw new PathError('unsupported expression near "' + rest + '"');
    cur = next;
    rest = rest.slice(m[0].length);
  }
  return cur;
}

const show = (v: unknown): string => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

type Node =
  | { k: 'text'; v: string }
  | { k: 'path'; v: string }
  | { k: 'range'; v: string; body: Node[] };

function parseTemplate(t: string): Node[] {
  const stack: Node[][] = [[]];
  const opens: { k: 'range'; v: string; body: Node[] }[] = [];
  let i = 0;
  const text = (v: string) => { if (v) stack[stack.length - 1].push({ k: 'text', v: v.replace(/\\n/g, '\n').replace(/\\t/g, '\t') }); };
  while (i < t.length) {
    const open = t.indexOf('{', i);
    if (open < 0) { text(t.slice(i)); break; }
    text(t.slice(i, open));
    const close = t.indexOf('}', open);
    if (close < 0) throw new PathError('unclosed action');
    const body = t.slice(open + 1, close).trim();
    i = close + 1;
    let m: RegExpExecArray | null;
    if ((m = /^range\s+(.+)$/.exec(body))) {
      const node = { k: 'range' as const, v: m[1], body: [] as Node[] };
      stack[stack.length - 1].push(node);
      opens.push(node); stack.push(node.body);
    } else if (body === 'end') {
      if (!opens.length) throw new PathError('unexpected {end}');
      opens.pop(); stack.pop();
    } else if ((m = /^"(.*)"$/.exec(body))) text(m[1]);
    else stack[stack.length - 1].push({ k: 'path', v: body });
  }
  if (opens.length) throw new PathError('missing {end}');
  return stack[0];
}

function render(nodes: Node[], ctx: unknown): string {
  let out = '';
  for (const n of nodes) {
    if (n.k === 'text') out += n.v;
    else if (n.k === 'path') out += walk(ctx, n.v).map(show).join(' ');
    else for (const item of walk(ctx, n.v)) out += render(n.body, item);
  }
  return out;
}

export function jsonpath(template: string, root: unknown): string {
  return render(parseTemplate(template.replace(/^'(.*)'$/s, '$1')), root);
}

// ---- yaml (just enough for these documents) ---------------------------------------------------------------------
function yamlScalar(v: unknown): string {
  if (typeof v !== 'string') return String(v);
  return v === '' || /^[\d.+-]+$/.test(v) || /^(true|false|null|yes|no)$/i.test(v) || /[:#{}[\],&*!|>'"%@`]/.test(v) ? JSON.stringify(v) : v;
}
export function toYaml(v: unknown, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return [pad + '[]'];
    return v.flatMap(x => {
      if (x && typeof x === 'object') {
        const inner = toYaml(x, indent + 2);
        return [pad + '- ' + inner[0].trimStart(), ...inner.slice(1)];
      }
      return [pad + '- ' + yamlScalar(x)];
    });
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Doc);
    if (!entries.length) return [pad + '{}'];
    return entries.flatMap(([k, x]) => {
      if (x && typeof x === 'object') {
        const empty = Array.isArray(x) ? x.length === 0 : Object.keys(x).length === 0;
        if (empty) return [pad + k + ': ' + (Array.isArray(x) ? '[]' : '{}')];
        return [pad + k + ':', ...toYaml(x, Array.isArray(x) ? indent : indent + 2)];
      }
      return [pad + k + ': ' + yamlScalar(x)];
    });
  }
  return [pad + yamlScalar(v)];
}

// ---- kubectl get with output formats, sort and field selectors ------------------------------------------------
const PHASE_FIELDS = ['status.phase', 'spec.nodeName', 'metadata.name', 'metadata.namespace'];
function fieldValue(p: Pod, field: string): string {
  switch (field) {
    case 'status.phase': return podPhase(p);
    case 'spec.nodeName': return p.node ?? p.ranOn ?? '';
    case 'metadata.name': return p.name;
    default: return 'default';
  }
}

function fieldSelect(c: Ctx, pods: Pod[], text: string): Pod[] | null {
  let out = pods;
  for (const term of text.split(',').filter(Boolean)) {
    const m = /^([\w.]+)(!=|==|=)(.*)$/.exec(term.trim());
    if (!m) { c.err('error: invalid field selector "' + term + '", expected field=value'); return null; }
    if (!PHASE_FIELDS.includes(m[1])) {
      c.err('Error from server (BadRequest): Unable to find "/v1, Resource=pods" that match label selector "", field selector "' + text + '": field label not supported: ' + m[1]);
      c.say('supported pod fields here: ' + PHASE_FIELDS.join(', '), 'dim');
      return null;
    }
    out = out.filter(p => (m![2] === '!=') !== (fieldValue(p, m![1]) === m![3]));
  }
  return out;
}

/** Sort documents by a JSONPath like .metadata.name or {.status.containerStatuses[0].restartCount}. */
function sortDocs<T>(c: Ctx, items: T[], docs: Doc[], path: string): T[] | null {
  const key = path.replace(/^\{(.*)\}$/, '$1');
  const keyed: { item: T; k: unknown }[] = [];
  for (let i = 0; i < items.length; i++) {
    let k: unknown;
    try { k = walk(docs[i], key)[0]; } catch { k = undefined; }
    if (k === undefined && items.length) {
      c.err('error: couldn\'t find any field with path "{' + key + '}" in the list of objects');
      return null;
    }
    keyed.push({ item: items[i], k });
  }
  keyed.sort((a, b) => (typeof a.k === 'number' && typeof b.k === 'number' ? a.k - b.k : String(a.k).localeCompare(String(b.k))));
  return keyed.map(x => x.item);
}

type Kinds = 'pod' | 'deployment' | 'node' | 'service';
const GETTABLE: Kinds[] = ['pod', 'deployment', 'node', 'service'];
const API_NAME: Record<Kinds, string> = { pod: 'pod', deployment: 'deployment.apps', node: 'node', service: 'service' };

/**
 * Handles `kubectl get` whenever it uses more than the plain table: -o name|json|yaml|jsonpath|custom-columns,
 * --sort-by, --field-selector, or a NAME. Returns false when the classic code path should run.
 */
export function getStructured(c: Ctx, kind: string): boolean {
  const { s, flags, pos } = c;
  const fmt = strFlag(flags.output);
  const structured = !!fmt && fmt !== 'wide';
  const sortBy = strFlag(flags['sort-by']);
  const fieldSel = strFlag(flags['field-selector']);
  const name = pos[1];
  if (!GETTABLE.includes(kind as Kinds)) return false;
  if (!structured && !sortBy && !fieldSel && !(kind === 'pod' && name)) return false;
  const k = kind as Kinds;
  if (fieldSel && k !== 'pod') { c.err('error: --field-selector is only supported for pods in this simulator'); return true; }
  const selector = strFlag(flags.selector);

  let items: unknown[];
  if (k === 'pod') {
    let pods = s.pods.filter(p => p.ns === c.ns && matchesSelector(p, selector));
    if (name) pods = pods.filter(p => p.name === name);
    if (fieldSel) { const f = fieldSelect(c, pods, fieldSel); if (!f) return true; pods = f; s.flags.usedFieldSelector = true; }
    items = pods;
  } else if (k === 'deployment') items = s.deployments.filter(d => d.ns === c.ns && (!name || d.name === name));
  else if (k === 'node') items = s.nodes.filter(n => !name || n.name === name);
  else items = s.services.filter(v => v.ns === c.ns && (!name || v.name === name));
  const docOf = (x: unknown): Doc => k === 'pod' ? podDoc(s, x as Pod) : k === 'deployment' ? deploymentDoc(s, x as Deployment) : k === 'node' ? nodeDoc(s, x as ClusterNode) : serviceDoc(s, x as Service);

  if (name && !items.length) { c.notFound(k, name); return true; }
  if (sortBy) {
    const sorted = sortDocs(c, items, items.map(docOf), sortBy);
    if (!sorted) return true;
    items = sorted; s.flags.usedSortBy = true;
  }
  if (k === 'pod') s.flags.usedGet = true;
  const docs = items.map(docOf);
  const single = !!name;
  const root: Doc = single ? docs[0] : { apiVersion: 'v1', kind: 'List', items: docs };

  if (!structured) {
    // plain table, but filtered / sorted
    if (k === 'pod') {
      const rows = podRows(s, fmt === 'wide', undefined, !!flags['show-labels'], items as Pod[]);
      if (rows.length === 1) c.say('No resources found in default namespace.', 'dim'); else c.emit(rows);
    } else if (sortBy) c.err('error: --sort-by on a table is only supported for pods in this simulator (use -o name, jsonpath or custom-columns)');
    else if (k === 'deployment') c.emit(depRows(s, fmt === 'wide'));
    else if (k === 'node') c.emit(nodeRows(s, !!flags['show-labels']));
    else c.emit(svcRows(s, fmt === 'wide'));
    return true;
  }

  if (fmt === 'name') {
    if (!items.length) c.say('No resources found in default namespace.', 'dim');
    docs.forEach(d => c.say(API_NAME[k] + '/' + (d.metadata as Doc).name));
    s.flags.usedOutputName = true;
  } else if (fmt === 'json') {
    JSON.stringify(root, null, 2).split('\n').forEach(l => c.say(l));
    s.flags.usedJsonYaml = true;
  } else if (fmt === 'yaml') {
    toYaml(root).forEach(l => c.say(l));
    s.flags.usedJsonYaml = true;
  } else if (fmt?.startsWith('jsonpath=')) {
    try { c.say(jsonpath(fmt.slice('jsonpath='.length), root)); } catch (e) {
      c.err('error: error parsing jsonpath ' + fmt.slice('jsonpath='.length) + ', ' + (e instanceof PathError ? e.message : 'invalid template'));
      return true;
    }
    s.flags.usedJsonpath = true;
  } else if (fmt?.startsWith('custom-columns=')) {
    const cols = fmt.slice('custom-columns='.length).split(',').map(x => x.split(/:(.*)/s));
    if (cols.some(x => x.length < 2 || !x[0] || !x[1])) { c.err('error: custom-columns format must be NAME:.json.path[,NAME:.json.path]'); return true; }
    const rows: (string | number)[][] = [cols.map(x => x[0])];
    try {
      for (const d of docs) rows.push(cols.map(x => { const v = walk(d, x[1]); return v.length ? v.map(show).join(',') : '<none>'; }));
    } catch (e) { c.err('error: ' + (e instanceof PathError ? e.message : 'invalid column path')); return true; }
    c.emit(rows);
    s.flags.usedCustomColumns = true;
  } else {
    c.err('error: unable to match a printer suitable for the output format "' + fmt + '", allowed formats are: custom-columns,json,jsonpath,name,wide,yaml');
  }
  return true;
}

// ---- bulk delete ----------------------------------------------------------------------------------------------------------
/** kubectl delete pods a b c | pods -l sel | pods --all | pods --field-selector=... ; true when handled. */
export function deleteBulk(c: Ctx): boolean {
  const { s, pos, flags } = c;
  const selector = strFlag(flags.selector);
  const fieldSel = strFlag(flags['field-selector']);
  const slash = pos.length > 1 && pos.every(x => x.includes('/') && KIND[x.split('/')[0]] === 'pod');
  const kindWord = slash ? 'pod' : pos[0];
  if (KIND[kindWord] !== 'pod') return false;
  const names = slash ? pos.map(x => x.split('/')[1]) : pos.slice(1);
  if (!selector && !fieldSel && !flags.all && names.length < 2) return false;
  if ((selector || fieldSel || flags.all) && names.length) { c.err('error: cannot specify pod names together with --all, -l or --field-selector'); return true; }

  let targets: Pod[];
  if (names.length) {
    targets = [];
    for (const n of names) { const p = c.findPod(n); if (!p || p.phase === 'Terminating') { c.notFound('pod', n); return true; } targets.push(p); }
  } else {
    targets = s.pods.filter(p => p.ns === c.ns && p.phase !== 'Terminating' && matchesSelector(p, selector));
    if (fieldSel) { const f = fieldSelect(c, targets, fieldSel); if (!f) return true; targets = f; }
  }
  if (!targets.length) { c.say('No resources found', 'dim'); return true; }
  for (const p of targets) {
    if (p.owner) s.flags.deletedOwned = p.owner; else s.flags.deletedBare = true;
    terminate(s, p);
    c.ok('pod "' + p.name + '" deleted');
  }
  s.flags.bulkDeleted = Math.max(s.flags.bulkDeleted ?? 0, targets.length);
  s.cpPulse = 1;
  return true;
}

// ---- rollout history --revision / undo --to-revision ---------------------------------------------------------------
export function rolloutRevisions(c: Ctx, sub: string, d: Deployment): boolean {
  const { s, flags } = c;
  if (sub === 'history' && flags.revision !== undefined) {
    const n = Number(flags.revision);
    const h = d.history[n - 1];
    if (!Number.isInteger(n) || !h) { c.err('error: unable to find the specified revision'); return true; }
    c.say('deployment.apps/' + d.name + ' with revision #' + n);
    c.say('Pod Template:');
    c.say('  Image:       ' + h.image);
    c.say('  Requests:    cpu ' + h.res.cpu + 'm');
    c.say('  Limits:      ' + (h.res.mem === null ? '<none>' : 'memory ' + h.res.mem + 'Mi'));
    c.say('  Env from:    ' + ([h.config && 'ConfigMap/' + h.config, h.secret && 'Secret/' + h.secret].filter(Boolean).join(', ') || '<none>'));
    s.flags.inspectedRevision = true;
    return true;
  }
  if (sub === 'undo' && flags['to-revision'] !== undefined) {
    const n = Number(flags['to-revision']);
    const h = d.history[n - 1];
    if (!Number.isInteger(n) || !h) { c.err('error: unable to find specified revision ' + String(flags['to-revision']) + ' in history'); return true; }
    if (n === d.history.length) { c.say('deployment.apps/' + d.name + ' skipped rollback (current template already matches revision ' + n + ')', 'dim'); return true; }
    d.history.length = n;
    d.image = h.image; d.config = h.config; d.secret = h.secret; d.res = { ...h.res }; d.restart = h.restart;
    if (!d.frozen) d.rollouts++;
    s.flags.undone = true; s.flags.undoneToRevision = n; s.cpPulse = 1;
    c.ok('deployment.apps/' + d.name + ' rolled back to revision ' + n + ' (' + h.image + ')');
    return true;
  }
  return false;
}

// ---- kubectl events -----------------------------------------------------------------------------------------------------------
export function eventsCmd(c: Ctx): void {
  const { s, flags, pos } = c;
  const types = strFlag(flags.types)?.split(',').map(x => x.trim().toLowerCase());
  if (types && types.some(t => t !== 'normal' && t !== 'warning')) { c.err('error: --types must be Normal and/or Warning'); return; }
  const forArg = strFlag(flags.for) ?? (pos[0]?.includes('/') ? pos[0] : undefined);
  let pods = s.pods.filter(p => p.ns === c.ns);
  if (forArg) {
    const [kindW, nameW] = forArg.includes('/') ? forArg.split('/') : ['pod', forArg];
    if (KIND[kindW] === 'pod') pods = s.pods.filter(p => p.name === nameW && p.ns === c.ns);
    else if (KIND[kindW] === 'deployment') pods = s.pods.filter(p => p.owner === keyOf(c.ns, nameW));
    else { c.err('error: --for supports pod/NAME and deployment/NAME in this simulator'); return; }
    if (!pods.length) { c.notFound(KIND[kindW] ?? kindW, nameW); return; }
  }
  let evs = pods.flatMap(p => p.events.map(e => ({ p, e }))).sort((x, y) => x.e.t - y.e.t);
  if (types) evs = evs.filter(x => types.includes(x.e.type.toLowerCase()));
  if (types || forArg) s.flags.filteredEvents = true;
  if (!evs.length) { c.say('No events found in default namespace.', 'dim'); return; }
  c.emit([['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'] as (string | number)[]].concat(evs.slice(-25).map(({ p, e }) => [ageStr(s, e.t), e.type, e.reason, 'Pod/' + p.name, e.msg])));
}

// ---- kubectl logs -----------------------------------------------------------------------------------------------------------------
const isCrashed = (p: Pod) => p.phase === 'CrashLoopBackOff' || p.phase === 'ImagePullBackOff' || p.phase === 'Error';

function podLog(p: Pod): Line[] {
  if (p.phase === 'Running' && p.runFor === undefined) {
    return [3, 2, 1].map(i => ({ t: '10.244.0.' + (p.id % 200 + 1) + ' - "GET / HTTP/1.1" 200 612   (' + i * 2 + 's ago)', c: 'dim' }));
  }
  if (p.phase === 'Completed') return p.logs.map(t => ({ t }));
  if (p.reason === 'OOMKilled') return [{ t: '(no output: the container was OOMKilled before it logged anything; see: kubectl describe pod ' + p.name + ')', c: 'warn' }];
  if (p.logs.length) return p.logs.map(t => ({ t, c: 'err' }));
  return [{ t: 'container "' + p.image + '" is not running yet (status: ' + p.phase + ')', c: 'warn' }];
}

export function logsCmd(c: Ctx): void {
  const { s, pos, flags } = c;
  const target = pos[0];
  if (systemPodCmd(c, 'logs', target)) return;
  const selector = strFlag(flags.selector);
  const tailRaw = strFlag(flags.tail);
  const tail = tailRaw === undefined ? undefined : Number(tailRaw);
  if (tail !== undefined && (!Number.isInteger(tail) || tail < 0)) { c.err('error: --tail must be a whole number'); return; }
  if (target?.startsWith('job/')) { logsOfJob(c, target.slice(4)); return; }

  let pods: Pod[];
  if (selector) {
    pods = s.pods.filter(p => p.ns === c.ns && p.phase !== 'Terminating' && matchesSelector(p, selector));
    if (!pods.length) { c.say('No resources found in ' + c.ns + ' namespace.', 'dim'); return; }
    s.flags.usedLogsSelector = true;
  } else if (target && /^(deploy|deployment)\//.test(target)) {
    const dn = target.split('/')[1];
    const dep = c.getDep(dn);
    if (!dep) return;
    pods = ownedPods(s, dep.key);
    if (!pods.length) { c.err('error: deployment "' + dn + '" has no pods'); return; }
    // like kubectl, logs of a Deployment come from one of its pods: prefer one that is in trouble
    pods = [pods.find(isCrashed) ?? pods[0]];
    c.say('Found ' + ownedPods(s, dep.key).length + ' pods, using pod/' + pods[0].name, 'dim');
  } else {
    const p = target ? c.findPod(target) : undefined;
    if (!p) { if (target) c.notFound('pod', target); else c.err('usage: kubectl logs POD | deployment/NAME | -l selector'); return; }
    pods = [p];
  }
  const prefix = pods.length > 1;
  for (const p of pods) {
    if (isCrashed(p)) s.flags.inspectedCrash = true;
    if (p.owner?.startsWith('job/')) s.flags.readJobLogs = true;
    if (p.phase === 'Running') s.flags.readPodLogs = true;
    if (flags.previous) {
      if (!isCrashed(p) && p.restarts === 0) { c.err('Error from server (BadRequest): previous terminated container "' + p.app + '" in pod "' + p.name + '" not found'); continue; }
      s.flags.usedPrevious = true;
    }
    let lines = podLog(p);
    if (tail !== undefined) lines = lines.slice(Math.max(0, lines.length - tail));
    for (const l of lines) c.say((prefix ? '[pod/' + p.name + '] ' : '') + l.t, l.c);
  }
}

// ---- kubectl top ------------------------------------------------------------------------------------------------------------------------
export function topCmd(c: Ctx): void {
  const { s, pos, flags } = c;
  const what = KIND[pos[0]];
  const sortBy = strFlag(flags['sort-by']);
  if (sortBy && sortBy !== 'cpu' && sortBy !== 'memory') { c.err('error: --sort-by accepts only cpu or memory'); return; }
  if (what === 'node') {
    c.emit(topNodeRows(s));
    s.flags.usedTopNodes = true;
    return;
  }
  if (what !== 'pod') { c.err('error: You must specify the type of resource to get. Valid resource types include pods, nodes'); return; }
  const rows = topRows(s, sortBy as 'cpu' | 'memory' | undefined, c.ns);
  if (sortBy) s.flags.usedTopSort = true;
  if (rows.length === 1) c.say('No resources found in default namespace.', 'dim'); else c.emit(rows);
}
