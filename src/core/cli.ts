// ---------------------------------------------------------------------------
// A tiny kubectl (plus a "cloud" console for renting nodes).
// runCommand(state, line) -> lines to print; it mutates the state like the real thing would.
// ---------------------------------------------------------------------------
import { IMAGES } from '../data/images';
import { createCronJobCmd, createJobCmd, deleteCronJobCmd, deleteJobCmd, describeCronJob, describeJob, getCronJobs, getJobs } from './cmd-batch';
import { execCmd, labelCmd, patchCmd, portForwardCmd, rolloutExtra, setResourcesCmd, setSelectorCmd } from './cmd-advanced';
import { deleteBulk, eventsCmd, getStructured, logsCmd, rolloutRevisions, topCmd } from './cmd-elite';
import type { Ctx, FlagValue, Out } from './ctx';
import { KIND, NONE, parseArgs, parseLabels, resRef, splitWords, strFlag } from './ctx';
import { burnRate, profit, revenueRate } from './economy';
import { runHw } from './hwshell';
import { configCmd, describeQuota, getNamespaced, namespaceCmd, namespaces, NS_LIMIT, NS_SYSTEM, quotaCmd, systemPodCmd } from './system';
import { ageStr, depRows, endpointRows, labelText, nodeRows, podRows, podStatus, svcRows, table } from './format';
import {
  addDeployment, addService, depOf, endpoints, keyOf, makeNode, makePod, NODE_CPU, ownedPods, planCommand, readyCount, recordRevision, terminate, tplOf,
} from './sim';
import type { Line, Pod, State } from './types';

export { KIND, parseArgs } from './ctx';
export type { Kind } from './ctx';

/** The real `kubectl --help` text. */
export const KUBECTL_HELP: string[] = [
  'kubectl controls the Kubernetes cluster manager.',
  '',
  ' Find more information at: https://kubernetes.io/docs/reference/kubectl/',
  '',
  'Basic Commands (Beginner):',
  '  create          Create a resource from a file or from stdin',
  '  expose          Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service',
  '  run             Run a particular image on the cluster',
  '  set             Set specific features on objects',
  '',
  'Basic Commands (Intermediate):',
  '  explain         Get documentation for a resource',
  '  get             Display one or many resources',
  '  edit            Edit a resource on the server',
  '  delete          Delete resources by file names, stdin, resources and names, or by resources and label selector',
  '',
  'Deploy Commands:',
  '  rollout         Manage the rollout of a resource',
  '  scale           Set a new size for a deployment, replica set, or replication controller',
  '  autoscale       Auto-scale a deployment, replica set, stateful set, or replication controller',
  '',
  'Cluster Management Commands:',
  '  certificate     Modify certificate resources',
  '  cluster-info    Display cluster information',
  '  top             Display resource (CPU/memory) usage',
  '  cordon          Mark node as unschedulable',
  '  uncordon        Mark node as schedulable',
  '  drain           Drain node in preparation for maintenance',
  '  taint           Update the taints on one or more nodes',
  '',
  'Troubleshooting and Debugging Commands:',
  '  describe        Show details of a specific resource or group of resources',
  '  logs            Print the logs for a container in a pod',
  '  attach          Attach to a running container',
  '  exec            Execute a command in a container',
  '  port-forward    Forward one or more local ports to a pod',
  '  proxy           Run a proxy to the Kubernetes API server',
  '  cp              Copy files and directories to and from containers',
  '  auth            Inspect authorization',
  '  debug           Create debugging sessions for troubleshooting workloads and nodes',
  '  events          List events',
  '',
  'Advanced Commands:',
  '  diff            Diff the live version against a would-be applied version',
  '  apply           Apply a configuration to a resource by file name or stdin',
  '  patch           Update fields of a resource',
  '  replace         Replace a resource by file name or stdin',
  '  wait            Experimental: Wait for a specific condition on one or many resources',
  '  kustomize       Build a kustomization target from a directory or URL',
  '',
  'Settings Commands:',
  '  label           Update the labels on a resource',
  '  annotate        Update the annotations on a resource',
  '  completion      Output shell completion code for the specified shell (bash, zsh, fish, or powershell)',
  '',
  'Subcommands provided by plugins:',
  '',
  'Other Commands:',
  '  api-resources   Print the supported API resources on the server',
  '  api-versions    Print the supported API versions on the server, in the form of "group/version"',
  '  config          Modify kubeconfig files',
  '  plugin          Provides utilities for interacting with plugins',
  '  version         Print the client and server version information',
  '',
  'Usage:',
  '  kubectl [flags] [options]',
  '',
  'Use "kubectl <command> --help" for more information about a given command.',
  'Use "kubectl options" for a list of global command-line options (applies to all commands).',
];

/** Every command in the real help; the simulator implements only the SUPPORTED subset. */
export const REAL_COMMANDS: string[] = KUBECTL_HELP
  .filter(l => /^ {2}[a-z][a-z-]+ {2,}\S/.test(l))
  .map(l => l.trim().split(/\s+/)[0]);

export const SUPPORTED = [
  'create', 'expose', 'run', 'set', 'get', 'delete', 'rollout', 'scale', 'autoscale', 'cluster-info', 'top',
  'cordon', 'uncordon', 'drain', 'describe', 'logs', 'events', 'completion', 'version',
  'label', 'patch', 'exec', 'port-forward', 'config',
];

