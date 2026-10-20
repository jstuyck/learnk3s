// Namespaces and the cluster's own pods (kube-system). System pods are derived from the nodes on demand, so they never
// compete with workloads for slots; they exist so that `kubectl get pods -A`, `-n kube-system` and `get ns` look real.
import type { Ctx } from './ctx';
import { strFlag } from './ctx';
import { depRows, endpointRows, fmtAge, podRows, svcRows } from './format';
import { terminate } from './sim';
import type { State } from './types';

type Row = (string | number)[];

export const BASE_NAMESPACES = ['default', 'kube-node-lease', 'kube-public', 'kube-system'];
const CLUSTER_AGE = 3 * 86400 + 4 * 3600;

export interface SysPod {
  name: string;
  app: string;
  status: string;
  ready: string;
  restarts: number;
  node: string;
  image: string;
  /** Deployment / DaemonSet that owns it, or null for a static pod */
  owner: string | null;
  labels: string;
  logs: string[];
}

const hash = (text: string, len = 5): string => {
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = 'bcdfghjklmnpqrstvwxz2456789';
  let r = '';
  for (let i = 0; i < len; i++) { r += a[h % a.length]; h = Math.floor(h / a.length) + i * 7 + 3; }
  return r;
};

/** The pods Kubernetes itself runs in kube-system (none in the Hard Way: there, the components are systemd services). */
export function systemPods(s: State): SysPod[] {
  if (s.level.hardway) return [];
  const nodes = s.nodes.filter(n => s.t >= n.bootUntil);
  if (!nodes.length) return [];
  const cp = s.nodes[0].name;
  const pods: SysPod[] = [];
  const up = (node: string) => { const n = s.nodes.find(x => x.name === node); return !!n && !n.down; };
  const add = (p: Omit<SysPod, 'status' | 'ready' | 'restarts'>) => pods.push({ ...p, status: up(p.node) ? 'Running' : 'Unknown', ready: up(p.node) ? '1/1' : '0/1', restarts: 0 });
  nodes.slice(0, 2).forEach((n, i) => add({
    name: 'coredns-7c65d6cfc9-' + hash('coredns' + i), app: 'coredns', node: n.name, image: 'registry.k8s.io/coredns/coredns:v1.11.3',
    owner: 'coredns', labels: 'k8s-app=kube-dns',
    logs: ['.:53', '[INFO] plugin/reload: Running configuration SHA512 = 591cf328cccc12bc490481273e738df59329c62c0b729d94e8b61db9961c2fa5f046dd37f1cf888b953814040d180f52594972691cd6ff41be96639138a43908', 'CoreDNS-1.11.3', 'linux/amd64, go1.21.11, a6338e9'],
  }));
  for (const [app, image, flags] of [
    ['etcd', 'registry.k8s.io/etcd:3.5.15-0', '"serving metrics on 127.0.0.1:2381"'],
    ['kube-apiserver', 'registry.k8s.io/kube-apiserver:v1.30.2', '"Serving securely on [::]:6443"'],
    ['kube-controller-manager', 'registry.k8s.io/kube-controller-manager:v1.30.2', '"Started controller" controller="deployment-controller"'],
    ['kube-scheduler', 'registry.k8s.io/kube-scheduler:v1.30.2', '"Starting Kubernetes Scheduler" version="v1.30.2"'],
  ] as const) {
    add({ name: app + '-' + cp, app, node: cp, image, owner: null, labels: 'component=' + app + ',tier=control-plane', logs: ['I1019 06:51:02.114 1 ' + flags] });
  }
  for (const n of nodes) {
    add({ name: 'kube-proxy-' + hash('proxy' + n.name), app: 'kube-proxy', node: n.name, image: 'registry.k8s.io/kube-proxy:v1.30.2', owner: 'kube-proxy', labels: 'k8s-app=kube-proxy', logs: ['I1019 06:51:07.201 1 server_linux.go:69] "Using iptables proxy"', 'I1019 06:51:07.388 1 shared_informer.go:320] Caches are synced for service config'] });
    add({ name: 'kindnet-' + hash('kindnet' + n.name), app: 'kindnet', node: n.name, image: 'docker.io/kindest/kindnetd:v20240813', owner: 'kindnet', labels: 'app=kindnet', logs: ['I1019 06:51:09.870 1 main.go:299] Handling node with IPs: {10.244.0.1}'] });
  }
  return pods;
}

