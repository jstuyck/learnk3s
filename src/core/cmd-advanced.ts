// Intermediate / advanced kubectl: label, set selector|resources, rollout pause|resume|restart,
// patch, exec, port-forward.
import { portOf } from '../data/images';
import type { Ctx } from './ctx';
import { parseLabels, strFlag } from './ctx';
import { labelText, matchesSelector } from './format';
import {
  endpoints, recordRevision, selectorMatches, snapshot, templateOf, tplOf,
} from './sim';
import type { Deployment, Pod, Service } from './types';

// ---- kubectl label --------------------------------------------------------------
/** kubectl label pods NAME key=value [key2=value2 | key-] [--overwrite] | kubectl label pods -l sel key=value */
export function labelCmd(c: Ctx): void {
  const { s, pos, flags } = c;
  const kindWord = pos[0];
  if (!kindWord || !['pod', 'pods', 'po'].includes(kindWord)) { c.err('error: only pods can be labelled in this simulator (kubectl label pods NAME key=value)'); return; }
  const selector = strFlag(flags.selector);
  const rest = pos.slice(1);
  // targets: explicit name, or -l selector, or --all
  const exprStart = rest.findIndex(x => /=|-$/.test(x));
  const names = exprStart < 0 ? rest : rest.slice(0, exprStart);
  const exprs = exprStart < 0 ? [] : rest.slice(exprStart);
  if (!exprs.length) { c.err('error: at least one label specification is required'); return; }
  let targets: Pod[];
  if (names.length) {
    targets = [];
    for (const n of names) { const p = c.findPod(n); if (!p) { c.notFound('pod', n); return; } targets.push(p); }
  } else if (selector || flags.all) {
    targets = s.pods.filter(p => (flags.all ? true : matchesSelector(p, selector)));
  } else { c.err('error: one or more resources must be specified as <resource> <name> or <resource>/<name>'); return; }
  if (!targets.length) { c.say('No resources found in default namespace.', 'dim'); return; }
  for (const p of targets) {
    for (const e of exprs) {
      if (e.endsWith('-')) { const k = e.slice(0, -1); if (k === 'app') { c.err('error: removing the "app" label is not supported here'); return; } delete p.labels[k]; continue; }
      const m = /^([A-Za-z0-9_./-]+)=([A-Za-z0-9_.-]*)$/.exec(e);
      if (!m) { c.err('error: invalid label spec "' + e + '", expected key=value or key-'); return; }
      if (m[1] in p.labels && p.labels[m[1]] !== m[2] && !flags.overwrite) {
        c.err('error: \'' + m[1] + '\' already has a value (' + p.labels[m[1]] + '), and --overwrite is false');
        return;
      }
      p.labels[m[1]] = m[2];
      if (m[1] === 'app') p.app = m[2];
    }
    s.flags.labeledPod = true;
    c.ok('pod/' + p.name + ' labeled');
  }
}

// ---- kubectl set selector / resources ------------------------------------------------
/** kubectl set selector service NAME key=value[,key=value] */
export function setSelectorCmd(c: Ctx, args: string[]): void {
  const { s } = c;
  const kind = args[0];
  const name = args[1];
  const expr = args.slice(2).join(',');
  if (!['service', 'svc', 'services'].includes(kind ?? '') || !name || !expr) { c.err('usage: kubectl set selector service NAME key=value'); return; }
  const svc = s.services.find(v => v.name === name);
  if (!svc) { c.notFound('service', name); return; }
  const sel = parseLabels(expr);
  if (!sel || !Object.keys(sel).length) { c.err('error: invalid selector "' + expr + '", expected key=value'); return; }
  svc.selector = sel;
  s.flags.fixedSelector = true;
  c.ok('service/' + name + ' selector updated');
}

const parseQty = (v: string, unit: 'cpu' | 'memory'): number | null => {
  if (unit === 'cpu') {
    const m = /^(\d+)m$/.exec(v);
    if (m) return Number(m[1]);
    const w = /^(\d+(?:\.\d+)?)$/.exec(v);
    return w ? Math.round(Number(w[1]) * 1000) : null;
  }
  const m = /^(\d+)(Mi|Gi)$/.exec(v);
  return m ? Number(m[1]) * (m[2] === 'Gi' ? 1024 : 1) : null;
};