/** Usage lines for `kubectl <command> --help` (the subset of flags the simulator understands). */
export const USAGE: Record<string, string[]> = {
  create: [
    'Create a resource.',
    '',
    'Available Commands:',
    '  configmap     Create a config map from a local file, directory or literal value',
    '  cronjob       Create a cron job with the specified name',
    '  deployment    Create a deployment with the specified name',
    '  job           Create a job with the specified name',
    '  secret        Create a secret using a specified subcommand',
    '',
    'Usage:',
    '  kubectl create deployment NAME --image=image [--replicas=N]',
    '  kubectl create configmap NAME --from-literal=key=value',
    '  kubectl create secret generic NAME --from-literal=key=value',
    '  kubectl create job NAME --image=image [-- COMMAND ARGS...]',
    '  kubectl create job NAME --from=cronjob/CRONJOB',
    '  kubectl create cronjob NAME --image=image --schedule="*/1 * * * *" [-- COMMAND ARGS...]',
  ],
  expose: ['Expose a resource as a new Kubernetes service.', '', 'Usage:', '  kubectl expose (-f FILENAME | TYPE NAME) [--port=port] [--target-port=port] [--name=name]', '', 'Examples:', '  kubectl expose deployment nginx --port=80 --target-port=8000'],
  run: ['Create and run a particular image in a pod.', '', 'Usage:', '  kubectl run NAME --image=image [--labels="key=value"] [--restart=Never] [-- COMMAND ARGS...]', '', 'Examples:', '  kubectl run nginx --image=nginx', '  kubectl run job-like --image=busybox --restart=Never -- echo hello'],
  set: ['Configure application resources.', '', 'Available Commands:', '  env           Update environment variables on a pod template', '  image         Update the image of a pod template', '  resources     Update resource requests/limits on objects with pod templates', '  selector      Set the selector on a resource', '', 'Usage:', '  kubectl set image deployment/NAME CONTAINER=IMAGE', '  kubectl set env deployment/NAME --from=configmap/NAME|secret/NAME', '  kubectl set resources deployment NAME --requests=cpu=200m --limits=memory=256Mi', '  kubectl set selector service NAME key=value'],
  get: ['Display one or many resources.', '', 'Usage:', '  kubectl get (TYPE [NAME | -l label]) [flags]', '', 'Types: pods, deployments, services, nodes, configmaps, secrets, hpa, endpoints, jobs, cronjobs, all', '', 'Flags:', '  -o, --output string   Output format. One of: wide|name|json|yaml|jsonpath=...|custom-columns=...', '  -l, --selector string Selector (label query), e.g. app=web', '      --field-selector  Filter on fields, e.g. status.phase=Running,spec.nodeName=node-1', '      --sort-by string  JSONPath to sort by, e.g. .metadata.name', '      --show-labels     When printing, show all labels as the last column', '', 'Examples:', "  kubectl get pods -o jsonpath='{.items[*].metadata.name}'", '  kubectl get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName', '  kubectl get pods --sort-by=.status.containerStatuses[0].restartCount'],
  delete: ['Delete resources by resource and names.', '', 'Usage:', '  kubectl delete (TYPE NAME [NAME...] | TYPE -l label | TYPE --all)', '', 'Examples:', '  kubectl delete pod web', '  kubectl delete deployment web', '  kubectl delete pods -l env=test', '  kubectl delete pods --field-selector=status.phase=Succeeded'],
  rollout: ['Manage the rollout of one or many resources.', '', 'Available Commands:', '  history       View rollout history', '  pause         Mark the provided resource as paused', '  restart       Restart a resource', '  resume        Resume a paused resource', '  status        Show the status of the rollout', '  undo          Undo a previous rollout', '', 'Usage:', '  kubectl rollout SUBCOMMAND deployment/NAME', '  kubectl rollout history deployment/NAME --revision=N', '  kubectl rollout undo deployment/NAME --to-revision=N'],
  scale: ['Set a new size for a deployment.', '', 'Usage:', '  kubectl scale (TYPE NAME) --replicas=COUNT [--current-replicas=COUNT]', '', 'Examples:', '  kubectl scale deployment/web --replicas=3'],
  autoscale: ['Creates an autoscaler that automatically chooses and sets the number of pods that run in a Kubernetes cluster.', '', 'Usage:', '  kubectl autoscale (TYPE NAME) [--min=MINPODS] --max=MAXPODS [--cpu-percent=CPU]', '', 'Examples:', '  kubectl autoscale deployment foo --min=2 --max=10'],
  top: ['Display resource (CPU/memory) usage.', '', 'Usage:', '  kubectl top pods [--sort-by=cpu|memory]', '  kubectl top nodes'],
  cordon: ['Mark node as unschedulable.', '', 'Usage:', '  kubectl cordon NODE'],
  uncordon: ['Mark node as schedulable.', '', 'Usage:', '  kubectl uncordon NODE'],
  drain: ['Drain node in preparation for maintenance.', '', 'Usage:', '  kubectl drain NODE [--ignore-daemonsets]'],
  config: ['Modify kubeconfig files.', '', 'Usage:', '  kubectl config set-context --current --namespace=NAMESPACE', '  kubectl config get-contexts', '  kubectl config current-context', '  kubectl config view --minify', '', 'The namespace of the current context is used by every command that has no -n flag.'],
  describe: ['Show details of a specific resource or group of resources.', '', 'Usage:', '  kubectl describe (TYPE NAME)', '', 'Examples:', '  kubectl describe pod web-abc12'],
  logs: ['Print the logs for a container in a pod.', '', 'Usage:', '  kubectl logs POD [--previous] [--tail=N]', '  kubectl logs deployment/NAME', '  kubectl logs -l app=web --tail=5', '  kubectl logs job/NAME'],
  events: ['Display events.', '', 'Usage:', '  kubectl events [--types=Warning] [--for=pod/NAME]'],
  completion: ['Output shell completion code for the specified shell (bash, zsh, fish, or powershell).', '', 'Usage:', '  kubectl completion bash|zsh'],
  'cluster-info': ['Display addresses of the control plane and services with label kubernetes.io/cluster-service=true.', '', 'Usage:', '  kubectl cluster-info'],
  version: ['Print the client and server version information for the current context.', '', 'Usage:', '  kubectl version'],
  label: ['Update the labels on a resource.', '', 'Usage:', '  kubectl label (TYPE NAME | TYPE -l selector) KEY_1=VAL_1 ... KEY_N=VAL_N [--overwrite]', '', 'Examples:', '  kubectl label pods web-abc12 tier=frontend', '  kubectl label pods web-abc12 tier-        # remove the label'],
  patch: ['Update fields of a resource using strategic merge patch.', '', 'Usage:', "  kubectl patch (TYPE NAME) -p PATCH", '', 'Examples:', "  kubectl patch deployment web -p '{\"spec\":{\"replicas\":3}}'", "  kubectl patch cronjob backup -p '{\"spec\":{\"suspend\":true}}'"],
  exec: ['Execute a command in a container.', '', 'Usage:', '  kubectl exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...]', '', 'Examples:', '  kubectl exec web-abc12 -- env', '  kubectl exec -it toolbox -- wget -qO- http://web'],
  'port-forward': ['Forward one or more local ports to a pod.', '', 'Usage:', '  kubectl port-forward TYPE/NAME [LOCAL_PORT:]REMOTE_PORT', '', 'Examples:', '  kubectl port-forward pod/web-abc12 8080:80', '  kubectl port-forward svc/web 8080:80'],
};

