import {
  addDeployment, addService, banner, depOf, makePod, nodeDown, readyCount, recordRevision, setImage,
} from '../core/sim';
import type { Level, State } from '../core/types';

// Campaign 3: "Elite". Advanced kubectl: structured output (jsonpath, custom-columns, sort-by, field selectors),
// bulk operations, revision-based rollbacks, event and log forensics, capacity analysis, and a full incident.

const allRunning = (s: State, dep: string, n: number): boolean => {
  const own = s.pods.filter(p => p.owner === dep && p.phase !== 'Terminating');
  return own.length >= n && own.every(p => p.phase === 'Running');
};
const live = (s: State, label: string) => s.pods.filter(p => p.labels.env === label && p.phase !== 'Terminating');

export const ELITE_LEVELS: Level[] = [
  {
    id: 'e-query', title: 'Needle in a Haystack', tag: '-o, jsonpath, custom-columns, sort-by',
    blurb: 'Stop reading tables. Ask the cluster exactly what you want.',
    nodes: 3, slots: 6, traffic: null,
    setup(s) {
      addDeployment(s, { name: 'web', image: 'nginx', replicas: 3 });
      addDeployment(s, { name: 'cart', image: 'nginx', replicas: 2 });
      addDeployment(s, { name: 'batch', image: 'busybox', replicas: 2 });
      addDeployment(s, { name: 'search', image: 'web:v2', replicas: 2 });
      setImage(s, 'search', 'web:v2-broken');
    },
    story: `<p>Tables are for humans skimming a small cluster. Real clusters have hundreds of pods, and scripts need <b>exact fields</b>. Every object has a full document behind it. <code>-o yaml</code> and <code>-o json</code> print it, and you can slice it in several ways:</p>
      <ul><li><code>-o name</code>: just <code>pod/NAME</code>, one per line, perfect for scripts.</li>
      <li><code>-o jsonpath='{.items[*].metadata.name}'</code>: pull a field out of every item.</li>
      <li><code>-o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName</code>: build your own table.</li>
      <li><code>--sort-by=.metadata.creationTimestamp</code>: order the list by any field.</li>
      <li><code>--field-selector=spec.nodeName=node-1</code>: filter on <i>fields</i>, where <code>-l</code> filters on <i>labels</i>.</li></ul>
      <p>Something in this cluster is broken. Practise each trick, then find it and fix it. (Careful: in the API a crash-looping pod still has <code>status.phase=Running</code>. The <i>phase</i> is coarser than the STATUS column.)</p>`,
    objectives: [
      { id: 'name', text: 'List pods with -o name', check: s => !!s.flags.usedOutputName },
      { id: 'yaml', text: 'Dump one pod as yaml or json', check: s => !!s.flags.usedJsonYaml },
      { id: 'jsonpath', text: 'Extract a field from every pod with -o jsonpath', check: s => !!s.flags.usedJsonpath },
      { id: 'columns', text: 'Build your own table with -o custom-columns', check: s => !!s.flags.usedCustomColumns },
      { id: 'sort', text: 'Sort pods with --sort-by', check: s => !!s.flags.usedSortBy },
      { id: 'field', text: 'Filter pods with --field-selector', check: s => !!s.flags.usedFieldSelector },
      { id: 'fix', text: 'Find and fix the crashing Deployment', check: s => allRunning(s, 'search', 2) },
    ],
    cheats: ['kubectl get | pods, with -o and --sort-by', 'kubectl describe | status and events', 'kubectl set image | change the image', 'kubectl rollout undo | go back one revision'],
    hints: [
      'kubectl get pods -o name   and   kubectl get pod POD -o yaml. You can pass any pod name.',
      "kubectl get pods -o jsonpath='{.items[*].spec.containers[0].image}' prints every image on one line. Use {range .items[*]}{.metadata.name}{\"\\n\"}{end} for one per line.",
      'kubectl get pods -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image,NODE:.spec.nodeName',
      'kubectl get pods --sort-by=.metadata.name, and kubectl get pods --field-selector=spec.nodeName=node-1',
      'The search pods run web:v2-broken. kubectl set image deployment/search search=web:v2 (or kubectl rollout undo deployment/search).',
    ],
    codex: { title: 'Output formats & selectors', text: 'Every kubectl object is a document. <code>-o json|yaml</code> prints it, <code>-o name</code> prints <code>kind/name</code>, <code>-o jsonpath=\'{...}\'</code> extracts fields (use <code>{range .items[*]}...{end}</code> to loop), and <code>-o custom-columns=HEADER:.path</code> builds a table. <code>--sort-by=.path</code> orders a list, <code>-l</code> filters by <b>labels</b>, <code>--field-selector</code> by <b>fields</b> such as <code>status.phase</code> or <code>spec.nodeName</code>.' },
  },

  {
    id: 'e-clean', title: 'Spring Cleaning', tag: 'Bulk delete, selectors, scale guards',
    blurb: 'The cluster is full of leftovers. Clear them without hurting staging.',
    nodes: 3, slots: 4,
    traffic: { app: 'shop', profile: [{ from: 0, to: 9999, rps: 4 }], maxFail: 12, stars: [2, 6] },
    setup(s) {
      addDeployment(s, { name: 'shop', image: 'nginx', replicas: 3 });
      addService(s, 'shop', 'shop');
      for (let i = 1; i <= 6; i++) makePod(s, { name: 'loadtest-' + i, app: 'loadtest', labels: { env: 'test' }, image: 'nginx', tpl: 'nginx|||100||0' });
      for (let i = 1; i <= 3; i++) makePod(s, { name: 'stage-' + i, app: 'stage', labels: { env: 'staging' }, image: 'nginx', tpl: 'nginx|||100||0' });
    },
    story: `<p>An old load test left <b>six pods</b> behind, and the cluster is full: <code>shop</code> needs to grow to <b>6 replicas</b> for the weekend, but there is no room. Deleting pods one by one is slow and error-prone. Kubectl can delete by selector:</p>
      <ul><li><code>kubectl delete pods -l env=test</code>: every pod with that label, in one command.</li>
      <li><code>kubectl delete pods --field-selector=status.phase=Succeeded</code>: by field.</li>
      <li><code>kubectl delete pods --all</code>: <b>everything</b>. Be very sure.</li></ul>
      <p>Three <code>env=staging</code> pods share this cluster and must <b>survive</b>. First look at what runs on <code>node-3</code> with <code>--field-selector</code>, then clean up with a single command, then scale <code>shop</code> to 6 with a safety guard: <code>--current-replicas=3</code> makes the scale fail if someone else changed it meanwhile.</p>
      <p>If you delete the staging pods by mistake, restart the mission.</p>`,
    objectives: [
      { id: 'field', text: 'List the pods on node-3 with --field-selector', check: s => !!s.flags.usedFieldSelector },
      { id: 'bulk', text: 'Remove all 6 env=test pods with ONE command, keeping the 3 staging pods', check: s => (s.flags.bulkDeleted ?? 0) >= 6 && live(s, 'test').length === 0 && live(s, 'staging').length === 3 },
      { id: 'scale', text: 'Scale shop to 6 with --current-replicas=3', check: s => { const d = depOf(s, 'shop'); return !!s.flags.guardedScale && !!d && d.replicas === 6 && readyCount(s, 'shop') >= 6; } },
      { id: 'live', text: 'Open the cluster to traffic', check: s => s.mode === 'live' },
      { id: 'served', text: 'Serve 30 requests', check: s => s.stats.served >= 30 },
    ],
    cheats: ['kubectl get | pods, with --show-labels and --field-selector', 'kubectl delete | many pods at once', 'kubectl scale | with a precondition', 'kubectl describe | where a pod runs'],
    hints: [
      'kubectl get pods -o wide shows the NODE column. kubectl get pods --field-selector=spec.nodeName=node-3 filters on it.',
      'kubectl get pods --show-labels shows which pods carry env=test. Check the selector before you delete.',
      'kubectl delete pods -l env=test removes all six in one go. Never use --all here: staging would go too.',
      'kubectl scale deployment shop --replicas=6 --current-replicas=3. Then open the cluster to traffic.',
    ],
    codex: { title: 'Bulk operations', text: '<code>kubectl delete pods -l key=value</code> and <code>--field-selector</code> act on <b>every</b> match at once; <code>--all</code> matches everything in the namespace. Always run the same selector with <code>kubectl get</code> first. <code>kubectl scale --current-replicas=N</code> adds an optimistic-concurrency guard: the scale only happens if the Deployment still has N replicas.' },
  },

  {
    id: 'e-time', title: 'Time Machine', tag: 'rollout history & undo --to-revision',
    blurb: 'Four releases, three of them bad. Go back to the last good one.',
    nodes: 3, slots: 4,
    traffic: { app: 'web', profile: [{ from: 0, to: 9999, rps: 3 }], maxFail: 10, stars: [2, 5] },
    setup(s) {
      const d = addDeployment(s, { name: 'web', image: 'web:v1', replicas: 4 });
      addService(s, 'web', 'web');
      d.image = 'web:v2'; recordRevision(d);
      d.image = 'web:v3-broken'; recordRevision(d);
      d.res = { cpu: 300, mem: null }; recordRevision(d);
    },
    story: `<p>A Deployment remembers its past <b>revisions</b>. <code>kubectl rollout history deployment/web</code> lists them, and <code>--revision=N</code> shows what one of them contained.</p>
      <p><code>kubectl rollout undo</code> alone goes back <b>one</b> revision, which is not always enough. Tonight a bad release (<code>v3-broken</code>) shipped, then someone "fixed" it by raising the CPU request instead of the image: revision 4 is as broken as revision 3. <code>kubectl rollout undo deployment/web --to-revision=N</code> jumps straight to the revision you pick.</p>
      <p>Inspect the history, find the last good release (revision 2), roll back to it, then open the doors and serve traffic.</p>`,
    objectives: [
      { id: 'inspect', text: 'Inspect one revision with rollout history --revision', check: s => !!s.flags.inspectedRevision },
      { id: 'undo', text: 'Roll back to the last good revision (web:v2)', check: s => { const d = depOf(s, 'web'); return !!d && d.image === 'web:v2' && !!s.flags.undoneToRevision && allRunning(s, 'web', 4); } },
      { id: 'live', text: 'Open the cluster to traffic', check: s => s.mode === 'live' },
      { id: 'served', text: 'Serve 40 requests', check: s => s.stats.served >= 40 },
    ],
    cheats: ['kubectl rollout history | list revisions', 'kubectl rollout undo | roll back', 'kubectl rollout status | is it done?', 'kubectl get | the pods'],
    hints: [
      'kubectl rollout history deployment/web lists four revisions. Add --revision=2 to see what revision 2 contained.',
      'Compare revisions 2, 3 and 4 with --revision=N. Revision 3 and 4 run web:v3-broken.',
      'kubectl rollout undo deployment/web --to-revision=2',
      'kubectl rollout status deployment/web waits until the rollback is done. Then open the cluster to traffic.',
    ],
    codex: { title: 'Revisions & rollbacks', text: 'Each change to the pod template is a <b>revision</b>. <code>rollout history</code> lists them; <code>--revision=N</code> prints one. <code>rollout undo</code> returns to the previous revision, and <code>--to-revision=N</code> to any earlier one. Rolling back is itself a rolling update, so pods are replaced gradually.' },
  },

  {
    id: 'e-detect', title: 'Detective Work', tag: 'events, logs -l, --previous',
    blurb: 'Three services, three different diseases. Find the evidence.',
    nodes: 3, slots: 6, traffic: null,
    setup(s) {
      addDeployment(s, { name: 'cart', image: 'api:v3', replicas: 2, res: { mem: 64 } });
      addDeployment(s, { name: 'billing', image: 'pay:v1', replicas: 2 });
      addDeployment(s, { name: 'search', image: 'web:v2', replicas: 2 });
      setImage(s, 'search', 'web:v2-broken');
      addDeployment(s, { name: 'web', image: 'nginx', replicas: 2 });
    },
    story: `<p>Three Deployments are unhealthy, each for a <b>different</b> reason, and one healthy bystander (<code>web</code>) is mixed in. Gather evidence before touching anything:</p>
      <ul><li><code>kubectl events --types=Warning</code>: only the bad news, across the cluster. <code>--for=pod/NAME</code> narrows it to one object.</li>
      <li><code>kubectl logs -l app=billing</code>: logs of <i>every</i> pod behind a label, each line prefixed with its pod. <code>--tail=N</code> keeps the last N lines.</li>
      <li><code>kubectl logs POD --previous</code>: the output of the container that <i>just crashed</i>, not the one now waiting to restart.</li>
      <li><code>kubectl logs deployment/NAME</code>: let kubectl pick a pod for you.</li></ul>
      <p>Fix all three. For the record, the <code>billing</code> API key from the release notes is <code>sk_live_9f2c41</code> (store it as a Secret, never a ConfigMap).</p>`,
    objectives: [
      { id: 'events', text: 'Read only the warnings with kubectl events --types=Warning', check: s => !!s.flags.filteredEvents },
      { id: 'logs', text: 'Read logs by label (-l) or with --previous', check: s => !!s.flags.usedLogsSelector || !!s.flags.usedPrevious },
      { id: 'cart', text: 'Fix cart', check: s => allRunning(s, 'cart', 2) },
      { id: 'billing', text: 'Fix billing', check: s => allRunning(s, 'billing', 2) },
      { id: 'search', text: 'Fix search', check: s => allRunning(s, 'search', 2) },
    ],
    cheats: ['kubectl events | warnings and per-object events', 'kubectl logs | with -l, --previous, --tail', 'kubectl describe | reasons like OOMKilled', 'kubectl set resources | requests and limits', 'kubectl create secret | store credentials', 'kubectl set env | inject config', 'kubectl rollout undo | previous revision'],
    hints: [
      'kubectl events --types=Warning lists BackOff, OOMKilled and image problems. Which Deployments do they point to?',
      'kubectl logs -l app=billing shows the FATAL line. kubectl logs -l app=search --tail=2 shows a panic.',
      'cart: describe a pod, it is OOMKilled at 64Mi. kubectl set resources deployment cart --limits=memory=256Mi',
      'billing: kubectl create secret generic pay --from-literal=API_KEY=sk_live_9f2c41, then kubectl set env deployment/billing --from=secret/pay',
      'search: kubectl rollout undo deployment/search (or set the image back to web:v2).',
    ],
    codex: { title: 'Forensics: events & logs', text: '<code>kubectl events --types=Warning --for=pod/NAME</code> filters the event stream. <code>kubectl logs -l app=X</code> reads many pods at once, <code>--tail=N</code> keeps the end, <code>--previous</code> shows the last <i>terminated</i> container (the one that crashed), and <code>logs deployment/NAME</code> picks a pod for you. Combine <code>describe</code> (reasons), <code>events</code> (timeline) and <code>logs</code> (the app\'s own words).' },
  },

  {
    id: 'e-capacity', title: 'Capacity Planner', tag: 'top nodes, sort, right-sizing, drain',
    blurb: 'The cluster looks full but idles. Find the hog, then take a node out.',
    nodes: 3, slots: 8,
    traffic: { app: 'web', profile: [{ from: 0, to: 9999, rps: 3 }], maxFail: 12, stars: [2, 6] },
    setup(s) {
      addDeployment(s, { name: 'hog', image: 'nginx', replicas: 6, res: { cpu: 900 } });
      addDeployment(s, { name: 'web', image: 'nginx', replicas: 6, res: { cpu: 300 } });
      addService(s, 'web', 'web');
    },
    story: `<p>None of the 6 <code>web</code> pods can start: they are <b>Pending</b>, yet the nodes are nearly idle. The scheduler places pods by <b>requests</b>, not actual use, and <code>hog</code> reserves 900m CPU per pod (a node has 2000m).</p>
      <p>Prove it with data: <code>kubectl top nodes</code> shows real use per node and <code>kubectl top pods --sort-by=cpu</code> ranks the pods. <code>kubectl describe node</code> shows what is <i>allocated</i>. Then right-size <code>hog</code> to a request of <b>200m</b> or less (<code>kubectl set resources</code>) so all 6 <code>web</code> pods fit.</p>
      <p>Finally the nodes need maintenance: <b>cordon and drain node-3</b> while <code>web</code> keeps serving, and serve some traffic.</p>`,
    objectives: [
      { id: 'topnodes', text: 'Read node usage with kubectl top nodes', check: s => !!s.flags.usedTopNodes },
      { id: 'topsort', text: 'Rank pods with kubectl top pods --sort-by', check: s => !!s.flags.usedTopSort },
      { id: 'rightsize', text: 'Right-size hog to 200m CPU or less, all 6 pods Running', check: s => { const d = depOf(s, 'hog'); return !!d && d.res.cpu <= 200 && allRunning(s, 'hog', 6); } },
      { id: 'web', text: 'Get all 6 web pods Running', check: s => readyCount(s, 'web') >= 6 },
      { id: 'drain', text: 'Drain node-3 (cordoned, no pods left)', check: s => { const n = s.nodes.find(x => x.name === 'node-3'); return !!n && n.unsched && !!s.flags.drained && s.pods.every(p => p.node !== 'node-3'); } },
      { id: 'live', text: 'Open the cluster to traffic', check: s => s.mode === 'live' },
      { id: 'served', text: 'Serve 30 requests', check: s => s.stats.served >= 30 },
    ],
    cheats: ['kubectl top | usage of nodes and pods', 'kubectl describe | allocated resources of a node', 'kubectl set resources | change requests', 'kubectl drain | evict pods from a node', 'kubectl get | pods and their status'],
    hints: [
      'kubectl top nodes and kubectl top pods --sort-by=cpu. Use is tiny, but requests are huge.',
      'kubectl describe node node-1 ends with "Allocated resources: cpu 1800m of 2000m": only 200m is left, and web asks for 300m.',
      'kubectl set resources deployment hog --requests=cpu=200m. The new hog pods fit in the 200m left, and the old ones free room for web.',
      'kubectl drain node-3, then open the cluster to traffic. Check kubectl get pods -o wide: nothing on node-3.',
    ],
    codex: { title: 'Requests vs. real usage', text: 'The scheduler reserves a pod\'s <b>requests</b> whether or not they are used, so a few greedy requests can strand a cluster while <code>kubectl top</code> shows idle CPU. <code>top nodes</code> and <code>top pods --sort-by=cpu</code> show actual use; <code>describe node</code> shows what is <i>allocated</i>. Fix by right-sizing requests, and drain nodes only when the rest can hold the load.' },
  },

  {
    id: 'e-finale', title: 'Black Friday', tag: 'Incident response',
    blurb: 'A bad deploy, a traffic wave and a dead node. All at once.',
    nodes: 4, slots: 6,
    traffic: { app: 'web', profile: [{ from: 0, to: 15, rps: 3 }, { from: 15, to: 60, rps: 11 }, { from: 60, to: 9999, rps: 5 }], maxFail: 30, stars: [6, 16] },
    setup(s) {
      addDeployment(s, { name: 'web', image: 'web:v1', replicas: 4 });
      setImage(s, 'web', 'web:v2');
      addDeployment(s, { name: 'api', image: 'api:v3', replicas: 2, res: { mem: 256 } });
      addService(s, 'web', 'web');
      addService(s, 'api', 'api', 80, 8080);
    },
    events: [
      { at: 12, run: s => { setImage(s, 'web', 'web:v3-broken'); banner(s, 'A teammate just shipped web:v3-broken to production!'); } },
      { at: 35, run: s => nodeDown(s, 'node-2', 25, 'node-2 lost power! (NotReady for 25s)') },
    ],
    story: `<p>It is Black Friday. Everything you learned is needed <b>at once</b>:</p>
      <ul><li>Traffic jumps from 3 to <b>11 requests/second</b> at 15 seconds. Four pods are not enough.</li>
      <li>A teammate ships a <b>broken release</b> of <code>web</code> at 12 seconds. Find it and roll it back.</li>
      <li><code>node-2</code> loses power at 35 seconds.</li></ul>
      <p>Open the doors when ready, but prepare first. Use <code>-o jsonpath</code> or <code>custom-columns</code> to see what runs where, set up an autoscaler (<code>kubectl autoscale</code>, up to at least 8 pods), keep <code>web</code> on <code>web:v2</code>, and serve <b>300 requests</b> without losing more than 30.</p>`,
    objectives: [
      { id: 'inspect', text: 'Inspect the cluster with -o jsonpath or custom-columns', check: s => !!s.flags.usedJsonpath || !!s.flags.usedCustomColumns },
      { id: 'hpa', text: 'Autoscale web up to at least 8 pods', check: s => s.hpas.some(h => h.dep === 'web' && h.max >= 8) },
      { id: 'live', text: 'Open the cluster to traffic', check: s => s.mode === 'live' },
      { id: 'rollback', text: 'Recover web from the broken release (back on web:v2, all healthy)', check: s => { const d = depOf(s, 'web'); return !!s.evFired[0] && !!d && d.image === 'web:v2' && allRunning(s, 'web', 4); } },
      { id: 'survive', text: 'Serve 300 requests', check: s => s.stats.served >= 300 },
    ],
    cheats: ['kubectl get | pods, with -o and --sort-by', 'kubectl rollout undo | back to a good revision', 'kubectl autoscale | add an autoscaler', 'kubectl scale | set replicas now', 'kubectl events | what just happened', 'kubectl top | CPU use'],
    hints: [
      'Do the prep before traffic: kubectl autoscale deployment web --min=8 --max=10 (a low --min lets the autoscaler scale IN before the wave hits), and one -o jsonpath or custom-columns query.',
      'When the banner says the broken release shipped: kubectl rollout history deployment/web, then kubectl rollout undo deployment/web.',
      'The wave is heavy: kubectl scale deployment web --replicas=8 beats waiting for the autoscaler.',
      'After node-2 dies its pods are rescheduled. kubectl get pods -o wide shows where everything is.',
    ],
    codex: { title: 'Incident response', text: 'In an incident: <b>stabilise first</b> (roll back the bad release, add capacity), <b>then investigate</b> (events, logs, structured queries). <code>rollout undo</code> is the fastest undo; <code>scale</code> and <code>autoscale</code> add headroom; <code>events</code> and <code>get -o wide</code> tell you where the cluster is hurting.' },
  },
];