export const namespaces = (s: State): string[] => BASE_NAMESPACES.concat(s.namespaces ?? []).sort((a, b) => a.localeCompare(b));

const age = (s: State): string => fmtAge(s.t + CLUSTER_AGE);
const sysRows = (s: State, wide: boolean): Row[] => systemPods(s).map(p => ['kube-system', p.name, p.ready, p.status, p.restarts, age(s), ...(wide ? ['10.244.' + (s.nodes.findIndex(n => n.name === p.node) + 1) + '.' + (p.name.length + 2), p.node] : [])]);

const depSys = (s: State): Row[] => (systemPods(s).some(p => p.owner === 'coredns')
  ? [['kube-system', 'coredns', systemPods(s).filter(p => p.app === 'coredns' && p.status === 'Running').length + '/' + systemPods(s).filter(p => p.app === 'coredns').length, systemPods(s).filter(p => p.app === 'coredns').length, systemPods(s).filter(p => p.app === 'coredns' && p.status === 'Running').length, age(s)]]
  : []);
const dsSys = (s: State): Row[] => ['kube-proxy', 'kindnet'].filter(a => systemPods(s).some(p => p.app === a)).map(a => {
  const n = systemPods(s).filter(p => p.app === a);
  const r = n.filter(p => p.status === 'Running').length;
  return ['kube-system', a, n.length, n.length, r, n.length, r, a === 'kube-proxy' ? 'kubernetes.io/os=linux' : '<none>', age(s)];
});
const svcSys = (s: State): Row[] => (systemPods(s).length ? [['kube-system', 'kube-dns', 'ClusterIP', '10.96.0.10', '<none>', '53/UDP,53/TCP,9153/TCP', age(s)]] : []);

/** Prefix every data row of a user table with its namespace column. */
const prefix = (rows: Row[], ns: string): Row[] => rows.slice(1).map(r => [ns, ...r]);

const quotaUsed = (s: State, ns: string): number => s.pods.filter(p => p.ns === ns && p.phase !== 'Terminating' && p.phase !== 'Completed' && p.phase !== 'Error').length;

/** kubectl get with -n / -A (or the context's namespace), plus namespaces, daemonsets and quotas. Returns true when it handled the command. */
export function getNamespaced(c: Ctx, kind: string): boolean {
  const { s, flags, pos } = c;
  const all = !!flags['all-namespaces'];
  const ns = c.ns;
  const wide = flags.output === 'wide';
  const emit = (head: Row, rows: Row[]) => {
    if (!rows.length) c.say(all ? 'No resources found' : 'No resources found in ' + ns + ' namespace.', 'dim');
    else c.emit([head, ...rows]);
  };
  if (kind === 'namespace') {
    const name = pos[1];
    const list = namespaces(s).filter(n => !name || n === name);
    if (name && !list.length) { c.notFound('namespace', name); return true; }
    c.emit([['NAME', 'STATUS', 'AGE'] as Row].concat(list.map(n => [n, 'Active', BASE_NAMESPACES.includes(n) ? age(s) : '1m'])));
    s.flags.listedNamespaces = true;
    return true;
  }
  if (!all && ns === 'default' && kind !== 'daemonset' && kind !== 'quota') return false;
  const sys = all || ns === 'kube-system';
  const userNs = all ? namespaces(s).filter(n => n !== 'kube-system') : sys ? [] : [ns];
  s.flags.usedAllNamespaces = s.flags.usedAllNamespaces || all;
  if (sys) {
    s.flags.listedSystemPods = s.flags.listedSystemPods || (kind === 'pod' || kind === 'all');
    if (!all && (kind === 'pod' || kind === 'all')) s.flags.listedKubeSystem = true;
    if (wide && kind === 'pod') s.flags.usedWideSystem = true;
    if (kind === 'service') s.flags.listedKubeDns = true;
  }
  const podHead: Row = ['NAMESPACE', 'NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE'] : [])];
  const depHead: Row = ['NAMESPACE', 'NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'];
  const svcHead: Row = ['NAMESPACE', 'NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'];
  const dsHead: Row = ['NAMESPACE', 'NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE'];
  const rqHead: Row = ['NAMESPACE', 'NAME', 'AGE', 'REQUEST', 'LIMIT'];
  const strip = (rows: Row[]): Row[] => (all ? rows : rows.map(r => r.slice(1)));
  const head = (h: Row): Row => (all ? h : h.slice(1));
  const selector = strFlag(flags.selector);
  const podData = (): Row[] => [
    ...userNs.flatMap(n => prefix(podRows(s, wide, selector, false, s.pods.filter(p => p.ns === n)), n)),
    ...(sys && !selector ? sysRows(s, wide) : []),
  ];
  const lines: { title?: string; head: Row; rows: Row[] }[] = [];
  if (kind === 'pod' || kind === 'all') lines.push({ title: 'pod', head: head(podHead), rows: strip(podData()) });
  if (kind === 'service' || kind === 'all') lines.push({ title: 'service', head: head(svcHead), rows: strip([...userNs.flatMap(n => prefix(svcRows(s, false, n), n)), ...(sys ? svcSys(s) : [])]) });
  if (kind === 'daemonset' || kind === 'all') lines.push({ title: 'daemonset', head: head(dsHead), rows: strip(sys ? dsSys(s) : []) });
  if (kind === 'deployment' || kind === 'all') lines.push({ title: 'deployment', head: head(depHead), rows: strip([...userNs.flatMap(n => prefix(depRows(s, false, n), n)), ...(sys ? depSys(s) : [])]) });
  if (kind === 'endpoints') lines.push({ head: head(['NAMESPACE', 'NAME', 'ENDPOINTS', 'AGE']), rows: strip(userNs.flatMap(n => prefix(endpointRows(s, n), n))) });
  if (kind === 'quota') {
    lines.push({
      head: head(rqHead),
      rows: strip(s.quotas.filter(q => all || q.ns === ns).map(q => [q.ns, q.name, fmtAge(s.t - q.createdAt), 'pods: ' + quotaUsed(s, q.ns) + '/' + q.pods, ''])),
    });
  }
  if (!lines.length) {
    if (ns !== 'default' && !all) { c.say('No resources found in ' + ns + ' namespace.', 'dim'); return true; }
    return false;   // kinds we do not model per namespace: classic output
  }
  lines.forEach((l, i) => {
    if (kind === 'all' && !l.rows.length) return;
    if (kind === 'all' && i > 0) c.say('');
    if (kind === 'all') c.say(l.title + 's', 'dim');
    emit(l.head, l.rows);
  });
  return true;
}

