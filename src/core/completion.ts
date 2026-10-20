// Tab completion for the in-game terminal. Pure function, easy to test.
import { IMAGES } from '../data/images';
import { KIND, SUPPORTED } from './cli';
import type { State } from './types';

export interface Completion {
  /** index in the line where the completed token starts */
  start: number;
  options: string[];
}

const VERBS = SUPPORTED.slice();
const KINDS = ['pods', 'deployments', 'services', 'nodes', 'configmaps', 'secrets', 'hpa', 'endpoints', 'jobs', 'cronjobs'];
const ALIASES = ['po', 'deploy', 'svc', 'cm', 'no', 'ep', 'cj'];
const FLAGS: Record<string, string[]> = {
  run: ['--image=', '--labels=app=', '--restart=Never'],
  create: ['--image=', '--replicas=', '--from-literal=', '--schedule=', '--from=cronjob/'],
  scale: ['--replicas='],
  expose: ['--port=', '--target-port=', '--name='],
  autoscale: ['--min=', '--max=', '--cpu-percent='],
  set: ['--from=configmap/', '--from=secret/', '--requests=cpu=', '--limits=memory='],
  label: ['--overwrite', '--selector='],
  patch: ['--patch='],
  get: ['--output=', '--selector=', '--show-labels'],
  drain: ['--ignore-daemonsets'],
};
const ANY_VERB_FLAGS = ['--help'];

export function completeLine(s: State, line: string): Completion {
  const cur = /(\S*)$/.exec(line)![1];
  const start = line.length - cur.length;
  const prev = line.slice(0, start).split(/\s+/).filter(Boolean);
  const pick = (list: string[]) => list.filter(x => x.startsWith(cur));
  const res = (options: string[]): Completion => ({ start, options });

  if (!prev.length) return res(pick(['kubectl', 'k', 'cloud', 'help', 'clear']));

  const names = {
    endpoints: s.services.map(v => v.name),
    job: s.jobs.map(j => j.name),
    cronjob: s.cronjobs.map(c => c.name),
    pod: s.pods.filter(p => p.phase !== 'Terminating').map(p => p.name),
    deployment: s.deployments.map(d => d.name),
    service: s.services.map(v => v.name),
    configmap: s.configmaps.map(c => c.name),
    secret: s.secrets.map(c => c.name),
    hpa: s.hpas.map(h => h.dep),
    node: s.nodes.map(n => n.name),
  };
  const last = prev[prev.length - 1];
  if (last === '-o') return res(pick(['wide']));
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
    const vals = key === '--output=' ? ['wide'] : key === '--image='
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
    case 'top': return res(n === 0 ? pick(['pods']) : []);
    case 'logs': return res(n === 0 ? pick(names.pod.concat(names.job.map(j => 'job/' + j))) : []);
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
      if (n === 0) return res(pick(['pod', 'deployment', 'service', 'node', 'configmap', 'secret', 'hpa', 'job', 'cronjob'].concat(cur ? ['po', 'deploy', 'svc', 'cm', 'cj'] : [])));
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
