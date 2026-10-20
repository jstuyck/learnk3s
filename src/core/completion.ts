// Tab completion for the in-game terminal. Pure function, easy to test.
import { IMAGES } from '../data/images';
import { KIND, SUPPORTED } from './cli';
import { listDir, normalize } from './hardway';
import { namespaces } from './system';
import type { State } from './types';

export interface Completion {
  /** index in the line where the completed token starts */
  start: number;
  options: string[];
}

const VERBS = SUPPORTED.slice();
const KINDS = ['pods', 'deployments', 'services', 'nodes', 'configmaps', 'secrets', 'hpa', 'endpoints', 'jobs', 'cronjobs', 'namespaces', 'daemonsets'];
const ALIASES = ['po', 'deploy', 'svc', 'cm', 'no', 'ep', 'cj'];
const FLAGS: Record<string, string[]> = {
  run: ['--image=', '--labels=app=', '--restart=Never'],
  create: ['--image=', '--replicas=', '--from-literal=', '--schedule=', '--from=cronjob/'],
  expose: ['--port=', '--target-port=', '--name='],
  autoscale: ['--min=', '--max=', '--cpu-percent='],
  set: ['--from=configmap/', '--from=secret/', '--requests=cpu=', '--limits=memory='],
  label: ['--overwrite', '--selector='],
  patch: ['--patch='],
  get: ['--output=', '--selector=', '--show-labels', '--sort-by=', '--field-selector='],
  delete: ['--selector=', '--all', '--field-selector='],
  scale: ['--replicas=', '--current-replicas='],
  rollout: ['--revision=', '--to-revision='],
  logs: ['--previous', '--tail=', '--selector='],
  events: ['--types=Warning', '--for=pod/'],
  top: ['--sort-by=cpu', '--sort-by=memory'],
  drain: ['--ignore-daemonsets'],
};
const ANY_VERB_FLAGS = ['--help'];
const OUTPUTS = ['wide', 'name', 'json', 'yaml', 'jsonpath=', 'custom-columns='];