const findSys = (s: State, name: string): SysPod | undefined => systemPods(s).find(p => p.name === name);

/** describe / logs for pods in kube-system. Returns true when the command targeted another namespace than default's user objects. */
export function systemPodCmd(c: Ctx, what: 'describe' | 'logs', name: string | undefined): boolean {
  const { s } = c;
  if (c.ns !== 'kube-system') return false;
  const p = name ? findSys(s, name) : undefined;
  if (!p) { c.notFound('pod', name ?? ''); return true; }
  s.flags.inspectedSystemPod = true;
  if (what === 'logs') { p.logs.forEach(l => c.say(l)); return true; }
  [
    'Name:             ' + p.name,
    'Namespace:        kube-system',
    'Node:             ' + p.node,
    'Labels:           ' + p.labels,
    'Status:           ' + p.status,
    'Controlled By:    ' + (p.owner ? (p.owner === 'coredns' ? 'ReplicaSet/' : 'DaemonSet/') + p.owner : 'Node/' + p.node + '  (static pod)'),
    'Image:            ' + p.image,
    'Restart Count:    ' + p.restarts,
    'Priority Class:   system-cluster-critical',
  ].forEach(l => c.say(l));
  c.say('Events:  <none>');
  return true;
}

/** create / delete namespace. Deleting a namespace deletes everything inside it. */
export function namespaceCmd(c: Ctx, verb: 'create' | 'delete', name: string | undefined): void {
  const { s } = c;
  if (!name) { c.err('error: exactly one NAME is required, got 0'); return; }
  s.namespaces ??= [];
  if (verb === 'create') {
    if (namespaces(s).includes(name)) { c.err('Error from server (AlreadyExists): namespaces "' + name + '" already exists'); return; }
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) { c.err('The Namespace "' + name + '" is invalid: metadata.name: a lowercase RFC 1123 label is required'); return; }
    s.namespaces.push(name);
    s.flags.createdNamespace = true;
    c.ok('namespace/' + name + ' created');
    return;
  }
  if (BASE_NAMESPACES.includes(name)) { s.flags.triedDeleteSystem = true; c.err('Error from server (Forbidden): namespaces "' + name + '" is forbidden: this namespace may not be deleted'); return; }
  if (!s.namespaces.includes(name)) { c.notFound('namespace', name); return; }
  const inside = s.pods.filter(p => p.ns === name && p.phase !== 'Terminating').length + s.deployments.filter(d => d.ns === name).length + s.services.filter(v => v.ns === name).length;
  s.deployments = s.deployments.filter(d => d.ns !== name);
  s.services = s.services.filter(v => v.ns !== name);
  s.quotas = s.quotas.filter(q => q.ns !== name);
  for (const p of s.pods.filter(x => x.ns === name)) terminate(s, p);
  s.namespaces = s.namespaces.filter(n => n !== name);
  if (s.ctxNs === name) s.ctxNs = 'default';
  s.flags.deletedNamespace = true;
  c.ok('namespace "' + name + '" deleted');
  if (inside) c.say('everything inside it went with it: ' + inside + ' object' + (inside === 1 ? '' : 's') + ' (pods, Deployments, Services, quotas)', 'dim');
}

