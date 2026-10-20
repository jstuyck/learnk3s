import { addDeployment, addService, depOf, keyOf, makePod, readyCount } from '../core/sim';
import type { Level, State } from '../core/types';

// Campaign: "Namespaces". Rooms in one cluster: the system namespaces, the same name in two namespaces,
// cluster DNS across namespaces, quotas, the context's default namespace, and deleting a whole namespace.

const ns = (s: State, ...names: string[]): void => { s.namespaces = [...(s.namespaces ?? []), ...names]; };
const dep = (s: State, namespace: string, name: string) => depOf(s, keyOf(namespace, name));
const ready = (s: State, namespace: string, name: string): number => readyCount(s, keyOf(namespace, name));
const has = (s: State, namespace: string) => (s.namespaces ?? []).includes(namespace);

export const NAMESPACE_LEVELS: Level[] = [
  {
    id: 'n-tour', title: 'Meet the Neighbours', tag: 'Namespaces & kube-system',
    blurb: 'Your pods are not alone. See the cluster\'s own pods in kube-system.',
    nodes: 3, slots: 4, traffic: null,
    setup(s) { addDeployment(s, { name: 'web', image: 'nginx', replicas: 2 }); },
    story: `<p>A cluster is divided into <b>namespaces</b>: separate rooms that group and isolate objects. Four exist from the start: <code>default</code> (where your things go), <code>kube-system</code> (the cluster's own components), <code>kube-public</code> and <code>kube-node-lease</code>.</p>
      <p>Plain <code>kubectl get pods</code> only shows <code>default</code>. Add <code>-n NAME</code> for another namespace or <code>-A</code> (<code>--all-namespaces</code>) for all of them. In <code>kube-system</code> you will find <b>CoreDNS</b> (cluster DNS), <b>etcd</b>, the <b>API server</b>, the <b>scheduler</b> and <b>controller manager</b> (static pods on the first node), and one <b>kube-proxy</b> and one network (CNI) pod <i>per node</i>.</p>
      <p>You can also see all of this in the picture: click the <b>Namespaces &amp; system pods</b> tab above the picture, then click a namespace.</p>`,
    objectives: [
      { id: 'list', text: 'List the namespaces with kubectl get namespaces', check: s => !!s.flags.listedNamespaces },
      { id: 'all', text: 'List pods from every namespace with -A', check: s => !!s.flags.usedAllNamespaces },
      { id: 'sys', text: 'List the pods of kube-system with -n kube-system', check: s => !!s.flags.listedKubeSystem },
      { id: 'wide', text: 'Find which node runs etcd (get pods -n kube-system -o wide)', check: s => !!s.flags.usedWideSystem },
      { id: 'dns', text: 'Find the cluster DNS Service (get svc -n kube-system)', check: s => !!s.flags.listedKubeDns },
      { id: 'inspect', text: 'Describe a CoreDNS pod', check: s => !!s.flags.inspectedSystemPod },
      { id: 'gui', text: 'Open the "Namespaces & system pods" tab above the picture', check: s => !!s.flags.openedNamespaceView },
    ],
    cheats: ['kubectl get | namespaces, pods, services', 'kubectl describe | one object in detail', 'kubectl logs | what a system pod says'],
    hints: [
      'kubectl get namespaces (or ns), then kubectl get pods and compare with kubectl get pods -A.',
      'kubectl get pods -n kube-system -o wide shows the NODE of every system pod.',
      'kubectl get svc -n kube-system: kube-dns at 10.96.0.10 is the address every pod uses to resolve names.',
      'kubectl describe pod POD -n kube-system (copy a coredns-... name). Then click the "Namespaces & system pods" tab above the picture.',
    ],
    codex: { title: 'Namespaces & kube-system', text: 'A <b>namespace</b> scopes names: two objects may share a name if they live in different namespaces. <code>-n NAME</code> picks one, <code>-A</code> means all. <b>kube-system</b> holds what Kubernetes needs to run itself: <b>CoreDNS</b>, <b>etcd</b>, <b>kube-apiserver</b>, <b>kube-scheduler</b>, <b>kube-controller-manager</b>, plus <b>kube-proxy</b> and the network plugin on every node. Nodes themselves are not namespaced.' },
  },

  {
    id: 'n-rooms', title: 'Dev and Prod', tag: 'Same name, different namespace',
    blurb: 'Two teams call their Deployment "web". Namespaces keep them apart.',
    nodes: 3, slots: 4, traffic: null,
    story: `<p>Names only have to be unique <b>inside a namespace</b>. That lets every team (or stage) use the same names without clashing, and lets you clean one up without touching the others.</p>
      <p>Create the namespaces <code>dev</code> and <code>prod</code> (<code>kubectl create namespace NAME</code>). Create a Deployment called <code>web</code> in <i>each</i> with <code>-n</code>: <b>1 replica in dev, 3 in prod</b>. Look at both with <code>-n</code> and with <code>-A</code>.</p>
      <p>Then scale dev's web to <b>2</b>, and finally delete dev's web. Prod's web must not notice.</p>`,
    objectives: [
      { id: 'create', text: 'Create the namespaces dev and prod', check: s => has(s, 'dev') && has(s, 'prod') },
      { id: 'dev', text: 'Run web with 1 replica in dev', check: s => !!dep(s, 'dev', 'web') && ready(s, 'dev', 'web') >= 1 },
      { id: 'prod', text: 'Run web with 3 replicas in prod', check: s => dep(s, 'prod', 'web')?.replicas === 3 && ready(s, 'prod', 'web') >= 3 },
      { id: 'scale', text: 'Scale dev\'s web to 2 without touching prod', check: s => dep(s, 'dev', 'web')?.replicas === 2 && ready(s, 'dev', 'web') >= 2 && dep(s, 'prod', 'web')?.replicas === 3 },
      { id: 'delete', text: 'Delete dev\'s web; prod keeps 3 healthy replicas', check: s => s.flags.deletedDeployment === 'dev/web' && !dep(s, 'dev', 'web') && ready(s, 'prod', 'web') >= 3 },
    ],
    cheats: ['kubectl create | a namespace or a Deployment', 'kubectl get | pods and Deployments, with -n or -A', 'kubectl scale | change replicas', 'kubectl delete | remove a Deployment'],
    hints: [
      'kubectl create namespace dev, and the same for prod.',
      'kubectl create deployment web --image=nginx --replicas=1 -n dev, then the same with --replicas=3 -n prod.',
      'kubectl get deployments -A shows both web Deployments side by side. kubectl get pods -n dev vs -n prod.',
      'kubectl scale deployment web --replicas=2 -n dev. Forgetting -n would look in default and fail.',
      'kubectl delete deployment web -n dev. Check kubectl get pods -n prod afterwards.',
    ],
    codex: { title: 'One name, many rooms', text: 'Object names are unique <b>per namespace</b>. The flag <code>-n</code> selects the namespace for every command; without it kubectl uses the namespace of your context (default <code>default</code>). Namespaces separate teams and environments, and are the unit for quotas and access rules.' },
  },

  {
    id: 'n-dns', title: 'Across the Fence', tag: 'Cluster DNS & namespaces',
    blurb: 'A pod in frontend must call the api Service in backend.',
    nodes: 3, slots: 4, traffic: null,
    setup(s) {
      ns(s, 'frontend', 'backend');
      addDeployment(s, { name: 'api', image: 'nginx', replicas: 2, ns: 'backend' });
      addService(s, 'api', 'api', 80, 80, 'backend');
      makePod(s, { name: 'toolbox', app: 'toolbox', ns: 'frontend', labels: { run: 'toolbox' }, image: 'toolbox', tpl: 'toolbox|||100||0' });
    },
    story: `<p>Every Service gets a DNS name. Inside a pod, the <b>short name</b> <code>api</code> resolves only to a Service in the <i>pod's own namespace</i>. To reach another namespace, add it: <code>api.backend</code> (or the full <code>api.backend.svc.cluster.local</code>).</p>
      <p>A <code>toolbox</code> pod runs in <code>frontend</code>, the <code>api</code> Service lives somewhere else. Find where (<code>kubectl get svc -A</code>), watch the short name fail (<code>kubectl exec toolbox -n frontend -- wget -qO- http://api</code>), then call it correctly. Finish by using the full <code>.svc.cluster.local</code> name too.</p>`,
    objectives: [
      { id: 'find', text: 'Find the api Service with kubectl get svc -A', check: s => !!s.flags.usedAllNamespaces },
      { id: 'bare', text: 'See the short name api fail from the frontend pod', check: s => !!s.flags.triedBareName },
      { id: 'call', text: 'Call it with the namespace: http://api.backend', check: s => !!s.flags.crossNsCall },
      { id: 'fqdn', text: 'Call it with the full name api.backend.svc.cluster.local', check: s => !!s.flags.fqdnCall },
    ],
    cheats: ['kubectl get | services in all namespaces', 'kubectl exec | run wget inside the toolbox pod', 'kubectl describe | the Service and its endpoints'],
    hints: [
      'kubectl get svc -A: the api Service is in the backend namespace.',
      'kubectl exec toolbox -n frontend -- wget -qO- http://api  fails: api is not a Service of frontend.',
      'kubectl exec toolbox -n frontend -- wget -qO- http://api.backend',
      'kubectl exec toolbox -n frontend -- wget -qO- http://api.backend.svc.cluster.local',
    ],
    codex: { title: 'DNS names of Services', text: 'A Service is reachable at <code>NAME.NAMESPACE.svc.cluster.local</code>. From a pod in the same namespace the short <code>NAME</code> works; from another namespace use <code>NAME.NAMESPACE</code>. Namespaces do <b>not</b> block traffic by themselves: any pod can call any Service by its full name (network policies are what restrict that).' },
  },

  {
    id: 'n-quota', title: 'Fair Share', tag: 'ResourceQuota',
    blurb: 'A team asks for 5 workers but only 3 ever start.',
    nodes: 3, slots: 4, traffic: null,
    setup(s) {
      ns(s, 'team-a');
      s.quotas.push({ name: 'team-quota', ns: 'team-a', pods: 3, createdAt: 0 });
      addDeployment(s, { name: 'worker', image: 'nginx', replicas: 5, ns: 'team-a' });
    },
    story: `<p>A <b>ResourceQuota</b> caps what one namespace may use, so a team cannot starve the rest of the cluster. Here <code>team-a</code> may run at most <b>3 pods</b>, but its <code>worker</code> Deployment wants <b>5</b>. The ReplicaSet keeps trying and the API server keeps refusing: a quiet failure, since the 3 that run look healthy.</p>
      <p>Investigate: <code>kubectl get pods -n team-a</code>, then <code>kubectl describe deployment worker -n team-a</code> (the refusal is in its events) and <code>kubectl describe quota team-quota -n team-a</code> (Used vs. Hard). Then make the Deployment healthy again: either ask for fewer replicas or replace the quota with a bigger one (<code>kubectl delete quota ...</code>, <code>kubectl create quota NAME --hard=pods=N</code>).</p>`,
    objectives: [
      { id: 'quota', text: 'Describe the quota: how much is used, what is the limit?', check: s => !!s.flags.describedQuota },
      { id: 'diagnose', text: 'Find the "exceeded quota" event in the worker Deployment', check: s => !!s.flags.describedBlocked },
      { id: 'fix', text: 'Get every worker replica Running', check: s => { const d = dep(s, 'team-a', 'worker'); return !!d && d.replicas >= 3 && ready(s, 'team-a', 'worker') >= d.replicas; } },
    ],
    cheats: ['kubectl get | pods and quotas', 'kubectl describe | events, and Used vs Hard', 'kubectl scale | change replicas', 'kubectl create quota | a new quota', 'kubectl delete quota | remove the old one'],
    hints: [
      'kubectl get pods -n team-a shows 3 workers. kubectl get quota -n team-a shows pods: 3/3.',
      'kubectl describe deployment worker -n team-a ends with FailedCreate ... exceeded quota: team-quota, limited: pods=3.',
      'Option 1: kubectl scale deployment worker --replicas=3 -n team-a (stay inside the quota).',
      'Option 2: kubectl delete quota team-quota -n team-a, then kubectl create quota team-quota --hard=pods=6 -n team-a.',
    ],
    codex: { title: 'ResourceQuota', text: 'A <b>ResourceQuota</b> limits the total of objects or resources in a namespace (pods, CPU, memory, ...). When it is used up, the API server <b>rejects</b> new pods with <i>exceeded quota</i>; the Deployment shows fewer ready pods than desired and the reason is in <code>kubectl describe</code>. Quotas make namespaces a fair-sharing boundary.' },
  },

  {
    id: 'n-context', title: 'Which Room Am I In?', tag: 'Context namespace, -n',
    blurb: 'Your terminal is silently pointed at prod. Scale staging, not prod.',
    nodes: 3, slots: 4, traffic: null,
    setup(s) {
      ns(s, 'prod', 'staging');
      addDeployment(s, { name: 'shop', image: 'nginx', replicas: 2, ns: 'prod' });
      addDeployment(s, { name: 'shop', image: 'nginx', replicas: 1, ns: 'staging' });
      s.ctxNs = 'prod';
    },
    story: `<p>When you do not type <code>-n</code>, kubectl uses the <b>namespace of your current context</b>. Someone left yours pointing at <code>prod</code>, so <code>kubectl get pods</code> shows production and <code>kubectl scale</code> changes production. This is a classic way to break prod by accident.</p>
      <p>Your task: scale <code>shop</code> in <b>staging</b> to 3 replicas, leaving prod's 2 replicas alone. First find out where your commands go (<code>kubectl config get-contexts</code> or <code>kubectl config view --minify</code>). Then either add <code>-n staging</code> to every command, or switch the context: <code>kubectl config set-context --current --namespace=staging</code>. Finish by putting your context back to <code>default</code>.</p>`,
    objectives: [
      { id: 'look', text: 'Check which namespace your context uses', check: s => !!s.flags.viewedContext },
      { id: 'staging', text: 'Scale staging\'s shop to 3 replicas while prod keeps 2', check: s => dep(s, 'staging', 'shop')?.replicas === 3 && ready(s, 'staging', 'shop') >= 3 && dep(s, 'prod', 'shop')?.replicas === 2 },
      { id: 'reset', text: 'Set the context namespace back to default', check: s => s.ctxNs === 'default' && s.flags.switchedNamespace !== undefined },
    ],
    cheats: ['kubectl config | show or change the context namespace', 'kubectl get | pods and Deployments', 'kubectl scale | change replicas'],
    hints: [
      'kubectl config get-contexts shows NAMESPACE prod. kubectl get deployments shows prod\'s shop.',
      'Safest: be explicit. kubectl scale deployment shop --replicas=3 -n staging.',
      'Or switch the context: kubectl config set-context --current --namespace=staging, then check kubectl get deployments.',
      'Finally kubectl config set-context --current --namespace=default so the next person is not surprised.',
    ],
    codex: { title: 'Context namespace', text: 'Every kubectl command runs in one namespace: the one from <code>-n</code>, else the one stored in your <b>kubeconfig context</b> (default <code>default</code>). <code>kubectl config set-context --current --namespace=NAME</code> changes it for all following commands. Many teams always pass <code>-n</code> on destructive commands, or show the namespace in their shell prompt.' },
  },

  {
    id: 'n-clean', title: 'Clean Slate', tag: 'Deleting a namespace',
    blurb: 'One command removes a whole project. Choose it carefully.',
    nodes: 3, slots: 4, traffic: null,
    setup(s) {
      ns(s, 'tmp', 'keep');
      addDeployment(s, { name: 'a', image: 'nginx', replicas: 2, ns: 'tmp' });
      addService(s, 'a', 'a', 80, 80, 'tmp');
      makePod(s, { name: 'scratch', app: 'scratch', ns: 'tmp', labels: { run: 'scratch' }, image: 'nginx', tpl: 'nginx|||100||0' });
      addDeployment(s, { name: 'b', image: 'nginx', replicas: 1, ns: 'keep' });
    },
    story: `<p>Deleting a <b>namespace</b> deletes <i>everything inside it</i>: pods, Deployments, Services, quotas, in one go. That makes cleaning up a test project trivial, and a typo dangerous.</p>
      <p>The namespace <code>tmp</code> holds a Deployment, a Service and a loose pod. <code>keep</code> holds something that must survive. Look inside with <code>kubectl get all -n tmp</code>, delete <code>tmp</code> (<code>kubectl delete namespace tmp</code>) and confirm that <code>keep</code> is untouched. For the record, also try <code>kubectl delete namespace kube-system</code>: Kubernetes protects the system namespaces.</p>`,
    objectives: [
      { id: 'protected', text: 'Try to delete kube-system and see Kubernetes refuse', check: s => !!s.flags.triedDeleteSystem },
      { id: 'delete', text: 'Delete the tmp namespace: all its objects disappear', check: s => !!s.flags.deletedNamespace && !has(s, 'tmp') && s.pods.every(p => p.ns !== 'tmp') && s.deployments.every(d => d.ns !== 'tmp') && s.services.every(v => v.ns !== 'tmp') },
      { id: 'keep', text: 'keep is untouched: its b Deployment is still running', check: s => !!s.flags.deletedNamespace && ready(s, 'keep', 'b') >= 1 && has(s, 'keep') },
    ],
    cheats: ['kubectl get | everything in a namespace', 'kubectl delete | a namespace', 'kubectl describe | a namespace'],
    hints: [
      'kubectl get all -n tmp lists the pods, Service and Deployment that live there.',
      'kubectl delete namespace kube-system is refused: "this namespace may not be deleted".',
      'kubectl delete namespace tmp. Then kubectl get all -n tmp says the namespace is gone.',
      'kubectl get pods -n keep: b is still Running.',
    ],
    codex: { title: 'Deleting a namespace', text: 'Deleting a namespace cascades: <b>everything in it is deleted</b>, including data in its objects. It is the cleanest way to remove a whole environment and the easiest way to cause an outage. <code>default</code>, <code>kube-system</code>, <code>kube-public</code> and <code>kube-node-lease</code> cannot be deleted.' },
  },
];