/** The terminal's own help (not part of kubectl). */
export const GAME_HELP: string[] = [
  'This terminal runs a simulated kubectl, plus a cloud console for renting machines.',
  '',
  '  kubectl --help             all real kubectl commands (a subset is simulated)',
  '  kubectl <command> --help   usage for a command',
  '  cloud                      cloud provider console: add-node, remove-node, list-nodes, cost',
  '  clear                      clear the screen (Ctrl+L)',
  '',
  'Tab completes commands, flags and object names. Up/Down and Ctrl+R search your history.',
  'Known images: ' + Object.keys(IMAGES).join(', '),
];

/** Run one terminal line. Hard Way missions have a shell on the lab machines; all others have kubectl. */
export function runCommand(s: State, line: string): Line[] {
  return s.hw ? runHw(s, line, runPlain) : runPlain(s, line);
}

export function runPlain(s: State, line: string): Line[] {
  const lines: Line[] = [];
  const out: Out = {
    say: (t, c) => { lines.push({ t, c: c || '' }); },
    err: t => { lines.push({ t, c: 'err' }); s.cmdErrors++; },
    ok: t => { lines.push({ t, c: 'ok' }); },
    emit: rows => { table(rows).forEach(l => lines.push({ t: l, c: '' })); },
  };

  const toks = splitWords(line.trim());
  if (!toks.length) return lines;
  if (toks[0] === 'help') { GAME_HELP.forEach(l => out.say(l, 'dim')); return lines; }
  if (toks[0] === 'cloud') { cloudCommand(s, toks.slice(1), out); return lines; }
  if (toks[0] !== 'kubectl' && toks[0] !== 'k') {
    out.err('command not found: ' + toks[0] + '   (try "kubectl get pods", or "help")');
    return lines;
  }
  toks.shift();
  const verb = toks.shift();
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') { KUBECTL_HELP.forEach(l => out.say(l)); return lines; }
  const dd = toks.indexOf('--');
  kubectl(s, verb, dd >= 0 ? toks.slice(0, dd) : toks, out, dd >= 0 ? toks.slice(dd + 1) : []);
  return lines;
}