/** create / delete resourcequota. */
export function quotaCmd(c: Ctx, verb: 'create' | 'delete', name: string | undefined): void {
  const { s } = c;
  if (!name) { c.err('error: exactly one NAME is required, got 0'); return; }
  if (verb === 'delete') {
    const n = s.quotas.length;
    s.quotas = s.quotas.filter(q => !(q.name === name && q.ns === c.ns));
    if (s.quotas.length === n) { c.notFound('resourcequota', name); return; }
    c.ok('resourcequota "' + name + '" deleted');
    return;
  }
  const hard = strFlag(c.flags.hard);
  const m = hard ? /^pods=(\d+)$/.exec(hard) : null;
  if (!m) { c.err('error: --hard=pods=N is required (this simulator limits the number of pods per namespace)'); return; }
  if (s.quotas.some(q => q.name === name && q.ns === c.ns)) { c.err('Error from server (AlreadyExists): resourcequotas "' + name + '" already exists'); return; }
  s.quotas.push({ name, ns: c.ns, pods: Number(m[1]), createdAt: s.t });
  s.flags.createdQuota = true;
  c.ok('resourcequota/' + name + ' created');
}

export function describeQuota(c: Ctx, name: string): void {
  const { s } = c;
  const q = s.quotas.find(x => x.name === name && x.ns === c.ns);
  if (!q) { c.notFound('resourcequota', name); return; }
  s.flags.describedQuota = true;
  c.say('Name:       ' + q.name);
  c.say('Namespace:  ' + q.ns);
  c.emit([['Resource', 'Used', 'Hard'], ['--------', '----', '----'], ['pods', quotaUsed(s, q.ns), q.pods]]);
}

/** kubectl config: the current namespace of the context. */
export function configCmd(c: Ctx): void {
  const { s, pos, flags } = c;
  const sub = pos[0];
  const ctxName = 'learnk3s';
  if (sub === 'set-context') {
    if (!flags.current) { c.err('error: this simulator supports: kubectl config set-context --current --namespace=NAME'); return; }
    const ns = strFlag(flags.namespace);
    if (!ns) { c.err('error: --namespace is required'); return; }
    if (!namespaces(s).includes(ns)) { c.say('warning: namespace "' + ns + '" does not exist (yet); commands will fail until it does', 'warn'); }
    s.ctxNs = ns;
    s.flags.switchedNamespace = ns;
    c.ok('Context "' + ctxName + '" modified.');
  } else if (sub === 'get-contexts') {
    s.flags.viewedContext = true;
    c.emit([['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ['*', ctxName, ctxName, ctxName, s.ctxNs === 'default' ? '' : s.ctxNs]]);
  } else if (sub === 'current-context') {
    s.flags.viewedContext = true;
    c.say(ctxName);
  } else if (sub === 'view') {
    s.flags.viewedContext = true;
    ['apiVersion: v1', 'kind: Config', 'current-context: ' + ctxName, 'contexts:', '- context:', '    cluster: ' + ctxName, ...(s.ctxNs !== 'default' ? ['    namespace: ' + s.ctxNs] : []), '    user: ' + ctxName, '  name: ' + ctxName].forEach(l => c.say(l));
  } else c.err('error: supported: kubectl config set-context --current --namespace=NS | get-contexts | current-context | view');
}

export const NS_SYSTEM = 'error: kube-system belongs to the cluster; you can look at it (get, describe, logs) but not change it';
export const NS_LIMIT = 'error: in this simulator Jobs, CronJobs, ConfigMaps, Secrets and autoscalers live in the default namespace (Pods, Deployments, Services and quotas work in any namespace)';
