import {
  MINUTE, addDeployment, addService, createJob, depOf, endpoints, makePod, readyCount,
} from '../core/sim';
import type { Level, State } from '../core/types';

// Campaign 2: "Practitioner" (intermediate). Everyday kubectl beyond create/scale:
// Jobs, CronJobs, labels & selectors, resource requests/limits, exec & port-forward, pause/resume/restart/patch.

const svc = (s: State, name: string) => s.services.find(v => v.name === name);
const readyEndpoints = (s: State, name: string): number => {
  const v = svc(s, name);
  return v ? endpoints(s, v).filter(p => p.phase === 'Running').length : 0;
};

export const PRACTITIONER_LEVELS: Level[] = [
  {
    id: 'p-jobs', title: 'Run to Completion', tag: 'Jobs',
    blurb: 'One-off work that runs, finishes, and must not restart forever.',
    nodes: 2, slots: 4, traffic: null,
    setup(s) {
      createJob(s, { name: 'nightly-report', image: 'report:v1', command: ['python', 'report.py'] });
    },
    story: `<p>Not everything is a web server. Some work should run <b>once, to completion</b>: a report, a migration, a data import. For that Kubernetes has the <b>Job</b>. A Job runs a pod until it exits successfully, retries it when it fails, and gives up after a <i>backoff limit</i>.</p>
      <p>A finished pod is shown as <b>Completed</b> and keeps its logs, but no longer uses a node. Add your command after <code>--</code>:</p>
      <p><code>kubectl create job NAME --image=IMAGE -- COMMAND ARGS</code></p>
      <p>The ops team already started <code>nightly-report</code>, and it keeps failing. Investigate it, then get it to <b>Complete</b>.</p>`,
    objectives: [
      { id: 'hello', text: 'Create your own Job and let it Complete', check: s => s.jobs.some(j => j.name !== 'nightly-report' && j.status === 'Complete') },
      { id: 'logs', text: 'Read a Job\'s output with kubectl logs', check: s => !!s.flags.readJobLogs },
      { id: 'diagnose', text: 'Find out why nightly-report fails', check: s => !!s.flags.inspectedCrash },
      { id: 'fixed', text: 'Get nightly-report to Complete with a fixed image', check: s => s.jobs.some(j => j.name === 'nightly-report' && j.image === 'report:v2' && j.status === 'Complete') },
    ],
    cheats: ['kubectl create | create a Job', 'kubectl get | list jobs and pods', 'kubectl logs | output of a job or pod', 'kubectl describe | status and events', 'kubectl delete | remove a job'],
    hints: [
      'kubectl create job hello --image=busybox -- echo hello from a job',
      'kubectl get jobs shows STATUS and COMPLETIONS. kubectl logs job/hello prints what it echoed.',
      'kubectl logs job/nightly-report shows a Python traceback; the message names the fixed version of the image.',
      'A Job\'s pod template cannot be edited: kubectl delete job nightly-report, then create it again with --image=report:v2 -- python report.py',
    ],
    codex: { title: 'Jobs', text: 'A <b>Job</b> runs pods to completion. Success = the container exits 0 (pod shows <b>Completed</b>). On failure the Job starts a new pod, with growing delays, until the <i>backoffLimit</i> is hit and the Job is marked <b>Failed</b>. Logs of finished pods stay available; <code>kubectl logs job/NAME</code> reads them.' },
  },

  {
    id: 'p-cron', title: 'On a Schedule', tag: 'CronJobs',
    blurb: 'Run a Job every minute without lifting a finger.',
    nodes: 2, slots: 4, traffic: null,
    story: `<p>A <b>CronJob</b> creates a Job on a schedule, in cron syntax: <code>minute hour day month weekday</code>. <code>*/1 * * * *</code> means <i>every minute</i>.</p>
      <p><b>Time is compressed here:</b> one cron minute lasts 10 real seconds.</p>
      <p>Set up a <code>backup</code> CronJob that runs every minute and echoes a message. Watch the Jobs it spawns (the 3 newest finished ones are kept), trigger an extra run by hand from the same template, and finally <b>suspend</b> the CronJob so it stops scheduling.</p>`,
    objectives: [
      { id: 'create', text: 'Create CronJob "backup" running every minute', check: s => s.cronjobs.some(c => c.name === 'backup' && c.period === MINUTE) },
      { id: 'runs', text: 'Let it run at least 3 times', check: s => s.cronjobs.some(c => c.name === 'backup' && c.counter >= 3) },
      { id: 'manual', text: 'Trigger a one-off run from the CronJob', check: s => !!s.flags.manualJob },
      { id: 'suspend', text: 'Suspend the CronJob', check: s => !!s.flags.suspendedCron && s.cronjobs.some(c => c.name === 'backup' && c.suspend) },
    ],
    cheats: ['kubectl create | create a CronJob, or a Job from one', 'kubectl get | list cronjobs and jobs', 'kubectl patch | change a field (suspend)', 'kubectl describe | schedule and last run'],
    hints: [
      'kubectl create cronjob backup --image=busybox --schedule="*/1 * * * *" -- echo backing up',
      'kubectl get cronjobs, then kubectl get jobs after ~10s: a new Job appears for every run.',
      'kubectl create job backup-now --from=cronjob/backup',
      'kubectl patch cronjob backup -p \'{"spec":{"suspend":true}}\'',
    ],
    codex: { title: 'CronJobs', text: 'A <b>CronJob</b> stamps out a <b>Job</b> every time its cron schedule matches. <code>kubectl create job X --from=cronjob/Y</code> runs it once on demand; setting <code>spec.suspend</code> via <code>kubectl patch</code> pauses scheduling without deleting history. Old finished Jobs are pruned automatically.' },
  },

  {
    id: 'p-labels', title: 'Lost in the Selectors', tag: 'Labels & selectors',
    blurb: 'The Service has no endpoints. The pods are right there.',
    nodes: 3, slots: 4,
    traffic: { app: 'shop', profile: [{ from: 0, to: 9999, rps: 1.5 }], maxFail: 12, stars: [2, 6] },
    setup(s) {
      addDeployment(s, { name: 'shop', image: 'nginx', replicas: 3 });
      addService(s, 'shop', { app: 'shopp' });     // typo in the selector
    },
    story: `<p>The <code>shop</code> Deployment is healthy, three pods Running, yet users get nothing. A <b>Service</b> finds its pods through a <b>label selector</b>, and it routes only to pods carrying <i>all</i> those labels.</p>
      <p>Compare what the Service selects (<code>kubectl describe service</code>) with what the pods carry (<code>kubectl get pods --show-labels</code>), then fix the mismatch with <code>kubectl set selector</code>.</p>
      <p>Then run a <b>canary</b>: label one pod <code>track=canary</code> and expose just that pod as its own Service. <code>kubectl expose pod</code> uses the <i>pod's labels</i> as the selector.</p>`,
    objectives: [
      { id: 'diagnose', text: 'Inspect the shop Service', check: s => !!s.flags.describedService },
      { id: 'fix', text: 'Fix the selector so shop has 3 ready endpoints', check: s => readyEndpoints(s, 'shop') >= 3 },
      { id: 'canary', text: 'Expose one canary pod as Service shop-canary', check: s => { const v = svc(s, 'shop-canary'); return !!v && v.selector.track === 'canary' && readyEndpoints(s, 'shop-canary') === 1; } },
      { id: 'live', text: 'Open the cluster to traffic', check: s => s.mode === 'live' },
      { id: 'served', text: 'Serve 25 requests', check: s => s.stats.served >= 25 },
    ],
    cheats: ['kubectl describe | selector and endpoints of a Service', 'kubectl get | pods with --show-labels, or -l filter', 'kubectl set selector | change what a Service selects', 'kubectl label | add a label to a pod', 'kubectl expose | Service from a pod\'s labels'],
    hints: [
      'kubectl describe service shop shows Selector and Endpoints: <none>. kubectl get pods --show-labels shows the real labels.',
      'kubectl set selector service shop app=shop',
      'kubectl label pods POD track=canary, then kubectl get pods -l track=canary',
      'kubectl expose pod POD --name=shop-canary --port=80. Open to traffic when both Services work.',
    ],
    codex: { title: 'Labels & Selectors', text: '<b>Labels</b> are key/value tags on objects. A <b>selector</b> picks objects by label: Services use it to find pods, <code>kubectl get -l</code> uses it to filter. A selector with a typo matches nothing, so the Service has <i>no endpoints</i>. <code>kubectl label</code> adds or changes labels; <code>kubectl set selector</code> repoints a Service.' },
  },

  {
    id: 'p-limits', title: 'Right-Sized', tag: 'Requests, limits & OOMKilled',
    blurb: 'One workload is killed for memory, the other is too greedy to schedule.',
    nodes: 3, slots: 4, traffic: null,
    setup(s) {
      addDeployment(s, { name: 'api', image: 'api:v3', replicas: 2, res: { cpu: 100, mem: 64 } });
      addDeployment(s, { name: 'worker', image: 'nginx', replicas: 4, res: { cpu: 1200 } });
    },
    story: `<p>Every container can declare <b>requests</b> (what the scheduler reserves) and <b>limits</b> (a hard ceiling). Get them wrong and things break in two classic ways:</p>
      <ul><li><b>OOMKilled</b>: the app uses more memory than its <i>limit</i>, so the kernel kills it (exit code 137) and Kubernetes restarts it, again and again.</li>
      <li><b>Pending / Insufficient cpu</b>: the pod <i>requests</i> more CPU than any node has free. Each node here has 2000m.</li></ul>
      <p>Fix <code>api</code> (it needs about 128Mi) and <code>worker</code> (4 replicas at 1200m cannot all fit), using <code>kubectl set resources</code>. Changing a pod template triggers a rolling update.</p>`,
    objectives: [
      { id: 'inspect', text: 'Find out why api keeps dying (describe)', check: s => !!s.flags.inspectedCrash },
      { id: 'api', text: 'Get both api pods Running', check: s => readyCount(s, 'api') >= 2 },
      { id: 'worker', text: 'Get all 4 worker pods Running', check: s => readyCount(s, 'worker') >= 4 },
      { id: 'resources', text: 'Use kubectl set resources', check: s => !!s.flags.setResources },
    ],
    cheats: ['kubectl get | pods and their status', 'kubectl describe | OOMKilled, FailedScheduling events', 'kubectl set resources | requests and limits', 'kubectl top | CPU use per pod'],
    hints: [
      'kubectl describe pod on an api pod shows Last State: OOMKilled and a 64Mi memory limit. The image needs more.',
      'kubectl set resources deployment api --limits=memory=256Mi',
      'kubectl describe pod on the Pending worker pod says Insufficient cpu. Each node can fit only one 1200m pod.',
      'kubectl set resources deployment worker --requests=cpu=250m',
    ],
    codex: { title: 'Requests, Limits & OOMKilled', text: 'The scheduler places a pod only where its <b>requests</b> fit. A <b>memory limit</b> that is too low gets the container <b>OOMKilled</b> (exit 137) in a restart loop; too large a <b>CPU request</b> leaves the pod <b>Pending</b> with <i>Insufficient cpu</i>. <code>kubectl set resources</code> edits both; <code>describe</code> shows the reason.' },
  },

  {
    id: 'p-ports', title: 'Connection Refused', tag: 'exec, port-forward & ports',
    blurb: 'Everything is Running, yet every request is refused.',
    nodes: 3, slots: 4,
    traffic: { app: 'web', profile: [{ from: 0, to: 9999, rps: 1.5 }], maxFail: 12, stars: [2, 6] },
    setup(s) {
      addDeployment(s, { name: 'web', image: 'nginx', replicas: 3 });
      addService(s, 'web', 'web', 80, 8080);        // targetPort does not match what nginx listens on
      makePod(s, { name: 'toolbox', app: 'toolbox', labels: { run: 'toolbox' }, image: 'toolbox', tpl: 'toolbox|||100||0' });
    },
    story: `<p>The <code>web</code> Service has endpoints and the pods are Running, but connections are <b>refused</b>. When "kubectl get" looks fine you have to look <i>from the inside</i>.</p>
      <p><code>kubectl exec</code> runs a command in a container. A <code>toolbox</code> pod is already running for exactly this: use it to call the Service the way another app would. <code>kubectl port-forward</code> tunnels a local port to a pod so you can test the app directly.</p>
      <p>A Service has a <b>port</b> (what clients use) and a <b>targetPort</b> (where the container really listens). nginx listens on <b>80</b>. Find the mismatch and fix it.</p>`,
    objectives: [
      { id: 'exec', text: 'Call the Service from inside the toolbox pod', check: s => !!s.flags.usedExec },
      { id: 'forward', text: 'Port-forward to a web pod on its real port', check: s => !!s.flags.portForwarded },
      { id: 'fix', text: 'Fix the Service so its targetPort matches nginx', check: s => s.services.some(v => v.name === 'web' && v.targetPort === 80) },
      { id: 'live', text: 'Open the cluster to traffic', check: s => s.mode === 'live' },
      { id: 'served', text: 'Serve 25 requests', check: s => s.stats.served >= 25 },
    ],
    cheats: ['kubectl exec | run a command in a pod', 'kubectl port-forward | tunnel a local port to a pod', 'kubectl describe | Service port and targetPort', 'kubectl delete | remove the broken Service', 'kubectl expose | recreate it correctly'],
    hints: [
      'kubectl exec toolbox -- wget -qO- http://web. It fails with Connection refused.',
      'kubectl describe service web: Port 80, TargetPort 8080, but nginx listens on 80.',
      'kubectl port-forward pod/POD 8080:80 works, while 8080:8080 fails: nothing listens on 8080.',
      'kubectl delete service web, then kubectl expose deployment web --port=80 --target-port=80',
    ],
    codex: { title: 'Ports, exec & port-forward', text: 'A Service <b>port</b> is what clients dial; <b>targetPort</b> is the container port traffic is sent to. If they disagree with what the app listens on you get <i>Connection refused</i> while everything looks healthy. <code>kubectl exec</code> debugs from inside the cluster; <code>kubectl port-forward</code> tests a pod from your machine.' },
  },

  {
    id: 'p-release', title: 'Release Night', tag: 'rollout pause / resume / restart, patch',
    blurb: 'Batch your changes into one clean rollout, then bump replicas live.',
    nodes: 3, slots: 4,
    traffic: { app: 'web', profile: [{ from: 0, to: 9999, rps: 3 }], maxFail: 10, stars: [2, 5] },
    setup(s) {
      addDeployment(s, { name: 'web', image: 'web:v1', replicas: 4 });
      addService(s, 'web', 'web');
    },
    story: `<p>Every change to a pod template starts a rolling update. Change the image, then the resources, and you roll twice. To make several changes as <b>one</b> rollout, <b>pause</b> the Deployment, edit freely (nothing happens), then <b>resume</b>.</p>
      <p>Tonight's release: move <code>web</code> to <code>web:v2</code> with a CPU request of <b>200m</b>, as a single rollout. Afterwards use <code>kubectl rollout restart</code> to bounce all pods gracefully, and finally scale to <b>5</b> replicas with <code>kubectl patch</code> for the traffic peak.</p>
      <p>Traffic is live-ish: open it when you are ready, and keep failures low.</p>`,
    objectives: [
      { id: 'pause', text: 'Pause the web rollout', check: s => !!s.flags.pausedRollout },
      { id: 'batch', text: 'While paused: set image web:v2 and 200m CPU (no pod changes)', check: s => { const d = depOf(s, 'web'); return !!d && !!d.frozen && d.image === 'web:v2' && d.res.cpu === 200 && d.rollouts === 0; } },
      { id: 'resume', text: 'Resume: one rollout brings every pod to v2', check: s => { const d = depOf(s, 'web'); return !!d && !d.frozen && d.rollouts === 1 && readyCount(s, 'web') >= d.replicas && s.pods.filter(p => p.owner === 'web' && p.phase !== 'Terminating').every(p => p.image === 'web:v2' && p.cpuReq === 200); } },
      { id: 'restart', text: 'Restart the Deployment with a rolling restart', check: s => { const d = depOf(s, 'web'); return !!s.flags.restartedRollout && !!d && readyCount(s, 'web') >= d.replicas && s.pods.filter(p => p.owner === 'web' && p.phase !== 'Terminating').every(p => p.tpl.endsWith('|1')); } },
      { id: 'patch', text: 'Patch web to 5 replicas', check: s => !!s.flags.patched && readyCount(s, 'web') >= 5 },
      { id: 'live', text: 'Open the cluster to traffic', check: s => s.mode === 'live' },
      { id: 'served', text: 'Serve 40 requests', check: s => s.stats.served >= 40 },
    ],
    cheats: ['kubectl rollout | pause, resume, restart, status', 'kubectl set image | change the image', 'kubectl set resources | requests and limits', 'kubectl patch | change a field in place', 'kubectl get | watch the pods roll'],
    hints: [
      'kubectl rollout pause deployment/web',
      'kubectl set image deployment/web web=web:v2, then kubectl set resources deployment web --requests=cpu=200m. kubectl get pods: nothing changes yet.',
      'kubectl rollout resume deployment/web, then watch kubectl rollout status deployment/web',
      'kubectl rollout restart deployment/web, wait for it, then kubectl patch deployment web -p \'{"spec":{"replicas":5}}\'',
    ],
    codex: { title: 'Pause, Resume, Restart, Patch', text: '<code>kubectl rollout pause</code> lets you queue several template changes and <code>resume</code> applies them as <b>one rollout</b>. <code>rollout restart</code> recreates pods gradually without changing the spec (useful to pick up changed config). <code>kubectl patch</code> edits a single field in place, for example <code>spec.replicas</code>.' },
  },
];
