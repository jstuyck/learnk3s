import { profit } from '../core/economy';
import { addDeployment, addService, banner, depOf, nodeDown, readyCount, reclaimSpot, setImage } from '../core/sim';
import type { Econ, Level, State } from '../core/types';
import { IMAGES } from './images';

// Profit Mode: a separate game mode. Money matters: every pod and node costs per second,
// every served request earns revenue, every failed request costs a refund.
// Economy numbers are calibrated by tests/economy.test.ts.

const ECON = (o: Partial<Econ>): Econ => Object.assign({ price: 0.1, podCost: 0.02, nodeCost: 0.04, spotCost: 0, penalty: 0.2, bankrupt: 20, maxNodes: 4, target: 0, duration: 60, stars: [0, 0] as [number, number] }, o);
const profitOK = (s: State, E: Econ): boolean => s.tt >= E.duration && profit(s) >= E.target;

const E1 = ECON({ nodeCost: 0.02, duration: 60, maxNodes: 3, target: 1.5, stars: [2.6, 3.4] });
const E2 = ECON({ nodeCost: 0.04, duration: 70, target: 6.0, stars: [6.6, 7.0] });
const E3 = ECON({ price: 0.12, nodeCost: 0.05, penalty: 0.12, duration: 120, target: 20, stars: [27, 32] });
const E4 = ECON({ price: 0.15, nodeCost: 0.02, penalty: 0.08, bankrupt: 20, duration: 70, target: 4, stars: [9, 12] });
const E5 = ECON({ price: 0.12, nodeCost: 0.2, spotCost: 0.03, penalty: 0.25, duration: 90, target: 25, stars: [28, 31] });
const E6 = ECON({ price: 0.12, nodeCost: 0.05, spotCost: 0.016, penalty: 0.3, bankrupt: 40, duration: 120, target: 32, stars: [38, 44] });