/** kubectl set resources deployment NAME --requests=cpu=200m --limits=memory=256Mi */
export function setResourcesCmd(c: Ctx, d: Deployment): void {
  const { s, flags } = c;
  const req = strFlag(flags.requests);
  const lim = strFlag(flags.limits);
  if (!req && !lim) { c.err('error: you must specify an update to requests or limits (in the form of --requests=resource=quantity,... / --limits=...)'); return; }
  const next = { ...d.res };
  for (const [flag, text] of [['requests', req], ['limits', lim]] as const) {
    if (!text) continue;
    for (const part of text.split(',')) {
      const m = /^(cpu|memory)=(.+)$/.exec(part);
      const qty = m ? parseQty(m[2], m[1] as 'cpu' | 'memory') : null;
      if (!m || qty === null) { c.err('error: invalid --' + flag + ' "' + part + '". Use cpu=250m or memory=256Mi'); return; }
      if (m[1] === 'cpu' && flag === 'requests') next.cpu = qty;
      else if (m[1] === 'memory' && flag === 'limits') next.mem = qty;
      else if (m[1] === 'cpu') { /* a CPU limit only throttles; it does not affect scheduling here */ }
      else { /* a memory request does not affect scheduling here */ }
    }
  }
  d.res = next;
  recordRevision(d);
  s.flags.setResources = true; s.cpPulse = 1;
  c.ok('deployment.apps/' + d.name + ' resource requirements updated');
}

// ---- kubectl rollout pause|resume|restart -----------------------------------------------
export function rolloutExtra(c: Ctx, sub: string, d: Deployment): void {
  const { s } = c;
  if (sub === 'pause') {
    if (d.frozen) { c.err('error: deployments.apps "' + d.name + '" is already paused'); return; }
    d.frozen = snapshot(d);
    s.flags.pausedRollout = true;
    c.ok('deployment.apps/' + d.name + ' paused');
  } else if (sub === 'resume') {
    if (!d.frozen) { c.err('error: deployments.apps "' + d.name + '" is not paused'); return; }
    const changed = tplOf(d.frozen) !== tplOf(d);
    d.frozen = null;
    if (changed) d.rollouts++;
    s.flags.resumedRollout = true; s.cpPulse = 1;
    c.ok('deployment.apps/' + d.name + ' resumed');
  } else {
    if (d.frozen) { c.err('error: deployments.apps "' + d.name + '" can\'t be restarted while paused'); return; }
    d.restart++;
    recordRevision(d);
    s.flags.restartedRollout = true; s.cpPulse = 1;
    c.ok('deployment.apps/' + d.name + ' restarted');
  }
}

// ---- kubectl patch -------------------------------------------------------------------------
/** Supports the two patches people actually type: spec.replicas on a Deployment, spec.suspend on a CronJob. */
export function patchCmd(c: Ctx): void {
  const { s, pos, flags } = c;
  const text = strFlag(flags.patch);
  const kind = pos[0];
  const name = pos[1] ?? (kind?.includes('/') ? kind.split('/')[1] : undefined);
  const k = kind?.includes('/') ? kind.split('/')[0] : kind;
  if (!k || !name || !text) { c.err('error: usage: kubectl patch (TYPE NAME) -p \'{"spec":{...}}\''); return; }
  let patch: { spec?: { replicas?: unknown; suspend?: unknown } };
  try { patch = JSON.parse(text.replace(/^'(.*)'$/s, '$1')); } catch { c.err('error: unable to parse "' + text + '": invalid JSON'); return; }
  const spec = patch.spec;
  if (!spec) { c.err('error: this simulator only supports patches of the form {"spec":{"replicas":N}} or {"spec":{"suspend":true|false}}'); return; }
  if (['deployment', 'deployments', 'deploy'].includes(k) && typeof spec.replicas === 'number') {
    const d = c.getDep(name); if (!d) return;
    if (!Number.isInteger(spec.replicas) || spec.replicas < 0 || spec.replicas > 12) { c.err('error: replicas must be a whole number between 0 and 12'); return; }
    d.replicas = spec.replicas; s.flags.patched = true; s.cpPulse = 1;
    c.ok('deployment.apps/' + name + ' patched');
  } else if (['cronjob', 'cronjobs', 'cj'].includes(k) && typeof spec.suspend === 'boolean') {
    const cj = s.cronjobs.find(x => x.name === name);
    if (!cj) { c.notFound('cronjob', name); return; }
    cj.suspend = spec.suspend; s.flags.patched = true;
    if (spec.suspend) s.flags.suspendedCron = true;
    c.ok('cronjob.batch/' + name + ' patched');
  } else {
    c.err('error: this simulator only supports patches of the form {"spec":{"replicas":N}} (deployment) or {"spec":{"suspend":true|false}} (cronjob)');
  }
}