export function completeLine(s: State, line: string): Completion {
  const cur = /(\S*)$/.exec(line)![1];
  const start = line.length - cur.length;
  const prev = line.slice(0, start).split(/\s+/).filter(Boolean);
  const pick = (list: string[]) => list.filter(x => x.startsWith(cur));
  const res = (options: string[]): Completion => ({ start, options });

  if (s.hw && prev[0] !== 'kubectl') return completeHw(s, prev, cur, start);
  if (!prev.length) return res(pick(['kubectl', 'k', 'cloud', 'help', 'clear']));

  const nsTok = prev.findIndex(x => x === '-n' || x === '--namespace');
  const curNs = (nsTok >= 0 ? prev[nsTok + 1] : prev.find(x => x.startsWith('--namespace='))?.slice(12)) ?? s.ctxNs ?? 'default';
  const names = {
    quota: s.quotas.filter(q => q.ns === curNs).map(q => q.name),
    endpoints: s.services.filter(v => v.ns === curNs).map(v => v.name),
    job: s.jobs.map(j => j.name),
    cronjob: s.cronjobs.map(c => c.name),
    pod: s.pods.filter(p => p.ns === curNs && p.phase !== 'Terminating').map(p => p.name),
    deployment: s.deployments.filter(d => d.ns === curNs).map(d => d.name),
    service: s.services.filter(v => v.ns === curNs).map(v => v.name),
    configmap: s.configmaps.map(c => c.name),
    secret: s.secrets.map(c => c.name),
    hpa: s.hpas.map(h => h.dep),
    node: s.nodes.map(n => n.name),
    namespace: namespaces(s),
    daemonset: ['kube-proxy', 'kindnet'],
  };
  const last = prev[prev.length - 1];
  if (last === '-o') return res(pick(OUTPUTS));
  if (last === '-n') return res(pick(['default']));

  if (prev[0] === 'cloud') {
    const rest = prev.slice(1);
    if (!rest.length) return res(pick(['add-node', 'remove-node', 'list-nodes', 'cost']));
    if (rest[0] === 'add-node') return res(pick(['--spot']));
    if (rest[0] === 'remove-node' && rest.length === 1) return res(pick(names.node));
    return res([]);
  }
  if (prev[0] !== 'kubectl' && prev[0] !== 'k') return res([]);

  const rest = prev.slice(1);
  if (!rest.length) return res(pick(VERBS));
  const verb = rest[0];

  if (cur === '-' || cur === '-o') return res(pick(['-o']));
  if (cur.startsWith('--')) {
    const eq = cur.indexOf('=');
    if (eq < 0) return res(pick((FLAGS[verb] || []).concat(ANY_VERB_FLAGS)));
    const key = cur.slice(0, eq + 1);
    const val = cur.slice(eq + 1);
    const vals = key === '--output=' ? OUTPUTS : key === '--types=' ? ['Warning', 'Normal'] : key === '--sort-by=' && verb === 'top' ? ['cpu', 'memory'] : key === '--image='
      ? Object.keys(IMAGES)
      : key === '--from='
        ? names.configmap.map(n => 'configmap/' + n).concat(names.secret.map(n => 'secret/' + n))
        : [];
    return res(vals.filter(v => v.startsWith(val)).map(v => key + v));
  }

  // positional arguments (skip flags and the values of -o/-n/-l)
  const args: string[] = [];
  rest.slice(1).forEach((a, i, arr) => {
    if (!a.startsWith('-') && !['-o', '-n', '-l'].includes(arr[i - 1])) args.push(a);
  });
  const n = args.length;
  const withKind = (k: string, list: string[]) => pick(list.map(x => k + '/' + x));
  const kindNames = (word: string): string[] => {
    const k = KIND[word];
    return k && k !== 'all' ? pick(names[k]) : [];
  };

  switch (verb) {
    case 'get':
      if (n === 0) return res(pick(KINDS.concat('all', cur ? ALIASES : [])));
      if (n === 1) return res(kindNames(args[0]));
      return res([]);
    case 'completion': return res(n === 0 ? pick(['bash', 'zsh', 'fish', 'powershell']) : []);
    case 'top': return res(n === 0 ? pick(['pods', 'nodes']) : []);
    case 'events': return res([]);
    case 'logs': return res(n === 0 ? pick(names.pod.concat(names.job.map(j => 'job/' + j), names.deployment.map(d => 'deployment/' + d))) : []);
    case 'exec': return res(n === 0 ? pick(names.pod) : []);
    case 'port-forward': return res(n === 0 ? pick(names.pod.map(p => 'pod/' + p).concat(names.service.map(v => 'svc/' + v), names.deployment.map(d => 'deployment/' + d))) : []);
    case 'label': return res(n === 0 ? pick(['pods']) : n === 1 ? pick(names.pod) : []);
    case 'patch':
      if (n === 0) return res(pick(['deployment', 'cronjob']));
      if (n === 1) return res(kindNames(args[0]));
      return res([]);
    case 'cordon': case 'uncordon': case 'drain': return res(n === 0 ? pick(names.node) : []);
    case 'create':
      if (n === 0) return res(pick(['deployment', 'configmap', 'secret', 'job', 'cronjob']));
      if (n === 1 && args[0] === 'secret') return res(pick(['generic']));
      return res([]);
    case 'set':
      if (n === 0) return res(pick(['image', 'env', 'resources', 'selector']));
      if (n === 1 && (args[0] === 'resources')) return res(pick(['deployment']));
      if (n === 1 && args[0] === 'selector') return res(pick(['service']));
      if (n === 2 && args[0] === 'selector') return res(pick(names.service));
      if (n === 2 && args[0] === 'resources') return res(pick(names.deployment));
      if (n === 1) return res(withKind('deployment', names.deployment));
      if (n === 2 && args[0] === 'image') {
        const eq = cur.indexOf('='); // CONTAINER=IMAGE
        if (eq < 0) return res(pick(Object.keys(IMAGES)));
        return res(Object.keys(IMAGES).filter(i => i.startsWith(cur.slice(eq + 1))).map(i => cur.slice(0, eq + 1) + i));
      }
      return res([]);
    case 'rollout':
      if (n === 0) return res(pick(['status', 'history', 'undo', 'pause', 'resume', 'restart']));
      if (n === 1) return res(withKind('deployment', names.deployment));
      return res([]);
    case 'describe': case 'delete':
      if (n === 0) return res(pick(['pod', 'deployment', 'service', 'node', 'configmap', 'secret', 'hpa', 'job', 'cronjob', 'quota', 'namespace'].concat(cur ? ['po', 'deploy', 'svc', 'cm', 'cj'] : [])));
      if (n === 1) return res(kindNames(args[0]));
      return res([]);
    case 'scale': case 'autoscale': case 'expose':
      if (n === 0) return res(pick(verb === 'expose' ? ['deployment', 'pod'] : ['deployment']));
      if (n === 1) return res(kindNames(args[0]));
      return res([]);
    default: return res([]);
  }
}