export const PROFIT_LEVELS: Level[] = [
  {
    id: 'm-cost', title: 'Open for Business', tag: 'Cost basics',
    blurb: 'Every pod has a price. Stop burning money.',
    nodes: 3, slots: 4, econ: E1,
    traffic: { app: 'shop', auto: true, profile: [{ from: 0, to: 9999, rps: 2 }], maxFail: 1e9, stars: [0, 0] },
    setup(s) { addDeployment(s, { name: 'shop', image: 'nginx', replicas: 9 }); addService(s, 'shop', 'shop'); },
    story: `<p>Welcome to production. Your shop is <b>live from the first second</b>, and now every resource has a price tag.</p>
      <p>Each served request earns you <b>$${E1.price.toFixed(2)}</b>. Each running pod costs <b>$${E1.podCost.toFixed(2)}/s</b>, each node <b>$${E1.nodeCost.toFixed(2)}/s</b>. A failed request costs you a <b>$${E1.penalty.toFixed(2)}</b> refund.</p>
      <p>Someone deployed <b>9 replicas</b> "to be safe". Traffic is only 2 requests/second. Look at the bill in the cloud console with <code>cloud cost</code>, then right-size. But careful: too few pods and requests start failing.</p>
      <p>Finish the minute with at least <b>$${E1.target.toFixed(2)}</b> profit.</p>`,
    objectives: [
      { id: 'bill', text: 'Read the bill with cloud cost', check: s => !!s.flags.usedCost },
      { id: 'size', text: 'Right-size shop to 2 to 4 replicas', check: s => { const d = depOf(s, 'shop'); return !!d && d.replicas >= 2 && d.replicas <= 4; } },
      { id: 'profit', text: 'Profit at least $' + E1.target.toFixed(2) + ' by ' + E1.duration + 's', check: s => profitOK(s, E1) },
    ],
    cheats: ['cloud cost | the bill: burn rate, revenue, profit', 'kubectl top | CPU use per pod (about 500m is full)', 'kubectl scale | change the number of replicas', 'kubectl get | list pods and deployments'],
    hints: [
      'cloud cost shows what each part of the cluster costs per second, and what you earn.',
      'One pod handles about 2.5 requests/second. At 2 req/s, 2 or 3 pods is plenty.',
      'kubectl scale deployment shop --replicas=3. Do it early: every second of waste is lost profit.',
    ],
    codex: { title: 'Cost of Replicas', text: 'Every replica reserves node capacity and <b>costs money</b> whether it is busy or idle. Over-provisioning wastes budget; under-provisioning drops requests (and revenue). Right-sizing means matching replicas to real load plus a safety margin. <code>kubectl top</code> shows utilisation.' },
  },

  {
    id: 'm-trim', title: 'Trim the Fat', tag: 'Nodes: drain & remove',
    blurb: 'Empty machines still cost money.',
    nodes: 4, slots: 3, econ: E2,
    traffic: { app: 'shop', auto: true, profile: [{ from: 0, to: 9999, rps: 3 }], maxFail: 1e9, stars: [0, 0] },
    setup(s) { addDeployment(s, { name: 'shop', image: 'nginx', replicas: 4 }); addService(s, 'shop', 'shop'); },
    story: `<p>The shop is healthy, but the finance team is unhappy: you rent <b>4 nodes</b> at $${E2.nodeCost.toFixed(2)}/s each, yet four pods fit comfortably on two.</p>
      <p>A node cannot just be switched off: its pods would die. The polite way is to <b>drain</b> it: <code>kubectl drain</code> cordons the node (no new pods) and evicts its pods so their Deployment recreates them elsewhere. Only then can you release the machine in the <b>cloud console</b> (<code>cloud remove-node</code>) and stop paying for it.</p>
      <p>Cut down to <b>2 nodes</b> without dropping requests, and make at least <b>$${E2.target.toFixed(2)}</b> profit.</p>`,
    objectives: [
      { id: 'drain', text: 'Drain a node', check: s => !!s.flags.drained },
      { id: 'remove', text: 'Shrink the cluster to 2 nodes', check: s => s.nodes.length <= 2 },
      { id: 'profit', text: 'Profit at least $' + E2.target.toFixed(2) + ' by ' + E2.duration + 's', check: s => profitOK(s, E2) },
    ],
    cheats: ['kubectl get | list pods and nodes', 'kubectl drain | evict pods from a node', 'cloud remove-node | release a machine (stop paying)', 'cloud cost | the bill'],
    hints: [
      'kubectl get pods -o wide shows which node runs each pod. Pick nodes that are lightly loaded.',
      'kubectl drain node-4: pods move to other nodes. Wait until they are Running again.',
      'cloud remove-node node-4. It refuses while pods remain, which is a safety net. Repeat for a second node.',
    ],
    codex: { title: 'Cordon, Drain, Remove', text: '<b>cordon</b> marks a node unschedulable. <b>drain</b> cordons it and evicts its pods; controllers recreate them on other nodes. Only a node with no pods should be released. In a real cloud you terminate the instance, and billing stops.' },
  },

  {
    id: 'm-peak', title: 'Black Friday', tag: 'Autoscaling & cluster capacity',
    blurb: 'More pods need more machines, then give them back.',
    nodes: 2, slots: 2, econ: E3,
    traffic: { app: 'shop', auto: true, profile: [{ from: 0, to: 40, rps: 2 }, { from: 40, to: 50, rps: 5 }, { from: 50, to: 85, rps: 8 }, { from: 85, to: 9999, rps: 2.5 }], maxFail: 1e9, stars: [0, 0] },
    setup(s) { addDeployment(s, { name: 'shop', image: 'nginx', replicas: 2 }); addService(s, 'shop', 'shop'); },
    events: [
      { at: 20, run: s => banner(s, 'Black Friday: the doors open in 20 seconds. Get ready!') },
      { at: 38, run: s => banner(s, 'The rush is starting!') },
    ],
    story: `<p>Black Friday! Traffic stays quiet for 40 seconds, then climbs to <b>8 requests/second</b> for about 35 seconds before falling back. You have time to prepare, and the cost of preparing early is small.</p>
      <p>The cluster has just <b>2 small nodes with room for 2 pods each</b>. A HorizontalPodAutoscaler can ask for more pods, but if the nodes are full the extra pods sit <b>Pending</b> ("insufficient capacity"). Pods need machines: add a node with <code>cloud add-node</code> (it takes ~5s to boot).</p>
      <p>When the rush is over, don't keep paying: drain and release the extra node. Make <b>$${E3.target.toFixed(0)}</b> profit.</p>`,
    objectives: [
      { id: 'hpa', text: 'Create an autoscaler for shop', check: s => s.hpas.some(h => h.dep === 'shop') },
      { id: 'node', text: 'Add a node for the rush', check: s => !!s.flags.addedNode },
      { id: 'trim', text: 'After the rush, shrink back to 2 nodes', check: s => (s.peak.nodes || 0) >= 3 && s.nodes.length <= 2 },
      { id: 'profit', text: 'Profit at least $' + E3.target.toFixed(0) + ' by ' + E3.duration + 's', check: s => profitOK(s, E3) },
    ],
    cheats: ['kubectl autoscale | follow the load automatically', 'cloud add-node | rent another machine', 'kubectl get | pods (Pending?), nodes, hpa', 'kubectl describe | why is a pod Pending?', 'kubectl drain | evict pods from a node', 'cloud remove-node | release a machine'],
    hints: [
      'kubectl autoscale deployment shop --min=2 --max=6',
      'If a pod is Pending, kubectl describe pod shows FailedScheduling: no free capacity. cloud add-node fixes that.',
      'After the rush the autoscaler scales in. Then kubectl drain the extra node and cloud remove-node it.',
    ],
    codex: { title: 'Pending Pods & Cluster Capacity', text: 'The HPA changes the <b>pod</b> count; it cannot create machines. When every node is full, new pods stay <b>Pending</b> with a <i>FailedScheduling</i> event. A <b>cluster autoscaler</b> (here: you) adds nodes for Pending pods and removes idle ones.' },
  },

  {
    id: 'm-secret', title: 'Pay Day', tag: 'Secrets',
    blurb: 'The payment pods are crashing, and each failure costs you.',
    nodes: 3, slots: 4, econ: E4,
    traffic: { app: 'pay', auto: true, profile: [{ from: 0, to: 9999, rps: 3 }], maxFail: 1e9, stars: [0, 0] },
    setup(s) { addDeployment(s, { name: 'pay', image: 'pay:v1', replicas: 3 }); addService(s, 'pay', 'pay'); },
    story: `<p>The new <code>pay</code> service is live but every pod is in <b>CrashLoopBackOff</b>, and customers are paying you (or rather, <i>not</i> paying you): each failed request costs <b>$${E4.penalty.toFixed(2)}</b>. The clock is ticking.</p>
      <div class="learned"><b>Release notes: pay v1</b><br>The service reads its payment provider key from the <code>API_KEY</code> environment variable.<br>Production key: <code>sk_live_9f2c41</code><br><i>Security policy:</i> credentials must never be stored in plain text config.</div>
      <p>Debug first (<code>logs</code>), then fix. Kubernetes has an object for sensitive values: a <b>Secret</b>. Create one, inject it into the Deployment, and get paid. Reach <b>$${E4.target.toFixed(0)}</b> profit.</p>`,
    objectives: [
      { id: 'inspect', text: 'Investigate a crashing pod', check: s => !!s.flags.inspectedCrash },
      { id: 'secret', text: 'Create a Secret holding API_KEY', check: s => s.secrets.some(c => c.data.API_KEY === IMAGES['pay:v1'].value) },
      { id: 'wire', text: 'Inject the Secret into the pay Deployment', check: s => !!depOf(s, 'pay')?.secret },
      { id: 'healthy', text: 'Get all 3 pay pods Running', check: s => readyCount(s, 'pay') >= 3 },
      { id: 'profit', text: 'Profit at least $' + E4.target.toFixed(0) + ' by ' + E4.duration + 's', check: s => profitOK(s, E4) },
    ],
    cheats: ['kubectl get | list pods', 'kubectl logs | what did the app print?', 'kubectl create | create a Secret', 'kubectl set env | inject config into a Deployment', 'kubectl describe | details and events'],
    hints: [
      'kubectl logs on a pay pod: the app says what is missing. The release notes (Re-read briefing) give the value.',
      'kubectl create secret generic pay-secret --from-literal=API_KEY=sk_live_9f2c41',
      'kubectl set env deployment/pay --from=secret/pay-secret. (A ConfigMap will not do: try it and read the logs!)',
    ],
    codex: { title: 'Secrets', text: 'A <b>Secret</b> holds sensitive data (keys, passwords, tokens) separately from images and plain ConfigMaps. It is injected the same way, via <code>kubectl set env --from=secret/NAME</code>, but can be access-controlled and is not shown in plain text by <code>describe</code>.' },
  },

  {
    id: 'm-spot', title: 'Spot the Bargain', tag: 'Spot nodes: cost vs risk',
    blurb: 'Cheap machines that can vanish at any moment.',
    nodes: 2, slots: 4, econ: E5,
    traffic: { app: 'shop', auto: true, profile: [{ from: 0, to: 9999, rps: 6 }], maxFail: 1e9, stars: [0, 0] },
    setup(s) { addDeployment(s, { name: 'shop', image: 'nginx', replicas: 4 }); addService(s, 'shop', 'shop'); },
    events: [
      { at: 28, run: s => reclaimSpot(s) },
      { at: 55, run: s => reclaimSpot(s) },
      { at: 78, run: s => reclaimSpot(s) },
    ],
    story: `<p>Nodes are your biggest cost: <b>$${E5.nodeCost.toFixed(2)}/s</b> each on-demand. The cloud also offers <b>spot nodes</b> at only <b>$${E5.spotCost.toFixed(2)}/s</b>, but the provider can <b>reclaim them without warning</b> (they come back 20s later).</p>
      <p>Pods on a reclaimed node are lost and rescheduled, so a Deployment spread across several nodes survives it, as long as enough replicas and capacity remain elsewhere. Two spot nodes alone would not be enough: losing one leaves too little. The provider will reclaim one spot node at about 28s, 55s and 78s.</p>
      <p>Pods cost money too, so extra replicas are not free: balance savings against the risk.</p>
      <p>Add spot nodes with <code>cloud add-node --spot</code>, retire expensive ones (drain, then remove), and make <b>$${E5.target.toFixed(0)}</b> profit.</p>`,
    objectives: [
      { id: 'spot', text: 'Run on at least one spot node', check: s => s.nodes.some(n => n.spot) },
      { id: 'profit', text: 'Profit at least $' + E5.target.toFixed(0) + ' by ' + E5.duration + 's', check: s => profitOK(s, E5) },
    ],
    cheats: ['cloud add-node | rent a machine (--spot is cheaper)', 'kubectl drain | evict pods from a node', 'cloud remove-node | release a machine', 'kubectl scale | change the number of replicas', 'cloud cost | the bill', 'cloud list-nodes | on-demand vs spot, and what each costs'],
    hints: [
      'cloud cost: nodes dominate the bill. A spot node costs under a third of an on-demand one.',
      'cloud add-node --spot (you can request several), wait for Ready, then kubectl drain an on-demand node and cloud remove-node it.',
      'Spot nodes are 7x cheaper here. With 3 spot nodes and about 7 replicas, losing one node still leaves enough pods. Two nodes would not.',
    ],
    codex: { title: 'Spot / Preemptible Nodes', text: '<b>Spot</b> (preemptible) nodes are spare cloud capacity sold cheaply but revocable at short notice. They suit stateless, replicated workloads: replicas are spread (the scheduler does this) and lost pods are recreated elsewhere. Never put everything on them.' },
  },

  {
    id: 'm-final', title: 'Quarter Close', tag: 'Capstone: everything',
    blurb: 'Spikes, a dying node and a bad release. Stay profitable.',
    nodes: 2, slots: 3, econ: E6,
    traffic: { app: 'shop', auto: true, profile: [{ from: 0, to: 20, rps: 3 }, { from: 20, to: 50, rps: 9 }, { from: 50, to: 70, rps: 4 }, { from: 70, to: 100, rps: 10 }, { from: 100, to: 9999, rps: 3 }], maxFail: 1e9, stars: [0, 0] },
    setup(s) { addDeployment(s, { name: 'shop', image: 'web:v1', replicas: 3 }); addService(s, 'shop', 'shop'); },
    events: [
      { at: 17, run: s => banner(s, 'Traffic surge in 3 seconds!') },
      { at: 38, run: s => nodeDown(s, 'node-1', 20) },
      { at: 60, run: s => { setImage(s, 'shop', 'web:v2-broken'); s.flags.badRelease = true; banner(s, 'CI just pushed web:v2-broken to production!'); } },
      { at: 67, run: s => banner(s, 'The biggest surge of the quarter is coming!') },
    ],
    story: `<p>Last day of the quarter and you are being judged on profit. You have a small cluster, an unpredictable day, and every tool you have learned.</p>
      <p>Expect: a <b>traffic surge</b>, a <b>node failure</b>, a <b>broken release</b> and an even bigger surge. Autoscale, add (and later remove) nodes, roll back bad deploys, and keep an eye on <code>cloud cost</code>. Spot nodes are available at $${E6.spotCost.toFixed(3)}/s if you dare.</p>
      <p>Finish with at least <b>$${E6.target.toFixed(0)}</b> profit.</p>`,
    objectives: [
      { id: 'rollback', text: 'Roll back the broken release', check: s => !!s.flags.badRelease && depOf(s, 'shop')?.image === 'web:v1' && readyCount(s, 'shop') >= 1 },
      { id: 'profit', text: 'Profit at least $' + E6.target.toFixed(0) + ' by ' + E6.duration + 's', check: s => profitOK(s, E6) },
    ],
    cheats: ['kubectl autoscale | follow the load automatically', 'cloud add-node | rent a machine (--spot is cheaper)', 'kubectl rollout | status, history or undo', 'kubectl drain | evict pods from a node', 'cloud remove-node | release a machine', 'cloud cost | the bill'],
    hints: [
      'Start with kubectl autoscale deployment shop --min=3 --max=8 and cloud add-node: 3 slots per node fills up fast.',
      'When a node dies, Deployments recreate pods elsewhere, but only if there is free capacity.',
      'The bad release stalls a rolling update. kubectl rollout undo deployment/shop puts v1 back.',
      'Between surges, scale in and release extra nodes. Idle capacity is pure cost.',
    ],
    codex: { title: 'Running a Cluster for Profit', text: 'Reliability and cost pull in opposite directions. Autoscale pods for load, scale nodes for capacity, spread replicas for resilience, roll back fast when a release goes wrong, and release what you no longer need. Measure first: <code>kubectl top</code> and <code>cloud cost</code>.' },
  },
];