// ---- kubectl exec / port-forward --------------------------------------------------------------
function hostService(c: Ctx, host: string): Service | undefined {
  const bare = host.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/\.default(\.svc(\.cluster\.local)?)?$/, '');
  return c.s.services.find(v => v.name === bare);
}

/** What `curl` / `wget` print from inside a pod. */
function fetchFrom(c: Ctx, tool: 'curl' | 'wget', target: string): { out: string[]; code: number } {
  const { s } = c;
  const url = target.replace(/^https?:\/\//, '');
  const host = url.split('/')[0].split(':')[0];
  const explicitPort = /:(\d+)/.exec(url.split('/')[0]);
  const fail = (curlMsg: string, wgetMsg: string, code: number) => ({ out: [tool === 'curl' ? curlMsg : wgetMsg], code });
  if (host === 'localhost' || host === '127.0.0.1') {
    return fail('curl: (7) Failed to connect to localhost port 80 after 0 ms: Connection refused', "wget: can't connect to remote host (127.0.0.1): Connection refused", 1);
  }
  const svc = hostService(c, host);
  if (!svc) return fail('curl: (6) Could not resolve host: ' + host, 'wget: bad address \'' + host + '\'', 6);
  const port = explicitPort ? Number(explicitPort[1]) : 80;
  const eps = endpoints(s, svc).filter(p => p.phase === 'Running');
  if (port !== svc.port) return fail('curl: (7) Failed to connect to ' + host + ' port ' + port + ': Connection refused', "wget: can't connect to remote host (" + svc.ip + '): Connection refused', 1);
  if (!eps.length) return fail('curl: (28) Connection timed out after 5001 milliseconds (the Service has no endpoints)', 'wget: download timed out', 28);
  if (svc.targetPort !== portOf(eps[0].image)) {
    return fail('curl: (7) Failed to connect to ' + host + ' port ' + port + ' after 2 ms: Connection refused',
      "wget: can't connect to remote host (" + svc.ip + '): Connection refused', 1);
  }
  return { out: ['<html><body><h1>Welcome to ' + eps[0].app + '!</h1></body></html>'], code: 0 };
}

/** kubectl exec [-it] POD -- COMMAND ... */
export function execCmd(c: Ctx): void {
  const { s, pos, cmdArgs } = c;
  const name = pos[0];
  if (!name) { c.err('error: expected \'exec (POD | TYPE/NAME) COMMAND [ARG1] [ARG2] ... [ARGN]\'.'); return; }
  let p = c.findPod(name);
  if (!p && name.startsWith('deployment/')) p = s.pods.find(x => x.owner === name.split('/')[1] && x.phase === 'Running');
  if (!p) { c.notFound('pod', name); return; }
  if (p.phase !== 'Running') { c.err('error: unable to upgrade connection: container not found ("' + p.name + '") - the pod is ' + p.phase); return; }
  if (!cmdArgs.length) { c.err('error: you must specify at least one command for the container (kubectl exec POD -- COMMAND)'); return; }
  s.flags.usedExec = true;
  const [bin, ...args] = cmdArgs;
  switch (bin) {
    case 'hostname': c.say(p.name); break;
    case 'whoami': c.say('root'); break;
    case 'env': {
      c.say('HOSTNAME=' + p.name);
      const cm = p.config ? s.configmaps.find(x => x.name === p.config) : undefined;
      const sec = p.secret ? s.secrets.find(x => x.name === p.secret) : undefined;
      Object.entries(cm?.data ?? {}).forEach(([k, v]) => c.say(k + '=' + v));
      Object.keys(sec?.data ?? {}).forEach(k => c.say(k + '=<from secret>'));
      s.services.forEach(v => c.say(v.name.toUpperCase().replace(/-/g, '_') + '_SERVICE_HOST=' + v.ip));
      break;
    }
    case 'cat': c.say(args[0] === '/etc/hostname' ? p.name : 'cat: ' + (args[0] ?? '') + ': No such file or directory'); break;
    case 'ls': c.say('bin  dev  etc  home  proc  root  sys  tmp  usr  var'); break;
    case 'echo': c.say(args.join(' ')); break;
    case 'curl': case 'wget': {
      const target = args.filter(a => !a.startsWith('-')).pop();
      if (!target) { c.err('error: ' + bin + ': no URL specified'); break; }
      const r = fetchFrom(c, bin, target);
      r.out.forEach(l => c.say(l, r.code ? 'err' : ''));
      break;
    }
    case 'nslookup': {
      const host = args[0] ?? '';
      const svc = hostService(c, host);
      if (svc) { c.say('Name:    ' + host + '.default.svc.cluster.local'); c.say('Address: ' + svc.ip); }
      else c.say("** server can't find " + host + ': NXDOMAIN', 'err');
      break;
    }
    default: c.say('sh: ' + bin + ': not found (this simulator supports: hostname, whoami, env, cat, ls, echo, curl, wget, nslookup)', 'err');
  }
}

/** kubectl port-forward (pod/NAME | deployment/NAME | svc/NAME) LOCAL:REMOTE */
export function portForwardCmd(c: Ctx): void {
  const { s, pos } = c;
  const target = pos[0];
  const ports = pos[1];
  if (!target || !ports || !/^\d+(:\d+)?$/.test(ports)) { c.err('error: usage: kubectl port-forward TYPE/NAME [LOCAL_PORT:]REMOTE_PORT'); return; }
  const [kindRaw, nameRaw] = target.includes('/') ? target.split('/') : ['pod', target];
  const local = Number(ports.split(':')[0]);
  const remote = Number(ports.split(':').pop());
  let pod: Pod | undefined;
  let svc: Service | undefined;
  if (['pod', 'po', 'pods'].includes(kindRaw)) pod = c.findPod(nameRaw);
  else if (['deployment', 'deploy'].includes(kindRaw)) pod = s.pods.find(x => x.owner === nameRaw && x.phase === 'Running');
  else if (['service', 'svc'].includes(kindRaw)) {
    svc = s.services.find(v => v.name === nameRaw);
    pod = svc ? endpoints(s, svc).find(x => x.phase === 'Running') : undefined;
  } else { c.err('error: unsupported resource type "' + kindRaw + '"'); return; }
  if (!pod && !svc) { c.notFound(kindRaw, nameRaw); return; }
  if (!pod) { c.err('error: unable to forward port because pod is not running. Current status=Pending'); return; }
  if (pod.phase !== 'Running') { c.err('error: unable to forward port because pod is not running. Current status=' + pod.phase); return; }
  const podPort = svc ? (remote === svc.port ? svc.targetPort : remote) : remote;
  if (podPort !== portOf(pod.image)) {
    c.say('Forwarding from 127.0.0.1:' + local + ' -> ' + podPort);
    c.err('E1019 error: an error occurred forwarding ' + local + ' -> ' + podPort + ': connection refused (nothing listens on port ' + podPort + ' in ' + pod.name + ')');
    return;
  }
  s.flags.portForwarded = true;
  c.say('Forwarding from 127.0.0.1:' + local + ' -> ' + podPort);
  c.say('Forwarding from [::1]:' + local + ' -> ' + podPort);
  c.say('tip: a real port-forward keeps running until you press Ctrl+C; here it is "connected" right away.', 'dim');
}

// re-exported for the CLI's describe output
export { labelText, selectorMatches, templateOf };
