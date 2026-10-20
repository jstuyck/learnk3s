import { addDeployment, addService, banner, depOf, nodeDown, ownedPods, readyCount, setImage } from '../core/sim';
import type { Level } from '../core/types';
import { IMAGES } from './images';

// Campaign 1: "Rookie" (easy). Learn the building blocks.
export const ROOKIE_LEVELS: Level[] = [
  {
    id: 'pods', title: 'Hello, Pod', tag: 'Pods & Nodes',
    blurb: 'Run your first workload and meet the scheduler.',
    nodes: 2, slots: 4, traffic: null,
    story: `<p>Welcome, new cluster operator! Your cluster has two <b>worker nodes</b> (machines) but nothing runs on them yet.</p>
      <p>A <b>Pod</b> is the smallest thing Kubernetes can run: a container (or a few) with a shared home. You ask for one, and the <b>scheduler</b> decides which node it lands on.</p>
      <p>You talk to the cluster with <code>kubectl</code>. Type commands in the terminal below the cluster view.</p>`,
    objectives: [
      { id: 'run', text: 'Get a pod Running (kubectl run, or a Deployment)', check: s => s.pods.some(p => p.phase === 'Running') },
      { id: 'get', text: 'List pods with kubectl get pods', check: s => !!s.flags.usedGet },
      { id: 'desc', text: 'Describe your pod (or click it)', check: s => !!s.flags.describedPod },
      { id: 'del', text: 'Delete the pod. Does anything bring it back?', check: s => (s.flags.deletedBare && !s.pods.some(p => !p.owner)) || !!s.flags.selfHealed },
    ],
    cheats: ['kubectl run | create a pod from an image', 'kubectl get | list pods, nodes, ...', 'kubectl describe | details and events of one object', 'kubectl delete | remove an object'],
    hints: [
      'Create a pod: kubectl run web --image=nginx',
      'Check on it with kubectl get pods. Wait for STATUS to say Running (it takes a couple of seconds to pull the image).',
      'kubectl describe pod web shows its events, including which node the scheduler chose. Clicking a pod in the view does the same.',
      'kubectl delete pod web. A bare pod is not managed by anything, so it stays gone.',
    ],
    codex: { title: 'Pod & Node', text: 'A <b>Pod</b> is the smallest deployable unit: one or more containers sharing network and storage. A <b>Node</b> is a machine that runs pods. The <b>scheduler</b> assigns each new pod to a node with free capacity. A pod created on its own ("bare") is not recreated if it dies.' },
  },

  {
    id: 'deployments', title: 'Deploy & Heal', tag: 'Deployments',
    blurb: 'Let Kubernetes keep your pods alive for you.',
    nodes: 3, slots: 4, traffic: null,
    story: `<p>Bare pods are fragile: delete one and it is gone for good. In real life you almost never create pods directly.</p>
      <p>A <b>Deployment</b> says "I want <i>N</i> copies of this pod running, always". A controller compares what you asked for (<i>desired state</i>) with what exists (<i>actual state</i>) and fixes any difference. That is <b>self-healing</b>.</p>`,
    objectives: [
      { id: 'create', text: 'Create a Deployment with 3 replicas, all Running', check: s => s.deployments.some(d => readyCount(s, d.name) >= 3) },
      { id: 'heal', text: 'Delete one of its pods and watch it come back', check: s => !!s.flags.selfHealed },
      { id: 'scale', text: 'Scale the Deployment up to 5 replicas', check: s => s.deployments.some(d => d.replicas >= 5 && readyCount(s, d.name) >= 5) },
    ],
    cheats: ['kubectl create | create a Deployment', 'kubectl get | list deployments and pods', 'kubectl delete | remove an object', 'kubectl scale | change the number of replicas'],
    hints: [
      'kubectl create deployment web --image=nginx --replicas=3',
      'kubectl get pods to find a pod name (web-xxxxx), then kubectl delete pod web-xxxxx. Watch a replacement appear.',
      'kubectl scale deployment web --replicas=5',
    ],
    codex: { title: 'Deployment & Self-healing', text: 'A <b>Deployment</b> declares a desired number of identical pods. Controllers run a loop: <i>observe, compare, act</i>. If a pod dies or a node fails, the Deployment creates a replacement. Change <code>replicas</code> to scale up or down.' },
  },

  {
    id: 'services', title: 'Open the Doors', tag: 'Services',
    blurb: 'Pods come and go. Give them a stable address.',
    nodes: 3, slots: 4,
    traffic: { app: 'web', profile: [{ from: 0, to: 9999, rps: 1.2 }], maxFail: 8, stars: [1, 4] },
    setup(s) { addDeployment(s, { name: 'web', image: 'nginx', replicas: 2 }); },
    story: `<p>Your <code>web</code> Deployment is running two pods, but users cannot reach them. Pod IPs change every time a pod is replaced, so clients cannot depend on them.</p>
      <p>A <b>Service</b> is a stable front door. It selects pods by <b>label</b> (here <code>app=web</code>) and load-balances requests across every <i>Ready</i> one.</p>
      <p>Create the Service first, <i>then</i> press <b>Open to traffic</b>. Too many failed requests and the mission fails.</p>`,
    objectives: [
      { id: 'svc', text: 'Expose the web Deployment with a Service', check: s => s.services.some(v => v.selector.app === 'web') },
      { id: 'live', text: 'Open the cluster to user traffic', check: s => s.mode === 'live' },
      { id: 'served', text: 'Serve 25 requests', check: s => s.stats.served >= 25 },
    ],
    cheats: ['kubectl get | list deployments and services', 'kubectl expose | give pods a stable Service'],
    hints: [
      'kubectl expose deployment web --port=80',
      'kubectl get endpoints (or kubectl describe service web) shows which ready pods back the Service.',
      'Now press the blue "Open to traffic" button at the top.',
    ],
    codex: { title: 'Service & Labels', text: 'A <b>Service</b> gives a stable name and virtual IP to a changing set of pods. It finds them with a <b>label selector</b> (e.g. <code>app=web</code>) and sends traffic only to pods that are <b>Ready</b>. No matching pods means no endpoints, so requests fail.' },
  },

  {
    id: 'scaling', title: 'Campaign Day', tag: 'Manual scaling',
    blurb: 'A traffic spike is coming. One pod will not cut it.',
    nodes: 3, slots: 4,
    traffic: { app: 'web', profile: [{ from: 0, to: 20, rps: 1.5 }, { from: 20, to: 45, rps: 6 }, { from: 45, to: 9999, rps: 1.5 }], maxFail: 20, stars: [6, 14] },
    setup(s) { addDeployment(s, { name: 'web', image: 'nginx', replicas: 1 }); addService(s, 'web', 'web'); },
    events: [{ at: 15, run: s => banner(s, 'Marketing campaign goes live in 5 seconds!') }],
    story: `<p>The <code>web</code> Deployment has a single replica, plus a Service. That is fine for a quiet day, but marketing is about to send a wave of visitors.</p>
      <p>Each pod can handle only so many requests at once; extra requests are rejected with a 503. Spread the load by adding <b>replicas</b>, and remember: a new pod takes a few seconds to become Ready.</p>`,
    objectives: [
      { id: 'scaled', text: 'Run at least 3 replicas', check: s => (s.peak.web || 0) >= 3 },
      { id: 'survive', text: 'Keep the site up until the wave passes (50s)', check: s => s.tt >= 50 },
    ],
    cheats: ['kubectl scale | change the number of replicas', 'kubectl get | list pods and deployments', 'kubectl top | see how busy pods are'],
    hints: [
      'kubectl scale deployment web --replicas=4',
      'kubectl top pods shows CPU use per pod. A pod near 500m is saturated and rejecting requests.',
      'You can scale before the wave arrives. Pods need ~3 seconds to start.',
    ],
    codex: { title: 'Scaling', text: '<b>Horizontal scaling</b> means more pod replicas, not bigger ones. <code>kubectl scale</code> changes the desired replica count and the Deployment controller creates the pods. New pods are only sent traffic once they are <b>Ready</b>.' },
  },

  {
    id: 'hpa', title: 'Autopilot', tag: 'Autoscaling (HPA)',
    blurb: 'Let the cluster react to load by itself.',
    nodes: 4, slots: 3,
    traffic: { app: 'web', profile: [{ from: 0, to: 12, rps: 1.5 }, { from: 12, to: 32, rps: 6.5 }, { from: 32, to: 48, rps: 1.5 }, { from: 48, to: 68, rps: 7 }, { from: 68, to: 9999, rps: 1.5 }], maxFail: 40, stars: [15, 30] },
    setup(s) { addDeployment(s, { name: 'web', image: 'nginx', replicas: 2 }); addService(s, 'web', 'web'); },
    events: [
      { at: 9, run: s => banner(s, 'Wave 1 incoming!') },
      { at: 45, run: s => banner(s, 'Wave 2 incoming. Bigger this time!') },
    ],
    story: `<p>Two traffic waves are on the way, and you cannot babysit the terminal all night. Time to automate.</p>
      <p>A <b>HorizontalPodAutoscaler</b> (HPA) watches pod CPU use and adjusts the replica count between a <b>min</b> and a <b>max</b>. It scales out when pods run hot and back in when things calm down, so you do not pay for idle pods.</p>`,
    objectives: [
      { id: 'hpa', text: 'Create an autoscaler for web (min 2, max 6)', check: s => s.hpas.some(h => h.dep === 'web' && h.max >= 5) },
      { id: 'up', text: 'See it scale out to 4+ replicas', check: s => (s.peak.web || 0) >= 4 },
      { id: 'down', text: 'See it scale back in after the wave', check: s => (s.peak.web || 0) >= 4 && s.hpas.some(h => h.dep === 'web') && (depOf(s, 'web')?.replicas ?? 99) <= s.hpas[0].min },
      { id: 'survive', text: 'Survive both waves (78s)', check: s => s.tt >= 78 },
    ],
    cheats: ['kubectl autoscale | let Kubernetes pick the replica count', 'kubectl get | list pods, hpa, ...', 'kubectl top | see how busy pods are'],
    hints: [
      'kubectl autoscale deployment web --min=2 --max=6 --cpu-percent=70',
      'kubectl get hpa shows current load versus the target.',
      'Open to traffic when the HPA exists. Raising --min lowers the risk at the start of each wave.',
    ],
    codex: { title: 'HorizontalPodAutoscaler', text: 'The <b>HPA</b> compares measured utilisation with a target (e.g. 70% CPU) and sets <code>replicas = ceil(current x utilisation / target)</code>, clamped between <b>min</b> and <b>max</b>. Scaling up is quick; scaling down waits a while to avoid flapping.' },
  },

  {
    id: 'rollout', title: 'Ship It Safely', tag: 'Rolling updates & rollback',
    blurb: 'Update with zero downtime, and undo a bad release.',
    nodes: 3, slots: 4,
    traffic: { app: 'web', profile: [{ from: 0, to: 9999, rps: 2 }], maxFail: 8, stars: [1, 4] },
    setup(s) { addDeployment(s, { name: 'web', image: 'web:v1', replicas: 4 }); addService(s, 'web', 'web'); },
    events: [{
      when: s => s.done.rolled && s.mode === 'live', delay: 4,
      run: s => { setImage(s, 'web', 'web:v3-broken'); s.flags.badRelease = true; banner(s, 'The CI pipeline just pushed web:v3-broken!'); },
    }],
    story: `<p>Version 2 of the app is ready. A Deployment replaces pods <b>gradually</b>: it starts a new pod, waits until it is Ready, then retires an old one. Users never notice.</p>
      <p>If the new pods never become Ready, the rollout <i>stalls</i> and the old pods keep serving. Kubernetes keeps you safe, but you still need to notice and undo the release.</p>
      <p>Open traffic, update the image, and watch.</p>`,
    objectives: [
      { id: 'live', text: 'Open the cluster to traffic', check: s => s.mode === 'live' },
      { id: 'rolled', text: 'Roll all pods to image web:v2', check: s => { const d = depOf(s, 'web'); return !!d && d.image === 'web:v2' && ownedPods(s, 'web').length === d.replicas && ownedPods(s, 'web').every(p => p.phase === 'Running' && p.image === 'web:v2'); } },
      { id: 'recovered', text: 'A broken release is pushed. Roll it back!', check: s => !!s.flags.badRelease && depOf(s, 'web')?.image === 'web:v2' && ownedPods(s, 'web').length === depOf(s, 'web')?.replicas && ownedPods(s, 'web').every(p => p.phase === 'Running') },
      { id: 'served', text: 'Serve 60 requests with minimal failures', check: s => s.stats.served >= 60 },
    ],
    cheats: ['kubectl set image | change the image of a Deployment', 'kubectl rollout | status, history or undo', 'kubectl get | list pods', 'kubectl logs | what did the app print?', 'kubectl describe | details and events'],
    hints: [
      'Press "Open to traffic", then: kubectl set image deployment/web web=web:v2',
      'kubectl rollout status deployment/web shows progress. Keep an eye on kubectl get pods too.',
      'When a pod shows CrashLoopBackOff: kubectl logs POD tells you why. Fix with kubectl rollout undo deployment/web.',
    ],
    codex: { title: 'Rolling Update & Rollback', text: 'A Deployment\'s default <b>RollingUpdate</b> strategy creates new pods and retires old ones step by step (<i>maxSurge</i> / <i>maxUnavailable</i>), so capacity never drops. A bad version stalls the rollout instead of taking you down. <code>kubectl rollout undo</code> returns to the previous revision.' },
  },

  {
    id: 'config', title: 'Missing Settings', tag: 'ConfigMaps & debugging',
    blurb: 'The pods keep crashing. Find out why.',
    nodes: 3, slots: 4,
    traffic: { app: 'api', profile: [{ from: 0, to: 9999, rps: 1.5 }], maxFail: 25, stars: [4, 12] },
    setup(s) { addDeployment(s, { name: 'api', image: 'api:v1', replicas: 2 }); addService(s, 'api', 'api', 80, 8080); },
    story: `<p>You deployed the new <code>api</code> service, but its pods will not stay up: <b>CrashLoopBackOff</b>. Kubernetes keeps restarting them, with growing delays.</p>
      <div class="learned"><b>Release notes: api v1</b><br>The api reads its database address from the <code>DB_URL</code> environment variable.<br>Production database: <code>postgres://db.internal:5432/app</code></div>
      <p>Your job is to play detective. <code>kubectl describe</code> and <code>kubectl logs</code> are your magnifying glass. The fix usually lives in <b>configuration</b>: a <b>ConfigMap</b> holds settings outside the image, and you inject it into the Deployment.</p>`,
    objectives: [
      { id: 'inspect', text: 'Investigate a crashing pod (logs or describe)', check: s => !!s.flags.inspectedCrash },
      { id: 'cm', text: 'Create a ConfigMap with DB_URL from the release notes', check: s => s.configmaps.some(c => c.data.DB_URL === IMAGES['api:v1'].value) },
      { id: 'wire', text: 'Inject the ConfigMap into the api Deployment', check: s => !!depOf(s, 'api')?.config },
      { id: 'healthy', text: 'Get both api pods Running', check: s => readyCount(s, 'api') >= 2 },
      { id: 'served', text: 'Serve 20 requests', check: s => s.stats.served >= 20 },
    ],
    cheats: ['kubectl get | list pods', 'kubectl logs | what did the app print?', 'kubectl describe | details and events', 'kubectl create | create a ConfigMap', 'kubectl set env | inject a ConfigMap into a Deployment'],
    hints: [
      'kubectl get pods, then kubectl logs on one of the api pods. The app tells you what it needs; the release notes (Re-read briefing) tell you the value.',
      'kubectl create configmap api-config --from-literal=DB_URL=postgres://db.internal:5432/app',
      'kubectl set env deployment/api --from=configmap/api-config. This triggers a rollout with the new settings.',
      'Open the cluster to traffic once the pods are healthy.',
    ],
    codex: { title: 'ConfigMap & Debugging', text: 'A <b>ConfigMap</b> stores configuration separately from the container image; <code>kubectl set env --from=configmap/X</code> injects it as environment variables. Debug loop: <code>get pods</code> (what state?), <code>describe</code> (events), <code>logs</code> (what did the app say?).' },
  },

  {
    id: 'resilience', title: 'Pull the Plug', tag: 'Capstone: node failure',
    blurb: 'Build a shop that survives losing machines.',
    nodes: 3, slots: 4,
    traffic: { app: 'shop', profile: [{ from: 0, to: 38, rps: 3 }, { from: 38, to: 70, rps: 6 }, { from: 70, to: 9999, rps: 3 }], maxFail: 30, stars: [8, 18] },
    events: [
      { at: 20, run: s => nodeDown(s, 'node-2', 25) },
      { at: 55, run: s => nodeDown(s, 'node-1', 20) },
    ],
    story: `<p>Final exam. Launch a shop called <code>shop</code> from scratch: a Deployment and a Service so users can reach it. Then keep it alive while the data centre misbehaves.</p>
      <p>Machines die. The scheduler <b>spreads</b> replicas across nodes, so one failing node should not take everything down, <i>if</i> you ran enough replicas. When a node goes <b>NotReady</b>, its pods are replaced elsewhere.</p>
      <p>Two nodes are going to fail during the run, and a traffic spike lands in the middle of the second failure. Be ready.</p>
      <p><i>Note:</i> an autoscaler follows <b>load</b>, not failures. It will not save you from a lost node by itself, and it may scale you <i>in</i> when traffic is quiet. Set its <b>min</b> with that in mind.</p>`,
    objectives: [
      { id: 'dep', text: 'Create the shop Deployment with 3+ Running replicas', check: s => !!depOf(s, 'shop') && readyCount(s, 'shop') >= 3 },
      { id: 'svc', text: 'Expose it with a Service', check: s => s.services.some(v => v.selector.app === 'shop') },
      { id: 'live', text: 'Open the cluster to traffic', check: s => s.mode === 'live' },
      { id: 'survive', text: 'Survive both node failures (85s)', check: s => s.tt >= 85 },
    ],
    cheats: ['kubectl create | create a Deployment', 'kubectl expose | give pods a stable Service', 'kubectl get | list pods and nodes', 'kubectl scale | change the number of replicas', 'kubectl autoscale | follow the load automatically'],
    hints: [
      'kubectl create deployment shop --image=nginx --replicas=3, then kubectl expose deployment shop --port=80',
      'Open to traffic only when the pods are Running and the Service exists.',
      'More replicas than the minimum gives a safety margin: kubectl scale deployment shop --replicas=4',
      'kubectl get nodes shows which node is NotReady. Deployments recreate lost pods on healthy nodes.',
      'Traffic doubles around the 40s mark. kubectl autoscale deployment shop --min=3 --max=6 covers the spike, and min=3 keeps a safety net for node loss.',
    ],
    codex: { title: 'Resilience', text: 'The scheduler prefers to <b>spread</b> replicas of one Deployment across nodes. When a node becomes <b>NotReady</b>, its pods are marked Unknown and, after a timeout, rescheduled elsewhere by their controller. Run more than one replica, and enough spare capacity to absorb losing a node.' },
  },
];