function kubectl(s: State, verb: string, toks: string[], out: Out, cmdArgs: string[] = []): void {
  const { say, err, ok, emit } = out;
  const { pos, flags, all } = parseArgs(toks);
  const notFound = (kind: string, name: string) => err('Error from server (NotFound): ' + kind + 's "' + name + '" not found');
  const needNum = (v: FlagValue | undefined, lo: number, hi: number, name: string): number | null => {
    const n = Number(v);
    if (v === undefined || v === true || !Number.isInteger(n) || n < lo || n > hi) {
      err('error: --' + name + ' must be a whole number between ' + lo + ' and ' + hi);
      return null;
    }
    return n;
  };
  const allNs = !!flags['all-namespaces'];
  const curNs = strFlag(flags.namespace) ?? s.ctxNs ?? 'default';
  const getDep = (name: string) => {
    const d = depOf(s, keyOf(curNs, name));
    if (!d) notFound('deployment', name);
    return d;
  };
  const findPod = (name: string): Pod | undefined => s.pods.find(p => p.name === name && p.ns === curNs);
  const literals = (): Record<string, string> | null => {
    const lits = (all['from-literal'] || []).filter((x): x is string => typeof x === 'string');
    if (!lits.length) { err('error: at least one --from-literal=KEY=VALUE is required'); return null; }
    const data: Record<string, string> = {};
    for (const l of lits) {
      const i = l.indexOf('=');
      if (i < 1) { err('error: invalid literal "' + l + '", expected KEY=VALUE'); return null; }
      data[l.slice(0, i)] = l.slice(i + 1);
    }
    return data;
  };
  const crashed = (p: Pod) => p.phase === 'CrashLoopBackOff' || p.phase === 'ImagePullBackOff' || p.phase === 'Error';
  const wide = flags.output === 'wide';
  const selector = strFlag(flags.selector);
  const c: Ctx = { ...out, s, verb, ns: curNs, pos, flags, all, cmdArgs, notFound, needNum, getDep, findPod };

  if (flags.help) { (USAGE[verb] ?? ['No help available for "' + verb + '" in this simulator.']).forEach(l => say(l)); return; }
  if (!SUPPORTED.includes(verb)) {
    if (REAL_COMMANDS.includes(verb)) {
      err('error: "kubectl ' + verb + '" is a real command, but it is not available in this simulator.   (try: kubectl --help)');
    } else {
      err('error: unknown command "' + verb + '" for "kubectl"');
      const near = SUPPORTED.filter(c => c.startsWith(verb.slice(0, 2)));
      if (near.length) say('\nDid you mean this?\n\t' + near.join('\n\t'));
    }
    return;
  }

  const nsKind = KIND[pos[0]];
  const namespaced = ['get', 'describe', 'logs', 'create', 'run', 'scale', 'expose', 'autoscale', 'set', 'rollout', 'label', 'patch', 'exec', 'port-forward', 'delete', 'events', 'top'];
  const mutating = ['create', 'run', 'scale', 'expose', 'autoscale', 'set', 'rollout', 'label', 'patch', 'exec', 'port-forward', 'delete'];
  const nsObject = nsKind === 'namespace';
  if (namespaced.includes(verb) && !allNs && !namespaces(s).includes(curNs)) {
    err('Error from server (NotFound): namespaces "' + curNs + '" not found' + (curNs === s.ctxNs ? '   (the current context points at it: kubectl config set-context --current --namespace=default)' : ''));
    return;
  }
  if (mutating.includes(verb) && curNs === 'kube-system' && !nsObject) { err(NS_SYSTEM); return; }
  if (curNs !== 'default' && !nsObject && (verb === 'autoscale'
    || ((verb === 'create' || verb === 'delete') && ['job', 'cronjob', 'configmap', 'secret', 'hpa'].includes(nsKind ?? ''))
    || (verb === 'patch' && nsKind === 'cronjob'))) { err(NS_LIMIT); return; }

  switch (verb) {
    case 'get': {
      const kind = pos[0] ? KIND[pos[0]] : undefined;
      if (!kind) { err('error: the server doesn\'t have a resource type "' + (pos[0] || '') + '"  (try pods, deployments, services, nodes)'); break; }
      if (!allNs && curNs !== 'kube-system' && getStructured(c, kind)) break;
      if (getNamespaced(c, kind)) break;
      if (kind === 'pod' || kind === 'all') {
        s.flags.usedGet = true;
        const rows = podRows(s, wide, selector, !!flags['show-labels']);
        if (rows.length === 1) say(NONE, 'dim'); else emit(rows);
      }
      if (kind === 'all' && s.services.length) { say(''); emit(svcRows(s, wide)); }
      if (kind === 'all' && s.deployments.length) { say(''); emit(depRows(s, wide)); }
      if (kind === 'all' && s.jobs.length) { say(''); getJobs(c); }
      if (kind === 'all' && s.cronjobs.length) { say(''); getCronJobs(c); }
      if (kind === 'job') getJobs(c);
      if (kind === 'cronjob') getCronJobs(c);
      if (kind === 'deployment') { if (!s.deployments.length) say(NONE, 'dim'); else emit(depRows(s, wide)); }
      if (kind === 'service') { if (!s.services.length) say(NONE, 'dim'); else emit(svcRows(s, wide)); }
      if (kind === 'endpoints') { if (!s.services.length) say(NONE, 'dim'); else emit(endpointRows(s)); }
      if (kind === 'node') emit(nodeRows(s, !!flags['show-labels']));
      if (kind === 'configmap') {
        if (!s.configmaps.length) say(NONE, 'dim');
        else emit([['NAME', 'DATA'] as (string | number)[]].concat(s.configmaps.map(c => [c.name, Object.keys(c.data).length])));
      }
      if (kind === 'secret') {
        if (!s.secrets.length) say(NONE, 'dim');
        else emit([['NAME', 'TYPE', 'DATA'] as (string | number)[]].concat(s.secrets.map(c => [c.name, 'Opaque', Object.keys(c.data).length])));
      }
      if (kind === 'hpa') {
        if (!s.hpas.length) say(NONE, 'dim');
        else {
          emit([['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'] as (string | number)[]].concat(s.hpas.map(h => {
            const d = depOf(s, h.dep);
            return [h.dep, 'Deployment/' + h.dep, Math.round((h.current || 0) * 100) + '%/' + h.cpu + '%', h.min, h.max, d ? d.replicas : 0, ageStr(s, h.created)];
          })));
        }
      }
      break;
    }

    case 'completion': {
      if (!['bash', 'zsh', 'fish', 'powershell'].includes(pos[0])) { err('error: Unsupported shell type "' + (pos[0] ?? '') + '". Choose one of: bash, zsh, fish, powershell'); break; }
      say('# bash completion V2 for kubectl                          -*- shell-script -*-', 'dim');
      say('# (the real command prints a long script; in this terminal Tab completion is already on)', 'dim');
      say('# To load it in your shell:  source <(kubectl completion ' + pos[0] + ')', 'dim');
      s.flags.usedCompletion = true;
      break;
    }

    case 'top': topCmd(c); break;

    case 'run': {
      const name = pos[0];
      const image = strFlag(flags.image);
      if (!name) { err('error: NAME is required: kubectl run NAME --image=IMAGE'); break; }
      if (!image) { err('error: required flag --image not set'); break; }
      if (findPod(name)) { err('Error from server (AlreadyExists): pods "' + name + '" already exists'); break; }
      const labels = strFlag(flags.labels) ? parseLabels(strFlag(flags.labels) as string) : { run: name };
      if (!labels) { err('error: invalid labels "' + String(flags.labels) + '", expected key=value[,key=value]'); break; }
      const never = strFlag(flags.restart) === 'Never' || strFlag(flags.restart) === 'OnFailure';
      const plan = cmdArgs.length ? planCommand(cmdArgs, name) : null;
      makePod(s, {
        name, ns: curNs, app: labels.app ?? name, labels, image, tpl: image + '|||100||0', command: cmdArgs,
        runFor: never && plan ? plan.runFor : undefined, willFail: never && plan ? plan.fail : undefined,
      });
      s.cpPulse = 1;
      ok('pod/' + name + ' created');
      break;
    }

    case 'create': {
      const kind = pos[0] ? KIND[pos[0]] : undefined;
      const name = pos[1];
      if (kind === 'namespace') {
        namespaceCmd(c, 'create', name);
      } else if (kind === 'quota') {
        quotaCmd(c, 'create', name);
      } else if (kind === 'deployment') {
        const image = strFlag(flags.image);
        if (!name) { err('error: NAME is required'); break; }
        if (!image) { err('error: required flag --image not set'); break; }
        if (depOf(s, keyOf(curNs, name))) { err('Error from server (AlreadyExists): deployments.apps "' + name + '" already exists'); break; }
        const n = flags.replicas === undefined ? 1 : needNum(flags.replicas, 0, 12, 'replicas');
        if (n === null) break;
        addDeployment(s, { name, image, replicas: n, ns: curNs });
        s.cpPulse = 1;
        ok('deployment.apps/' + name + ' created');
        if (s.level.id === 'pods') say('tip: a Deployment creates and manages pods for you. Delete one of its pods and see what happens!', 'dim');
      } else if (kind === 'job') {
        createJobCmd(c);
      } else if (kind === 'cronjob') {
        createCronJobCmd(c);
      } else if (kind === 'configmap') {
        if (!name) { err('error: NAME is required'); break; }
        if (s.configmaps.some(cm => cm.name === name)) { err('Error from server (AlreadyExists): configmaps "' + name + '" already exists'); break; }
        const data = literals(); if (!data) break;
        s.configmaps.push({ name, data });
        ok('configmap/' + name + ' created');
      } else if (kind === 'secret') {
        const sname = pos[2];
        if (pos[1] !== 'generic' || !sname) { err('usage: kubectl create secret generic NAME --from-literal=KEY=VALUE'); break; }
        if (s.secrets.some(sc => sc.name === sname)) { err('Error from server (AlreadyExists): secrets "' + sname + '" already exists'); break; }
        const data = literals(); if (!data) break;
        s.secrets.push({ name: sname, data });
        ok('secret/' + sname + ' created');
      } else err('error: must specify one of -f and -k, or a resource to create: configmap, cronjob, deployment, job, secret  (to expose a Deployment use "kubectl expose")');
      break;
    }

    case 'scale': {
      const r = resRef(pos);
      if (!r || r.kind !== 'deployment' || !r.name) { err('usage: kubectl scale deployment NAME --replicas=N'); break; }
      const d = getDep(r.name); if (!d) break;
      const n = needNum(flags.replicas, 0, 12, 'replicas'); if (n === null) break;
      if (flags['current-replicas'] !== undefined && Number(flags['current-replicas']) !== d.replicas) {
        err('error: Expected replicas to be ' + String(flags['current-replicas']) + ', was ' + d.replicas);
        break;
      }
      if (flags['current-replicas'] !== undefined) s.flags.guardedScale = true;
      d.replicas = n; s.cpPulse = 1;
      ok('deployment.apps/' + d.name + ' scaled');
      if (s.hpas.some(h => h.dep === d.name)) say('tip: an autoscaler manages this Deployment and may change replicas again.', 'dim');
      break;
    }

    case 'expose': {
      const r = resRef(pos);
      if (!r || !r.name || (r.kind !== 'deployment' && r.kind !== 'pod')) { err('usage: kubectl expose deployment NAME --port=80'); break; }
      let selectorLabels: Record<string, string>;
      if (r.kind === 'deployment') { const d = getDep(r.name); if (!d) break; selectorLabels = { app: d.app }; }
      else { const p = findPod(r.name); if (!p) { notFound('pod', r.name); break; } selectorLabels = { ...p.labels }; }   // a pod's whole label set
      const name = strFlag(flags.name) ?? r.name;
      if (s.services.some(v => v.name === name && v.ns === curNs)) { err('Error from server (AlreadyExists): services "' + name + '" already exists'); break; }
      const port = flags.port === undefined ? 80 : needNum(flags.port, 1, 65535, 'port'); if (port === null) break;
      const targetPort = flags['target-port'] === undefined ? port : needNum(flags['target-port'], 1, 65535, 'target-port'); if (targetPort === null) break;
      const created = addService(s, name, selectorLabels, port, targetPort, curNs);
      if (strFlag(flags.type) === 'NodePort') created.nodePort = 30000 + Math.floor(s.rng() * 2767);
      else if (strFlag(flags.type) && strFlag(flags.type) !== 'ClusterIP') { err('error: --type must be ClusterIP or NodePort in this simulator'); s.services = s.services.filter(v => v !== created); break; }
      ok('service/' + name + ' exposed');
      break;
    }

    case 'autoscale': {
      const r = resRef(pos);
      if (!r || r.kind !== 'deployment' || !r.name) { err('usage: kubectl autoscale deployment NAME --min=2 --max=6'); break; }
      const d = getDep(r.name); if (!d) break;
      const max = needNum(flags.max, 1, 12, 'max'); if (max === null) break;
      const min = flags.min === undefined ? 1 : needNum(flags.min, 1, 12, 'min'); if (min === null) break;
      if (min > max) { err('error: --min cannot be greater than --max'); break; }
      const cpu = flags['cpu-percent'] === undefined ? 70 : needNum(flags['cpu-percent'], 10, 100, 'cpu-percent'); if (cpu === null) break;
      s.hpas = s.hpas.filter(h => h.dep !== d.name);
      s.hpas.push({ dep: d.name, min, max, cpu, lastScale: s.t, current: 0, created: s.t });
      ok('horizontalpodautoscaler.autoscaling/' + d.name + ' autoscaled');
      break;
    }

    case 'set': {
      const sub = pos[0];
      if (sub === 'selector') { setSelectorCmd(c, pos.slice(1)); break; }
      const r = resRef(pos.slice(1));
      if (sub !== 'image' && sub !== 'env' && sub !== 'resources') { err('usage: kubectl set image|env|resources|selector ...'); break; }
      if (!r || r.kind !== 'deployment' || !r.name) { err('error: specify a deployment, e.g. deployment/web'); break; }
      const d = getDep(r.name); if (!d) break;
      if (sub === 'resources') { setResourcesCmd(c, d); break; }
      if (sub === 'image') {
        let img = pos[pos.length - 1];
        if (!img || img === pos[1] || img === r.name) { err('usage: kubectl set image deployment/NAME CONTAINER=IMAGE'); break; }
        if (img.includes('=')) img = img.slice(img.indexOf('=') + 1);
        if (img === d.image) { say('deployment.apps/' + d.name + ' image unchanged', 'dim'); break; }
        d.image = img;
        recordRevision(d);
        s.cpPulse = 1;
        ok('deployment.apps/' + d.name + ' image updated');
      } else {
        const m = (strFlag(flags.from) ?? '').match(/^(configmap|cm|secret)\/(.+)$/);
        if (!m) { err('usage: kubectl set env deployment/NAME --from=configmap/CM   (or --from=secret/NAME)'); break; }
        if (m[1] === 'secret') {
          if (!s.secrets.some(sc => sc.name === m[2])) { notFound('secret', m[2]); break; }
          d.secret = m[2];
        } else {
          if (!s.configmaps.some(cm => cm.name === m[2])) { notFound('configmap', m[2]); break; }
          d.config = m[2];
        }
        recordRevision(d);
        s.cpPulse = 1;
        ok('deployment.apps/' + d.name + ' env updated');
      }
      break;
    }

    case 'rollout': {
      const sub = pos[0];
      const r = resRef(pos.slice(1));
      if (!['status', 'undo', 'history', 'pause', 'resume', 'restart'].includes(sub) || !r || r.kind !== 'deployment' || !r.name) { err('usage: kubectl rollout status|history|undo|pause|resume|restart deployment/NAME'); break; }
      const d = getDep(r.name); if (!d) break;
      if (sub === 'pause' || sub === 'resume' || sub === 'restart') { rolloutExtra(c, sub, d); break; }
      if (rolloutRevisions(c, sub, d)) break;
      if (sub === 'status') {
        if (d.frozen) { say('deployment "' + d.name + '" is paused. Resume it with: kubectl rollout resume deployment/' + d.name); break; }
        const own = ownedPods(s, d.key);
        const updated = own.filter(p => p.tpl === tplOf(d));
        const ready = updated.filter(p => p.phase === 'Running').length;
        if (updated.length >= d.replicas && ready >= d.replicas && own.length === d.replicas) ok('deployment "' + d.name + '" successfully rolled out');
        else {
          if (updated.length < d.replicas) say('Waiting for deployment "' + d.name + '" rollout to finish: ' + updated.length + ' out of ' + d.replicas + ' new replicas have been updated...');
          else say('Waiting for deployment "' + d.name + '" rollout to finish: ' + ready + ' of ' + d.replicas + ' updated replicas are available...');
        }
      } else if (sub === 'history') {
        say('REVISION   IMAGE        CONFIG', 'dim');
        d.history.forEach((h, i) => {
          const cfg = [h.config && 'cm/' + h.config, h.secret && 'secret/' + h.secret].filter(Boolean).join(',') || '<none>';
          say(String(i + 1).padEnd(11) + h.image.padEnd(13) + cfg + (i === d.history.length - 1 ? '   (current)' : ''));
        });
      } else {
        if (d.history.length < 2) { err('error: no rollout history found for deployment "' + d.name + '"'); break; }
        d.history.pop();
        const prev = d.history[d.history.length - 1];
        d.image = prev.image; d.config = prev.config; d.secret = prev.secret; d.res = { ...prev.res }; d.restart = prev.restart;
        if (!d.frozen) d.rollouts++;
        s.flags.undone = true; s.cpPulse = 1;
        ok('deployment.apps/' + d.name + ' rolled back to ' + prev.image);
      }
      break;
    }

    case 'delete': {
      if (deleteBulk(c)) break;
      const r = resRef(pos);
      if (!r || !r.kind || !r.name) { err('usage: kubectl delete pod|deployment|service|hpa NAME'); break; }
      const name = r.name;
      if (r.kind === 'namespace') {
        namespaceCmd(c, 'delete', name);
      } else if (r.kind === 'quota') {
        quotaCmd(c, 'delete', name);
      } else if (r.kind === 'pod') {
        const p = findPod(name);
        if (!p || p.phase === 'Terminating') { notFound('pod', name); break; }
        if (p.owner) s.flags.deletedOwned = p.owner; else s.flags.deletedBare = true;
        terminate(s, p);
        ok('pod "' + p.name + '" deleted');
        if (!p.owner) say('tip: nothing manages this pod, so it will not come back.', 'dim');
        else say('tip: it is owned by Deployment/' + p.owner + ' - watch a replacement appear.', 'dim');
      } else if (r.kind === 'deployment') {
        const d = depOf(s, keyOf(curNs, name));
        if (!d) { notFound('deployment', name); break; }
        s.deployments = s.deployments.filter(x => x !== d);
        s.hpas = s.hpas.filter(h => h.dep !== d.key);
        s.pods.filter(p => p.owner === d.key).forEach(p => terminate(s, p));
        s.flags.deletedDeployment = d.key;
        ok('deployment.apps "' + d.name + '" deleted');
      } else if (r.kind === 'job') {
        deleteJobCmd(c, name);
      } else if (r.kind === 'cronjob') {
        deleteCronJobCmd(c, name);
      } else if (r.kind === 'service') {
        const n = s.services.length;
        s.services = s.services.filter(v => !(v.name === name && v.ns === curNs));
        if (s.services.length === n) { notFound('service', name); break; }
        ok('service "' + name + '" deleted');
      } else if (r.kind === 'hpa') {
        const n = s.hpas.length;
        s.hpas = s.hpas.filter(h => h.dep !== name);
        if (s.hpas.length === n) { notFound('hpa', name); break; }
        ok('horizontalpodautoscaler "' + name + '" deleted');
      } else if (r.kind === 'secret') {
        const n = s.secrets.length;
        s.secrets = s.secrets.filter(x => x.name !== name);
        if (s.secrets.length === n) { notFound('secret', name); break; }
        ok('secret "' + name + '" deleted');
      } else if (r.kind === 'configmap') {
        const n = s.configmaps.length;
        s.configmaps = s.configmaps.filter(x => x.name !== name);
        if (s.configmaps.length === n) { notFound('configmap', name); break; }
        ok('configmap "' + name + '" deleted');
      } else err('error: cannot delete a ' + r.kind);
      break;
    }

    case 'describe': {
      const r = resRef(pos);
      if (r?.kind === 'quota' && !r.name) {
        const qs = s.quotas.filter(q => q.ns === curNs);
        if (!qs.length) say('No resources found in ' + curNs + ' namespace.', 'dim');
        qs.forEach((q, i) => { if (i) say(''); describeQuota(c, q.name); });
        break;
      }
      if (!r || !r.kind || !r.name) { err('usage: kubectl describe pod|node|deployment|service|quota|namespace NAME'); break; }
      const name = r.name;
      if (r.kind === 'quota') {
        describeQuota(c, name);
      } else if (r.kind === 'namespace') {
        if (!namespaces(s).includes(name)) { notFound('namespace', name); break; }
        say('Name:         ' + name); say('Status:       Active');
        say(name === 'kube-system' ? 'Description:  objects created by the Kubernetes system (control plane add-ons, DNS, proxy)' : 'Description:  <none>');
      } else if (r.kind === 'pod' && systemPodCmd(c, 'describe', name)) {
        break;
      } else if (r.kind === 'pod') {
        const p = findPod(name);
        if (!p) { notFound('pod', name); break; }
        s.flags.describedPod = true;
        if (crashed(p)) s.flags.inspectedCrash = true;
        const env = [p.config && 'ConfigMap/' + p.config, p.secret && 'Secret/' + p.secret].filter(Boolean).join(', ') || '<none>';
        const ctl = !p.owner ? '<none>  (bare pod: nothing will recreate it)' : p.owner.startsWith('job/') ? 'Job/' + p.owner.slice(4) : 'Deployment/' + p.owner.replace(/^.*\//, '');
        [
          'Name:           ' + p.name,
          'Namespace:      ' + p.ns,
          'Labels:         ' + labelText(p.labels),
          'Node:           ' + (p.node || p.ranOn || '<none>'),
          'Status:         ' + podStatus(p),
          'Image:          ' + p.image,
          'Requests:       cpu ' + p.cpuReq + 'm',
          'Limits:         ' + (p.memLimit === null ? '<none>' : 'memory ' + p.memLimit + 'Mi'),
          'Env from:       ' + env,
          'Restart Count:  ' + p.restarts,
          'Controlled By:  ' + ctl,
        ].forEach(l => say(l));
        if (p.reason === 'OOMKilled') say('Last State:     Terminated   Reason: OOMKilled   Exit Code: 137', 'warn');
        else if (p.phase === 'CrashLoopBackOff' || p.phase === 'Error') say('Last State:     Terminated (Error)   -> see: kubectl logs ' + p.name, 'warn');
        if (p.phase === 'ImagePullBackOff') say('Waiting:        ImagePullBackOff     -> is the image name correct?', 'warn');
        say('Events:');
        if (!p.events.length) say('  <none>', 'dim');
        else emit([['  Type', 'Reason', 'Age', 'Message'] as (string | number)[]].concat(p.events.map(e => ['  ' + e.type, e.reason, ageStr(s, e.t), e.msg])));
      } else if (r.kind === 'secret') {
        const c = s.secrets.find(x => x.name === name);
        if (!c) { notFound('secret', name); break; }
        say('Name:   ' + c.name); say('Type:   Opaque'); say('Data:');
        Object.keys(c.data).forEach(k => say('  ' + k + ':  ' + c.data[k].length + ' bytes   (value hidden)', 'dim'));
      } else if (r.kind === 'node') {
        const n = s.nodes.find(x => x.name === name);
        if (!n) { notFound('node', name); break; }
        say('Name:      ' + n.name); say('Status:    ' + (n.down ? 'NotReady' : 'Ready'), n.down ? 'err' : 'ok');
        say('Capacity:  ' + n.slots + ' pods');
        say('Pods:');
        const ps = s.pods.filter(p => p.node === n.name);
        if (!ps.length) say('  <none>', 'dim'); else ps.forEach(p => say('  ' + p.name + '   ' + p.phase));
        say('Allocated resources:  cpu ' + ps.reduce((a, p) => a + p.cpuReq, 0) + 'm of ' + NODE_CPU + 'm');
      } else if (r.kind === 'deployment') {
        const d = depOf(s, keyOf(curNs, name));
        if (!d) { notFound('deployment', name); break; }
        say('Name:           ' + d.name);
        say('Namespace:      ' + d.ns);
        say('Replicas:       ' + d.replicas + ' desired | ' + ownedPods(s, d.key).filter(p => p.tpl === tplOf(d)).length + ' updated | ' + readyCount(s, d.key) + ' available');
        say('Image:          ' + d.image);
        say('Requests:       cpu ' + d.res.cpu + 'm');
        say('Limits:         ' + (d.res.mem === null ? '<none>' : 'memory ' + d.res.mem + 'Mi'));
        say('Env from:       ' + ([d.config && 'ConfigMap/' + d.config, d.secret && 'Secret/' + d.secret].filter(Boolean).join(', ') || '<none>'));
        say('Paused:         ' + (d.frozen ? 'true' : 'false'));
        say('Strategy:       RollingUpdate (max surge 1, max unavailable 0)');
        if (d.blocked) s.flags.describedBlocked = true;
        if (d.blocked) { say('Events:'); say('  Warning  FailedCreate  ' + d.blocked, 'warn'); }
      } else if (r.kind === 'service') {
        const v = s.services.find(x => x.name === name && x.ns === curNs);
        if (!v) { notFound('service', name); break; }
        s.flags.describedService = true;
        say('Name:         ' + v.name); say('Namespace:    ' + v.ns); say('Selector:     ' + labelText(v.selector)); say('IP:           ' + v.ip);
        say('Port:         ' + v.port + '/TCP'); say('TargetPort:   ' + v.targetPort + '/TCP');
        const eps = endpoints(s, v).filter(p => p.phase === 'Running');
        say('Endpoints:    ' + (eps.length ? eps.map(p => '10.244.x.x:' + v.targetPort + ' (' + p.name + ')').join(', ') : '<none>  (no Ready pods match the selector!)'), eps.length ? '' : 'warn');
      } else if (r.kind === 'job') {
        describeJob(c, name);
      } else if (r.kind === 'cronjob') {
        describeCronJob(c, name);
      } else err('error: cannot describe a ' + r.kind);
      break;
    }

    case 'logs': logsCmd(c); break;

    case 'config': configCmd(c); break;
    case 'label': labelCmd(c); break;
    case 'patch': patchCmd(c); break;
    case 'exec': execCmd(c); break;
    case 'port-forward': portForwardCmd(c); break;

    case 'events': eventsCmd(c); break;

    case 'version': {
      say('Client Version: v1.30.2');
      say('Kustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3');
      say('Server Version: v1.30.2');
      break;
    }

    case 'cluster-info': {
      say('Kubernetes control plane is running at https://127.0.0.1:6443');
      say('CoreDNS is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy');
      say('');
      say("To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.");
      break;
    }

    case 'cordon': case 'uncordon': case 'drain': {
      const name = pos[0];
      if (!name) { err('usage: kubectl ' + verb + ' NODE'); break; }
      const n = s.nodes.find(x => x.name === name);
      if (!n) { notFound('node', name); break; }
      if (verb === 'uncordon') { n.unsched = false; ok('node/' + name + ' uncordoned'); break; }
      n.unsched = true;
      ok('node/' + name + ' cordoned');
      if (verb === 'drain') say('Warning: ignoring DaemonSet-managed Pods: none', 'dim');
      if (verb === 'drain') {
        const ps = s.pods.filter(p => p.node === name && p.phase !== 'Terminating');
        ps.forEach(p => { if (!p.owner) s.flags.deletedBare = true; terminate(s, p); });
        s.flags.drained = true; s.cpPulse = 1;
        ps.forEach(p => say('evicting pod default/' + p.name));
        ok('node/' + name + ' drained');
      }
      break;
    }

    default:
      err('error: unknown command "' + verb + '" for "kubectl"   (type help)');
  }
}

/** "cloud" is the provider console, not kubectl: nodes are machines you rent. */
function cloudCommand(s: State, toks: string[], out: Out): void {
  const { say, err, ok } = out;
  const E = s.level.econ;
  const sub = toks[0];
  const { pos, flags } = parseArgs(toks.slice(1));
  if (sub === 'add-node') {
    const max = E?.maxNodes ?? 4;
    if (s.nodes.length >= max) { err('QuotaExceeded: this account can run at most ' + max + ' nodes'); return; }
    const spot = !!flags.spot;
    if (spot && !E?.spotCost) { err('error: spot instances are not available in this mission'); return; }
    const name = 'node-' + (++s.nodeSeq);
    const n = makeNode(name, s.level.slots, spot, s.t + 5);
    n.announced = false;
    s.nodes.push(n);
    s.flags.addedNode = true;
    ok('node/' + name + ' requested (' + (spot ? 'spot' : 'on-demand') + '), ready in ~5s');
    if (E) say('You pay $' + (spot ? E.spotCost : E.nodeCost).toFixed(3) + '/s for it from now on.', 'dim');
  } else if (sub === 'remove-node') {
    const name = pos[0];
    if (!name) { err('usage: cloud remove-node NODE'); return; }
    const n = s.nodes.find(x => x.name === name);
    if (!n) { err('Error: node "' + name + '" not found'); return; }
    if (s.nodes.length <= 1) { err('error: cannot remove the last node'); return; }
    const pods = s.pods.filter(p => p.node === name);
    if (pods.length) { err('error: ' + name + ' still runs ' + pods.length + ' pod(s). Drain it first so they move gracefully:  kubectl drain ' + name); return; }
    s.nodes = s.nodes.filter(x => x !== n);
    s.flags.removedNode = true;
    ok('node/' + name + ' terminated. Billing stopped.');
  } else if (sub === 'list-nodes') {
    const rows: (string | number)[][] = [['NAME', 'TYPE', 'STATE', 'COST/s']];
    for (const n of s.nodes) {
      rows.push([n.name, n.spot ? 'spot' : 'on-demand', s.t < n.bootUntil ? 'provisioning' : n.down ? 'unreachable' : 'running', '$' + (n.spot ? (E?.spotCost ?? 0) : (E?.nodeCost ?? 0)).toFixed(3)]);
    }
    table(rows).forEach(l => say(l));
  } else if (sub === 'cost') {
    if (!E) { say('Billing is not enabled in this mission.', 'dim'); return; }
    s.flags.usedCost = true;
    const b = burnRate(s);
    const rr = revenueRate(s);
    const f = (x: number) => '$' + x.toFixed(3) + '/s';
    say('Cluster running cost');
    say('  on-demand nodes  ' + b.onDemand + ' x $' + E.nodeCost.toFixed(3) + '  = ' + f(b.nodes));
    if (b.spotN || E.spotCost) say('  spot nodes       ' + b.spotN + ' x $' + E.spotCost.toFixed(3) + '  = ' + f(b.spot));
    say('  pods             ' + b.podN + ' x $' + E.podCost.toFixed(3) + '  = ' + f(b.pods));
    say('  burn rate                        ' + f(b.total), 'warn');
    say('Revenue (last 10s)  $' + E.price.toFixed(2) + ' per request  = ' + f(rr), 'ok');
    say('Net right now                      ' + (rr - b.total >= 0 ? '+' : '-') + f(Math.abs(rr - b.total)), rr - b.total >= 0 ? 'ok' : 'err');
    say('Failed request penalty: $' + E.penalty.toFixed(2) + ' each');
    say('Profit so far $' + profit(s).toFixed(2) + '   (target $' + E.target.toFixed(2) + ' by ' + E.duration + 's)');
  } else err('usage: cloud add-node [--spot] | cloud remove-node NODE | cloud list-nodes | cloud cost');
}