export function commonPrefix(list: string[]): string {
  let p = list[0] ?? '';
  for (const x of list) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
}

// ---- The Hard Way shell ---------------------------------------------------------------------------------------------------
const HW_COMMANDS = ['ls', 'cat', 'cd', 'pwd', 'mkdir', 'cp', 'mv', 'rm', 'chmod', 'touch', 'echo', 'export', 'head', 'grep', 'cut', 'base64', 'sed', 'envsubst', 'hexdump',
  'wc', 'tar', 'wget', 'git', 'ssh', 'ssh-keygen', 'ssh-copy-id', 'scp', 'openssl', 'systemctl', 'journalctl', 'apt-get', 'swapoff', 'swapon', 'modprobe', 'sysctl', 'ip',
  'etcdctl', 'curl', 'kubectl', 'hostnamectl', 'hostname', 'exit', 'help', 'clear'];
const SYSTEMCTL = ['daemon-reload', 'enable', 'disable', 'start', 'stop', 'restart', 'status', 'is-active'];
const HOSTS = ['server', 'node-0', 'node-1'];

function completeHw(s: State, prev: string[], cur: string, start: number): Completion {
  const hw = s.hw!;
  const res = (options: string[]): Completion => ({ start, options: [...new Set(options)] });
  const pick = (list: string[]) => list.filter(x => x.startsWith(cur));
  if (!prev.length) return res(pick(HW_COMMANDS));
  const cmd = prev[0];
  const argIndex = prev.filter(x => !x.startsWith('-')).length - 1;
  const pathsOn = (machine: string, base: string, cwd: string): string[] => {
    const m = hw.machines[machine];
    const i = base.lastIndexOf('/');
    const dirPart = base.slice(0, i + 1), namePart = base.slice(i + 1);
    const dir = normalize(dirPart || '.', cwd);
    return listDir(m, dir).filter(k => k.name.startsWith(namePart) && (namePart.startsWith('.') || !k.name.startsWith('.'))).map(k => dirPart + k.name + (k.dir ? '/' : ''));
  };
  if (cmd === 'systemctl') {
    if (argIndex === 0) return res(pick(SYSTEMCTL));
    const m = hw.machines[hw.active];
    return res(pick(Object.keys(m.files).map(f => /^\/etc\/systemd\/system\/([\w-]+)\.service$/.exec(f)?.[1]).filter((x): x is string => !!x)));
  }
  if (cmd === 'openssl' && argIndex === 0) return res(pick(['genrsa', 'req', 'x509']));
  if (cmd === 'ip' && argIndex === 0) return res(pick(['route']));
  if ((cmd === 'ssh' || cmd === 'ssh-copy-id') && !prev.slice(1).some(x => x.startsWith('root@')) && !cur.includes('/')) return res(pick(HOSTS.map(h => 'root@' + h)));
  const remote = /^(root@([\w.-]+)):(.*)$/.exec(cur);
  if (cmd === 'scp' && remote && hw.machines[remote[2]]) {
    return res(pathsOn(remote[2], remote[3] || '', '/root').map(p => remote[1] + ':' + p));
  }
  if (cmd === 'scp' && /^root@?[\w.-]*$/.test(cur)) return res(pick(HOSTS.map(h => 'root@' + h + ':')));
  if (cur.startsWith('$') || cur.startsWith('-')) return res([]);
  return res(pathsOn(hw.active, cur, hw.cwd[hw.active]));
}
