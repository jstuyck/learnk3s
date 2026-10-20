import { runPlain } from '../core/cli';
import { REPO_DIR, apiserverUp, kubeconfigProblem, unitActive } from '../core/hardway';
import type { Machine } from '../core/hardway';
import { runHwSilently } from '../core/hwshell';
import { readyCount } from '../core/sim';
import { LABS } from './hardway-tutorial';
import type { Level, Objective, State } from '../core/types';

// Campaign 4: "The Hard Way". Bootstrap a Kubernetes cluster from nothing, following Kelsey Hightower's
// "Kubernetes The Hard Way": jumpbox, certificates, kubeconfigs, etcd, control plane, workers, networking, smoke tests.
// Every mission starts from the state the previous labs leave behind (the reference solutions below are replayed).

const D = REPO_DIR;

/** The commands of each lab, in order: the reference solution (and the tutorial steps). */
export const HW_SOLUTIONS: string[][] = LABS.map(steps => steps.map(s => s.cmd));

/** Replay the labs before `n` so a mission starts where the previous ones end. */
function replay(s: State, n: number): void {
  for (let i = 0; i < n; i++) for (const line of HW_SOLUTIONS[i]) runHwSilently(s, line, runPlain);
  s.flags = {};
  s.hw!.vars = {};
  s.hw!.active = 'jumpbox';
  s.hw!.stack = [];
  s.tutStep = 0;
  s.cmdErrors = 0;
}

// ---- state helpers for the objectives ----------------------------------------------------------------------------------------
const M = (s: State, name: string): Machine => s.hw!.machines[name];
const has = (s: State, machine: string, ...paths: string[]): boolean => paths.every(p => !!M(s, machine).files[p]);
const isExec = (s: State, machine: string, ...paths: string[]): boolean => paths.every(p => !!M(s, machine).files[p]?.exec);
const certOf = (s: State, machine: string, path: string): string | undefined => {
  const meta = M(s, machine).files[path]?.meta;
  return meta?.kind === 'cert' ? meta.section : undefined;
};
const kubeconfigUser = (s: State, machine: string, path: string): string | undefined => {
  const e = M(s, machine).files[path];
  return e?.meta?.kind === 'kubeconfig' && !kubeconfigProblem(M(s, machine), path) ? e.meta.user?.section : undefined;
};
const active = (s: State, machine: string, ...units: string[]): boolean => units.every(u => unitActive(s.hw!, machine, u));
const workers = ['node-0', 'node-1'];
const make = (id: string, fn: (s: State) => boolean, text: string): Objective => ({ id, text, check: fn });

const lab = (n: number) => (s: State) => replay(s, n);

export const HARDWAY_LEVELS: Level[] = [
  {
    id: 'h-jumpbox', title: 'The Jumpbox', tag: 'Lab 01-02: prerequisites',
    blurb: 'Clone the guide, download every binary, and install kubectl.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p><b>Kubernetes The Hard Way</b> builds a cluster from nothing: no installer, no managed service. You get four machines: a <code>jumpbox</code> (where you are now), a control plane called <code>server</code>, and two workers, <code>node-0</code> and <code>node-1</code>. You will provision all of them from the jumpbox.</p>
      <p>This terminal is a shell on the jumpbox. First get the guide's files: <code>git clone --depth 1 https://github.com/kelseyhightower/kubernetes-the-hard-way.git</code> and <code>cd</code> into it. The file <code>downloads-amd64.txt</code> lists every binary a cluster needs (<code>cat</code> it!). Download them all with <code>wget -i</code>, then sort them by where they will run: <code>client</code>, <code>controller</code>, <code>worker</code> and <code>cni-plugins</code>. Tarballs need <code>tar -xvf</code>. Finally make them executable and install <code>kubectl</code> into <code>/usr/local/bin</code>.</p>
      <p>Tip: the shell understands variables, <code>$(...)</code>, pipes, redirects, globs and <code>{a,b}</code> expansion, so you can type the guide's commands as they are. Type <code>help</code> for the list.</p>`,
    setup: lab(0),
    tutorial: LABS[0],
    objectives: [
      make('clone', s => has(s, 'jumpbox', D + '/ca.conf', D + '/units/etcd.service'), 'Clone the guide repository'),
      make('download', s => Object.keys(M(s, 'jumpbox').files).filter(f => f.startsWith(D + '/downloads/')).length >= 11, 'Download all 11 binaries and archives'),
      make('sorted', s => has(s, 'jumpbox', D + '/downloads/client/kubectl', D + '/downloads/client/etcdctl', D + '/downloads/controller/etcd', D + '/downloads/controller/kube-apiserver', D + '/downloads/worker/kubelet', D + '/downloads/worker/containerd', D + '/downloads/worker/runc', D + '/downloads/cni-plugins/bridge'),
        'Sort them into client, controller, worker and cni-plugins'),
      make('exec', s => isExec(s, 'jumpbox', D + '/downloads/client/kubectl', D + '/downloads/controller/kube-apiserver', D + '/downloads/worker/kubelet', D + '/downloads/cni-plugins/bridge'), 'Make them executable (chmod +x)'),
      make('kubectl', s => isExec(s, 'jumpbox', '/usr/local/bin/kubectl') && !!s.flags.ranKubectl, 'Install kubectl and run kubectl version --client'),
    ],
    cheats: ['git clone | get the guide', 'wget | download files', 'tar | unpack archives', 'mkdir | create folders', 'mv | move files', 'chmod | make a file executable', 'cp | copy files', 'ls | look around', 'cat | read a file'],
    hints: [
      'git clone --depth 1 https://github.com/kelseyhightower/kubernetes-the-hard-way.git, then cd kubernetes-the-hard-way and cat downloads-amd64.txt.',
      'wget -q --show-progress --https-only --timestamping -P downloads -i downloads-amd64.txt  (ls downloads afterwards)',
      'mkdir -p downloads/{client,cni-plugins,controller,worker}, then unpack: tar -xvf downloads/etcd-v3.6.0-rc.3-linux-amd64.tar.gz -C downloads/ --strip-components 1 etcd-v3.6.0-rc.3-linux-amd64/etcdctl etcd-v3.6.0-rc.3-linux-amd64/etcd',
      'Same for crictl and containerd (-C downloads/worker/, containerd needs --strip-components 1) and cni-plugins (-C downloads/cni-plugins/). Then mv downloads/{etcdctl,kubectl} downloads/client/ and so on.',
      'chmod +x downloads/{client,cni-plugins,controller,worker}/*, then cp downloads/client/kubectl /usr/local/bin/ and kubectl version --client.',
    ],
    codex: { title: 'The Hard Way: the jumpbox', text: 'A cluster is a handful of static binaries: <b>kube-apiserver</b>, <b>kube-controller-manager</b>, <b>kube-scheduler</b> and <b>etcd</b> on the control plane; <b>kubelet</b>, <b>kube-proxy</b>, <b>containerd</b>, <b>runc</b> and the <b>CNI plugins</b> on every worker; <b>kubectl</b> and <b>etcdctl</b> for you. A <i>jumpbox</i> is the machine you administer everything from.' },
  },

  {
    id: 'h-compute', title: 'Compute Resources', tag: 'Lab 03: machines, SSH, DNS',
    blurb: 'Passwordless SSH, proper hostnames, and a shared hosts file.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p>Kubernetes needs machines that can <b>find each other by name</b>. The repository contains <code>machines.txt</code>: one line per machine with its IP, FQDN, hostname and (for workers) the <b>pod subnet</b> it will hand out.</p>
      <ol><li>Create an SSH key (<code>ssh-keygen</code>) and install it on all three machines with <code>ssh-copy-id root@IP</code>. Loops that read a file work: <code>while read IP FQDN HOST SUBNET; do ...; done &lt; machines.txt</code>.</li>
      <li>Give every machine its hostname with <code>hostnamectl set-hostname</code>, run remotely with <code>ssh -n root@IP "..."</code>. The kubelet will later register the node under this exact name, so it matters!</li>
      <li>Build a <code>hosts</code> file (<code>IP FQDN HOST</code> per line) and append it to <code>/etc/hosts</code> on the jumpbox <i>and</i> on the three machines (<code>scp</code> it over, then <code>cat hosts &gt;&gt; /etc/hosts</code> there).</li></ol>
      <p>You work from the repository directory (<code>cd kubernetes-the-hard-way</code>); the jumpbox state from lab 02 is already in place.</p>`,
    setup: lab(1),
    tutorial: LABS[1],
    objectives: [
      make('keys', s => s.hw!.keyGenerated && ['server', 'node-0', 'node-1'].every(m => M(s, m).hasKey), 'Create an SSH key and copy it to server, node-0 and node-1'),
      make('hostnames', s => M(s, 'server').hostname === 'server' && M(s, 'node-0').hostname === 'node-0' && M(s, 'node-1').hostname === 'node-1', 'Set the hostnames: server, node-0, node-1'),
      make('hosts', s => ['jumpbox', 'server', 'node-0', 'node-1'].every(m => ['server.kubernetes.local', 'node-0.kubernetes.local', 'node-1.kubernetes.local'].every(f => (M(s, m).files['/etc/hosts']?.text ?? '').includes(f))),
        'Every machine can resolve the others by name (/etc/hosts)'),
    ],
    cheats: ['ssh-keygen | create a key pair', 'ssh-copy-id | install your key on a machine', 'ssh | run a command on a machine', 'scp | copy files to a machine', 'hostnamectl | set the hostname', 'cat | read a file', 'echo | write text'],
    hints: [
      'cat machines.txt, then ssh-keygen, then: while read IP FQDN HOST SUBNET; do ssh-copy-id root@${IP}; done < machines.txt',
      'while read IP FQDN HOST SUBNET; do ssh -n root@${IP} hostnamectl set-hostname ${HOST}; done < machines.txt. Check: ssh -n root@10.240.0.20 hostname.',
      'Build the file: echo "" > hosts, then while read IP FQDN HOST SUBNET; do echo "${IP} ${FQDN} ${HOST}" >> hosts; done < machines.txt, then cat hosts >> /etc/hosts here.',
      'while read IP FQDN HOST SUBNET; do scp hosts root@${HOST}:~/; ssh -n root@${HOST} "cat hosts >> /etc/hosts"; done < machines.txt',
    ],
    codex: { title: 'The Hard Way: names and SSH', text: 'Components find each other by <b>DNS name</b> (<code>server.kubernetes.local</code>), and the kubelet registers a node under its <b>hostname</b>, so both must be right before anything else. <b>machines.txt</b> is the lab\'s source of truth: IPs, names and each worker\'s <b>pod CIDR</b> (10.200.0.0/24 and 10.200.1.0/24).' },
  },

  {
    id: 'h-certs', title: 'Certificate Authority', tag: 'Lab 04: TLS certificates',
    blurb: 'One CA, eight certificates. Every component proves who it is.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p>Every Kubernetes component talks over <b>mutual TLS</b>: both sides present a certificate signed by the same <b>certificate authority</b>. Without a CA nothing can trust anything.</p>
      <p>Read <code>ca.conf</code>: it has one <code>[section]</code> per identity. The <b>CN</b> is the user name Kubernetes sees (<code>system:node:node-0</code>, <code>admin</code>), the <b>O</b> is the group (<code>system:masters</code> = cluster admin). The API server certificate also needs <b>Subject Alternative Names</b> (every name and IP clients may use to reach it).</p>
      <p>1. Create the CA key and a self-signed CA certificate (<code>openssl genrsa</code>, <code>openssl req -x509</code>).<br>2. For each of the eight sections: generate a key, create a <b>CSR</b> (<code>openssl req -new ... -section NAME</code>), and sign it with the CA (<code>openssl x509 -req ... -CA ca.crt -CAkey ca.key -CAcreateserial</code>). A <code>for</code> loop saves typing.<br>3. Inspect the API server certificate with <code>openssl x509 -in kube-api-server.crt -noout -text</code>. If its SAN list is empty you forgot <code>-copy_extensions copyall</code>.</p>`,
    setup: lab(2),
    tutorial: LABS[2],
    objectives: [
      make('ca', s => M(s, 'jumpbox').files[D + '/ca.crt']?.meta?.kind === 'cert' && has(s, 'jumpbox', D + '/ca.key'), 'Create the certificate authority (ca.key and ca.crt)'),
      make('certs', s => ['admin', 'node-0', 'node-1', 'kube-proxy', 'kube-scheduler', 'kube-controller-manager', 'kube-api-server', 'service-accounts'].every(n => certOf(s, 'jumpbox', D + '/' + n + '.crt') === n && has(s, 'jumpbox', D + '/' + n + '.key')),
        'Sign a certificate for all 8 identities'),
      make('sans', s => { const m = M(s, 'jumpbox').files[D + '/kube-api-server.crt']?.meta; return m?.kind === 'cert' && m.sans.includes('server.kubernetes.local') && m.sans.includes('IP:10.32.0.1'); }, 'The API server certificate carries its Subject Alternative Names'),
      make('inspect', s => !!s.flags.inspectedCert, 'Inspect a certificate with openssl x509 -text'),
    ],
    cheats: ['openssl genrsa | create a private key', 'openssl req | CA certificate or CSR', 'openssl x509 | sign or inspect a certificate', 'cat | read ca.conf', 'ls | list the files'],
    hints: [
      'cat ca.conf shows the sections. Start with: openssl genrsa -out ca.key 4096',
      'openssl req -x509 -new -sha512 -noenc -key ca.key -days 3653 -config ca.conf -out ca.crt',
      'for i in admin node-0 node-1 kube-proxy kube-scheduler kube-controller-manager kube-api-server service-accounts; do openssl genrsa -out "${i}.key" 4096; openssl req -new -key "${i}.key" -sha256 -config "ca.conf" -section ${i} -out "${i}.csr"; done',
      'openssl x509 -req -days 3653 -in "${i}.csr" -copy_extensions copyall -sha256 -CA "ca.crt" -CAkey "ca.key" -CAcreateserial -out "${i}.crt"  (put it inside the same loop, before done)',
      'openssl x509 -in kube-api-server.crt -noout -text lists the Subject Alternative Names.',
    ],
    codex: { title: 'The Hard Way: PKI', text: 'A <b>CA</b> signs certificates; everyone trusts its <code>ca.crt</code>. A certificate\'s <b>CN</b> becomes the Kubernetes user name and its <b>O</b> the group, which RBAC then authorises (<code>system:masters</code> is cluster-admin, <code>system:nodes</code> are kubelets). Server certificates need <b>SANs</b>: a client rejects a name that is not listed, which is the classic "x509: certificate is valid for ..., not ..." error.' },
  },

  {
    id: 'h-distribute', title: 'Handing Out Identities', tag: 'Lab 04: distribute certificates',
    blurb: 'Each machine gets only the certificates it is allowed to hold.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p>Certificates are only useful on the machine that uses them, and private keys must <b>not</b> travel further than necessary.</p>
      <ul><li>Each worker needs the CA certificate plus <i>its own</i> certificate and key, installed as <code>/var/lib/kubelet/kubelet.crt</code> and <code>kubelet.key</code>. Give <code>node-1</code> the certificate of <code>node-0</code> and the kubelet will refuse to start later, because a node may only act as itself.</li>
      <li>The control plane (<code>server</code>) needs the CA key and certificate, the API server's pair and the service-account pair.</li></ul>
      <p>Use <code>ssh root@HOST mkdir ...</code> to create the directory and <code>scp FILE root@HOST:DEST</code> to copy. A <code>for host in node-0 node-1; do ... done</code> loop does both workers at once.</p>`,
    setup: lab(3),
    tutorial: LABS[3],
    objectives: [
      make('kubelet', s => workers.every(w => has(s, w, '/var/lib/kubelet/ca.crt', '/var/lib/kubelet/kubelet.key') && certOf(s, w, '/var/lib/kubelet/kubelet.crt') === w), 'Install ca.crt, kubelet.crt and kubelet.key on each worker (its own!)'),
      make('server', s => has(s, 'server', '/root/ca.crt', '/root/ca.key', '/root/kube-api-server.crt', '/root/kube-api-server.key', '/root/service-accounts.crt', '/root/service-accounts.key'), 'Copy the CA and API server certificates to the server'),
    ],
    cheats: ['ssh | run a command on a machine', 'scp | copy files', 'mkdir | create a directory'],
    hints: [
      'for host in node-0 node-1; do ssh root@${host} mkdir /var/lib/kubelet/; done',
      'scp ca.crt root@${host}:/var/lib/kubelet/ ; scp ${host}.crt root@${host}:/var/lib/kubelet/kubelet.crt ; scp ${host}.key root@${host}:/var/lib/kubelet/kubelet.key',
      'scp ca.key ca.crt kube-api-server.key kube-api-server.crt service-accounts.key service-accounts.crt root@server:~/',
    ],
    codex: { title: 'The Hard Way: least privilege for keys', text: 'A kubelet authenticates as <code>system:node:NAME</code> and the <b>Node authorizer</b> lets it touch only its own node and pods. So each worker needs its own certificate. The CA <i>key</i> can sign new identities, so it stays on the control plane (the controller manager uses it to sign CSRs).' },
  },

  {
    id: 'h-kubeconfig', title: 'Who Talks to Whom', tag: 'Lab 05: kubeconfig files',
    blurb: 'Five components, five kubeconfigs, each with an embedded identity.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p>A <b>kubeconfig</b> tells a client <i>where</i> the API server is (cluster), <i>who</i> it is (credentials) and ties them together (context). You build them with four <code>kubectl config</code> commands:</p>
      <p><code>set-cluster</code> (server URL and CA) &rarr; <code>set-credentials</code> (client certificate and key) &rarr; <code>set-context</code> &rarr; <code>use-context</code>, all with <code>--kubeconfig=FILE</code>.</p>
      <p>Make one for each worker's kubelet (<code>system:node:node-0</code>...), plus <code>kube-proxy</code>, <code>kube-controller-manager</code> and <code>kube-scheduler</code> (the API at <code>https://server.kubernetes.local:6443</code>), and <code>admin</code> (the API at <code>https://127.0.0.1:6443</code>, because you will use it on the server itself).</p>
      <p><b>Use --embed-certs=true.</b> Without it the file only <i>points</i> at your certificate files, and breaks the moment it is copied to another machine. Then distribute: workers get <code>kubelet</code> and <code>kube-proxy</code> kubeconfigs, the server gets admin, controller-manager and scheduler.</p>`,
    setup: lab(4),
    tutorial: LABS[4],
    objectives: [
      make('nodes', s => workers.every(w => kubeconfigUser(s, 'jumpbox', D + '/' + w + '.kubeconfig') === w), 'Create node-0.kubeconfig and node-1.kubeconfig (embedded certs)'),
      make('components', s => [['kube-proxy', 'kube-proxy'], ['kube-controller-manager', 'kube-controller-manager'], ['kube-scheduler', 'kube-scheduler'], ['admin', 'admin']].every(([f, u]) => kubeconfigUser(s, 'jumpbox', D + '/' + f + '.kubeconfig') === u),
        'Create kube-proxy, kube-controller-manager, kube-scheduler and admin kubeconfigs'),
      make('workers', s => workers.every(w => kubeconfigUser(s, w, '/var/lib/kubelet/kubeconfig') === w && kubeconfigUser(s, w, '/var/lib/kube-proxy/kubeconfig') === 'kube-proxy'), 'Install the kubelet and kube-proxy kubeconfigs on the workers'),
      make('server', s => ['admin', 'kube-controller-manager', 'kube-scheduler'].every(f => kubeconfigUser(s, 'server', '/root/' + f + '.kubeconfig') === f), 'Copy the admin, controller-manager and scheduler kubeconfigs to the server'),
    ],
    cheats: ['kubectl config | build a kubeconfig', 'scp | copy files to a machine', 'ssh | run a command on a machine', 'cat | read a kubeconfig'],
    hints: [
      'kubectl config set-cluster kubernetes-the-hard-way --certificate-authority=ca.crt --embed-certs=true --server=https://server.kubernetes.local:6443 --kubeconfig=node-0.kubeconfig',
      'kubectl config set-credentials system:node:node-0 --client-certificate=node-0.crt --client-key=node-0.key --embed-certs=true --kubeconfig=node-0.kubeconfig, then set-context default --cluster=kubernetes-the-hard-way --user=system:node:node-0, then use-context default (all with --kubeconfig).',
      'Wrap the four commands in: for host in node-0 node-1; do ...; done and use ${host}. Do the same for kube-proxy, kube-controller-manager, kube-scheduler (user system:kube-proxy ...).',
      'admin is special: --server=https://127.0.0.1:6443 and the user is just "admin".',
      'for host in node-0 node-1; do ssh root@${host} "mkdir -p /var/lib/{kube-proxy,kubelet}"; scp kube-proxy.kubeconfig root@${host}:/var/lib/kube-proxy/kubeconfig; scp ${host}.kubeconfig root@${host}:/var/lib/kubelet/kubeconfig; done',
      'scp admin.kubeconfig kube-controller-manager.kubeconfig kube-scheduler.kubeconfig root@server:~/',
    ],
    codex: { title: 'The Hard Way: kubeconfig', text: 'A kubeconfig = <b>clusters</b> + <b>users</b> (credentials) + <b>contexts</b>. <code>--embed-certs=true</code> stores the certificate <i>data</i> inside the file so it stays valid anywhere; otherwise it stores a <i>path</i>. Each control plane component and each node authenticates to the API server with its own kubeconfig.' },
  },

  {
    id: 'h-encryption', title: 'Secrets at Rest', tag: 'Lab 06: data encryption',
    blurb: 'Generate an encryption key and keep Secrets unreadable in etcd.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p>By default a Kubernetes <b>Secret</b> is stored in etcd as plain base64, readable by anyone with access to the datastore. The API server can <b>encrypt Secrets at rest</b> if you give it an <code>EncryptionConfiguration</code> with a 32-byte key.</p>
      <p>Generate a random key and keep it in an environment variable: <code>export ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)</code>. The template <code>configs/encryption-config.yaml</code> contains <code>\${ENCRYPTION_KEY}</code>; fill it with <code>envsubst &lt; configs/encryption-config.yaml &gt; encryption-config.yaml</code>, read the result with <code>cat</code>, and copy it to the server.</p>
      <p>Careful: if the variable is empty the template is filled with nothing, and the API server will refuse to start later.</p>`,
    setup: lab(5),
    tutorial: LABS[5],
    objectives: [
      make('config', s => M(s, 'jumpbox').files[D + '/encryption-config.yaml']?.meta?.kind === 'encryption' && (M(s, 'jumpbox').files[D + '/encryption-config.yaml']!.meta as { keyOk: boolean }).keyOk, 'Create encryption-config.yaml with a valid 32-byte key'),
      make('server', s => { const m = M(s, 'server').files['/root/encryption-config.yaml']?.meta; return m?.kind === 'encryption' && m.keyOk; }, 'Copy it to the server'),
    ],
    cheats: ['export | set an environment variable', 'head | take random bytes', 'envsubst | fill in a template', 'cat | read the result', 'scp | copy to the server'],
    hints: [
      'export ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)   then   echo $ENCRYPTION_KEY',
      'envsubst < configs/encryption-config.yaml > encryption-config.yaml',
      'cat encryption-config.yaml should show a long secret: line. Then scp encryption-config.yaml root@server:~/',
    ],
    codex: { title: 'The Hard Way: encryption at rest', text: 'etcd holds every object, including Secrets. An <code>EncryptionConfiguration</code> with an <b>aescbc</b> provider makes the API server encrypt Secrets before writing them; the first provider encrypts, later ones can still read old data. The key must be exactly 16, 24 or 32 bytes (base64 encoded).' },
  },

  {
    id: 'h-etcd', title: 'The Memory of the Cluster', tag: 'Lab 07: etcd',
    blurb: 'Install etcd on the server as a systemd service.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p><b>etcd</b> is the database where Kubernetes keeps all its state. You will run a single-member etcd on <code>server</code> as a <b>systemd</b> service.</p>
      <ol><li>From the jumpbox, <code>scp</code> the <code>etcd</code> and <code>etcdctl</code> binaries and <code>units/etcd.service</code> to the server (read the unit with <code>cat</code>!).</li>
      <li>On the server (<code>ssh root@server</code>, or one-off commands with <code>ssh root@server "cmd; cmd"</code>): move the binaries to <code>/usr/local/bin/</code>, create the config and data directories <code>/etc/etcd</code> and <code>/var/lib/etcd</code>, copy the unit to <code>/etc/systemd/system/</code>.</li>
      <li><code>systemctl daemon-reload</code> so systemd notices the new unit, then <code>systemctl enable etcd</code> and <code>systemctl start etcd</code>. If it fails, <code>systemctl status etcd</code> and <code>journalctl -u etcd</code> explain why.</li>
      <li>Check with <code>etcdctl member list</code>.</li></ol>`,
    setup: lab(6),
    tutorial: LABS[6],
    objectives: [
      make('binaries', s => isExec(s, 'server', '/usr/local/bin/etcd', '/usr/local/bin/etcdctl'), 'Install etcd and etcdctl in /usr/local/bin on the server'),
      make('unit', s => has(s, 'server', '/etc/systemd/system/etcd.service') && !!M(s, 'server').units.etcd?.enabled, 'Install and enable the etcd systemd unit'),
      make('running', s => active(s, 'server', 'etcd'), 'etcd is running'),
      make('member', s => !!s.flags.usedEtcdctl, 'List the members with etcdctl member list'),
    ],
    cheats: ['scp | copy files', 'ssh | log in or run a command', 'mv | move files', 'mkdir | create directories', 'systemctl | manage services', 'journalctl | read service logs', 'etcdctl | talk to etcd'],
    hints: [
      'scp downloads/controller/etcd downloads/client/etcdctl units/etcd.service root@server:~/',
      'ssh root@server   then   mv etcd etcdctl /usr/local/bin/ ; mkdir -p /etc/etcd /var/lib/etcd ; chmod 700 /var/lib/etcd',
      'mv etcd.service /etc/systemd/system/ ; systemctl daemon-reload ; systemctl enable etcd ; systemctl start etcd',
      'If start fails: systemctl status etcd and journalctl -u etcd. Then etcdctl member list. Type exit to go back to the jumpbox.',
    ],
    codex: { title: 'The Hard Way: etcd & systemd', text: '<b>etcd</b> is a consistent key-value store; the API server is its only client. A <b>systemd unit</b> describes how to run a process (<code>ExecStart</code>, <code>Restart</code>). After adding or changing a unit file run <code>systemctl daemon-reload</code>; <code>enable</code> starts it at boot, <code>start</code> starts it now, and <code>status</code> / <code>journalctl -u</code> show why it failed.' },
  },

  {
    id: 'h-controlplane', title: 'The Control Plane', tag: 'Lab 08: API server, controller manager, scheduler',
    blurb: 'Three services, one RBAC rule, and a cluster that answers.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p>Time for the brain: <code>kube-apiserver</code> (the front door and the only component that talks to etcd), <code>kube-controller-manager</code> (runs the control loops) and <code>kube-scheduler</code> (places pods on nodes).</p>
      <p>Copy their binaries, <code>kubectl</code>, the three unit files, <code>configs/kube-scheduler.yaml</code> and <code>configs/kube-apiserver-to-kubelet.yaml</code> to the server. There, put everything exactly where the units expect it (<code>cat</code> a unit: the <code>--...=/var/lib/kubernetes/...</code> flags are the map):</p>
      <ul><li>binaries &rarr; <code>/usr/local/bin/</code></li><li>certificates, keys, <code>encryption-config.yaml</code> &rarr; <code>/var/lib/kubernetes/</code></li><li>the controller-manager and scheduler kubeconfigs &rarr; <code>/var/lib/kubernetes/</code></li><li><code>kube-scheduler.yaml</code> &rarr; <code>/etc/kubernetes/config/</code></li><li>unit files &rarr; <code>/etc/systemd/system/</code></li></ul>
      <p>Reload, enable and start the three services (order matters: the API server needs etcd, the other two need the API server). Then apply the RBAC rule that lets the API server call the kubelets (<code>kubectl apply -f kube-apiserver-to-kubelet.yaml --kubeconfig admin.kubeconfig</code>) and check from the jumpbox with <code>curl --cacert ca.crt https://server.kubernetes.local:6443/version</code>.</p>`,
    setup: lab(7),
    tutorial: LABS[7],
    objectives: [
      make('files', s => has(s, 'server', '/var/lib/kubernetes/ca.crt', '/var/lib/kubernetes/kube-api-server.crt', '/var/lib/kubernetes/service-accounts.key', '/var/lib/kubernetes/encryption-config.yaml', '/var/lib/kubernetes/kube-controller-manager.kubeconfig', '/var/lib/kubernetes/kube-scheduler.kubeconfig', '/etc/kubernetes/config/kube-scheduler.yaml'), 'Put certificates, kubeconfigs and configs in /var/lib/kubernetes and /etc/kubernetes/config'),
      make('api', s => apiserverUp(s.hw!), 'kube-apiserver is running'),
      make('managers', s => active(s, 'server', 'kube-controller-manager', 'kube-scheduler'), 'kube-controller-manager and kube-scheduler are running'),
      make('rbac', s => s.hw!.rbacApplied, 'Apply the API server to kubelet RBAC rule'),
      make('curl', s => !!s.flags.curledApi, 'Reach the API from the jumpbox: curl --cacert ca.crt https://server.kubernetes.local:6443/version'),
    ],
    cheats: ['scp | copy files', 'ssh | run commands on the server', 'mv | move files', 'systemctl | manage services', 'journalctl | read service logs', 'kubectl apply | create the RBAC rule', 'curl | call the API'],
    hints: [
      'scp downloads/controller/kube-apiserver downloads/controller/kube-controller-manager downloads/controller/kube-scheduler downloads/client/kubectl units/kube-apiserver.service units/kube-controller-manager.service units/kube-scheduler.service configs/kube-scheduler.yaml configs/kube-apiserver-to-kubelet.yaml root@server:~/',
      'ssh root@server, then: mv kube-apiserver kube-controller-manager kube-scheduler kubectl /usr/local/bin/ ; mkdir -p /etc/kubernetes/config /var/lib/kubernetes/',
      'mv ca.crt ca.key kube-api-server.key kube-api-server.crt service-accounts.key service-accounts.crt encryption-config.yaml /var/lib/kubernetes/ ; mv kube-controller-manager.kubeconfig kube-scheduler.kubeconfig /var/lib/kubernetes/ ; mv kube-scheduler.yaml /etc/kubernetes/config/',
      'mv kube-apiserver.service kube-controller-manager.service kube-scheduler.service /etc/systemd/system/ ; systemctl daemon-reload ; systemctl enable kube-apiserver kube-controller-manager kube-scheduler ; systemctl start kube-apiserver kube-controller-manager kube-scheduler',
      'A service failed? systemctl status NAME and journalctl -u NAME name the missing file or the missing dependency.',
      'kubectl apply -f kube-apiserver-to-kubelet.yaml --kubeconfig admin.kubeconfig (on the server). Then back on the jumpbox: curl --cacert ca.crt https://server.kubernetes.local:6443/version',
    ],
    codex: { title: 'The Hard Way: the control plane', text: 'The <b>API server</b> authenticates every request (client certificates), authorises it (<b>RBAC</b>, <b>Node</b> authorizer), and persists objects in etcd. The <b>controller manager</b> runs reconcile loops (Deployments, ReplicaSets, nodes) and the <b>scheduler</b> binds pending pods to nodes. The API server also acts as a <i>client of the kubelet</i> (logs, exec), which RBAC must allow explicitly.' },
  },

  {
    id: 'h-workers', title: 'Worker Nodes', tag: 'Lab 09: containerd, kubelet, kube-proxy, CNI',
    blurb: 'Turn two blank machines into nodes that can run pods.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p>Each worker runs <code>containerd</code> (+ <code>runc</code>) to run containers, the <code>kubelet</code> to talk to the API server and manage pods, <code>kube-proxy</code> for Services, and <b>CNI plugins</b> for pod networking. The configuration depends on the node: the bridge network and kubelet config contain the node's <b>pod subnet</b> placeholder <code>SUBNET</code>, which you replace with <code>sed</code> using the value from <code>machines.txt</code>.</p>
      <ol><li>From the jumpbox generate <code>10-bridge.conf</code> and <code>kubelet-config.yaml</code> per node (<code>sed "s|SUBNET|$SUBNET|g"</code>) and <code>scp</code> them, plus every file in <code>downloads/worker/</code>, <code>kubectl</code>, the CNI plugins, configs and unit files.</li>
      <li>On each worker: <code>apt-get -y install socat conntrack ipset kmod</code>, <b>turn swap off</b> (<code>swapoff -a</code>, the kubelet refuses to run with swap), create the directories, move every file to its place, load <code>br-netfilter</code> and set the bridge sysctls, then start <code>containerd</code>, <code>kubelet</code> and <code>kube-proxy</code>.</li>
      <li>Verify from the server: <code>kubectl get nodes --kubeconfig admin.kubeconfig</code>.</li></ol>
      <p>Mistakes teach here: a missing package, a still-active swap or the wrong node's certificate each stop a service with a clear message in <code>systemctl status</code> and <code>journalctl -u</code>.</p>`,
    setup: lab(8),
    tutorial: LABS[8],
    objectives: [
      make('prep', s => workers.every(w => !M(s, w).swap && ['socat', 'conntrack', 'ipset', 'kmod'].every(p => M(s, w).packages.includes(p))), 'Install the packages and turn swap off on both workers'),
      make('runtime', s => workers.every(w => active(s, w, 'containerd')), 'containerd is running on both workers'),
      make('kubelet', s => workers.every(w => active(s, w, 'kubelet')), 'The kubelet is running on both workers'),
      make('proxy', s => workers.every(w => active(s, w, 'kube-proxy')), 'kube-proxy is running on both workers'),
      make('ready', s => workers.every(w => s.nodes.some(n => n.name === w && n.bootUntil === 0)) && !!s.flags.listedNodes, 'Both nodes are Ready in kubectl get nodes'),
    ],
    cheats: ['sed | fill in the subnet', 'scp | copy files', 'ssh | run commands on a node', 'apt-get | install packages', 'swapoff | turn swap off', 'modprobe | load a kernel module', 'systemctl | manage services', 'kubectl get | list nodes'],
    hints: [
      'for HOST in node-0 node-1; do SUBNET=$(grep ${HOST} machines.txt | cut -d " " -f 4); sed "s|SUBNET|$SUBNET|g" configs/10-bridge.conf > 10-bridge.conf; sed "s|SUBNET|$SUBNET|g" configs/kubelet-config.yaml > kubelet-config.yaml; scp 10-bridge.conf kubelet-config.yaml root@${HOST}:~/; done',
      'for HOST in node-0 node-1; do scp downloads/worker/* downloads/client/kubectl configs/99-loopback.conf configs/containerd-config.toml configs/kube-proxy-config.yaml units/containerd.service units/kubelet.service units/kube-proxy.service root@${HOST}:~/; done  and  scp downloads/cni-plugins/* root@${HOST}:~/cni-plugins/',
      'On a node: apt-get -y install socat conntrack ipset kmod ; swapoff -a ; mkdir -p /etc/cni/net.d /opt/cni/bin /var/lib/kubelet /var/lib/kube-proxy /var/lib/kubernetes /var/run/kubernetes',
      'mv crictl kube-proxy kubelet runc /usr/local/bin/ ; mv containerd containerd-shim-runc-v2 containerd-stress /bin/ ; mv cni-plugins/* /opt/cni/bin/ ; mv 10-bridge.conf 99-loopback.conf /etc/cni/net.d/',
      "modprobe br-netfilter ; echo br-netfilter >> /etc/modules-load.d/modules.conf ; echo 'net.bridge.bridge-nf-call-iptables = 1' >> /etc/sysctl.d/kubernetes.conf ; sysctl -p /etc/sysctl.d/kubernetes.conf",
      'mkdir -p /etc/containerd/ ; mv containerd-config.toml /etc/containerd/config.toml ; mv containerd.service kubelet.service kube-proxy.service /etc/systemd/system/ ; mv kubelet-config.yaml /var/lib/kubelet/ ; mv kube-proxy-config.yaml /var/lib/kube-proxy/',
      'systemctl daemon-reload ; systemctl enable containerd kubelet kube-proxy ; systemctl start containerd kubelet kube-proxy. Repeat on node-1, then ssh root@server "kubectl get nodes --kubeconfig admin.kubeconfig".',
    ],
    codex: { title: 'The Hard Way: worker nodes', text: 'A node = <b>containerd</b> (container runtime via CRI) + <b>runc</b> (starts containers) + <b>kubelet</b> (the node agent that registers the node and runs pods) + <b>kube-proxy</b> (Service routing with iptables) + <b>CNI plugins</b> (give each pod an IP from the node\'s pod CIDR). The kubelet refuses to run with <b>swap</b>, and the bridge needs <code>br_netfilter</code> so iptables sees bridged traffic. A node is <b>Ready</b> only when its runtime and network are healthy.' },
  },

  {
    id: 'h-remote', title: 'Remote Access', tag: 'Lab 10: kubectl from the jumpbox',
    blurb: 'Stop SSHing into the server. Talk to the API directly.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p>So far you ran <code>kubectl</code> on the server with <code>admin.kubeconfig</code>. A real admin uses their own machine. First check that the API answers over TLS: <code>curl --cacert ca.crt https://server.kubernetes.local:6443/version</code> (without <code>--cacert</code> curl rightly complains it does not trust the server).</p>
      <p>Then build the default kubeconfig (<code>~/.kube/config</code>) on the jumpbox: <code>set-cluster</code> with the CA and server URL, <code>set-credentials admin</code> with <code>admin.crt</code>/<code>admin.key</code>, a <code>set-context</code>, and <code>use-context</code>. Finish with <code>kubectl version</code> and <code>kubectl get nodes</code>.</p>`,
    setup: lab(9),
    tutorial: LABS[9],
    objectives: [
      make('curl', s => !!s.flags.curledApi, 'Call the API with curl and the CA certificate'),
      make('config', s => { const e = M(s, 'jumpbox').files['/root/.kube/config']; return e?.meta?.kind === 'kubeconfig' && !kubeconfigProblem(M(s, 'jumpbox'), '/root/.kube/config') && e.meta.current === 'kubernetes-the-hard-way'; }, 'Create the default kubeconfig with context kubernetes-the-hard-way'),
      make('nodes', s => !!s.flags.jumpboxKubectl && !!s.flags.listedNodes && s.nodes.length === 2, 'Run kubectl get nodes from the jumpbox'),
    ],
    cheats: ['curl | call the API', 'kubectl config | build your kubeconfig', 'kubectl version | client and server versions', 'kubectl get | list nodes'],
    hints: [
      'curl --cacert ca.crt https://server.kubernetes.local:6443/version',
      'kubectl config set-cluster kubernetes-the-hard-way --certificate-authority=ca.crt --embed-certs=true --server=https://server.kubernetes.local:6443',
      'kubectl config set-credentials admin --client-certificate=admin.crt --client-key=admin.key',
      'kubectl config set-context kubernetes-the-hard-way --cluster=kubernetes-the-hard-way --user=admin, then kubectl config use-context kubernetes-the-hard-way',
      'kubectl version, then kubectl get nodes',
    ],
    codex: { title: 'The Hard Way: remote kubectl', text: 'kubectl reads <code>~/.kube/config</code> by default. For TLS to succeed the API server certificate must list the name you connect to as a <b>SAN</b> and be signed by the CA in your kubeconfig. Your identity (<code>admin</code>, group <code>system:masters</code>) comes from your client certificate.' },
  },

  {
    id: 'h-routes', title: 'Pod Network Routes', tag: 'Lab 11: routing between nodes',
    blurb: 'Pods on different nodes cannot reach each other until the machines know the way.',
    nodes: 0, slots: 6, traffic: null, hardway: 'machines',
    story: `<p>Each node hands out pod IPs from its own subnet (<code>node-0</code>: <code>10.200.0.0/24</code>, <code>node-1</code>: <code>10.200.1.0/24</code>). A packet for a pod on another node has to be routed to <i>that node's</i> IP. Cloud networks usually do this for you; here you add static routes with <code>ip route add SUBNET via NODE_IP</code>.</p>
      <p>Pull the values out of <code>machines.txt</code> into variables with <code>$(grep ... | cut -d " " -f N)</code> (the IP is field 1, the subnet field 4), then add:</p>
      <ul><li>on <code>server</code>: a route to <i>both</i> pod subnets,</li><li>on <code>node-0</code>: a route to node-1's subnet,</li><li>on <code>node-1</code>: a route to node-0's subnet.</li></ul>
      <p>Check with <code>ssh root@HOST ip route</code>.</p>`,
    setup: lab(10),
    tutorial: LABS[10],
    objectives: [
      make('server', s => ['10.200.0.0/24 via 10.240.0.20', '10.200.1.0/24 via 10.240.0.21'].every(r => M(s, 'server').routes.includes(r)), 'server routes to both pod subnets'),
      make('node-0', s => M(s, 'node-0').routes.includes('10.200.1.0/24 via 10.240.0.21'), 'node-0 routes to node-1\'s pods'),
      make('node-1', s => M(s, 'node-1').routes.includes('10.200.0.0/24 via 10.240.0.20'), 'node-1 routes to node-0\'s pods'),
    ],
    cheats: ['grep | find a line in a file', 'cut | pick a field', 'ssh | run a command on a machine', 'ip route | show or add routes'],
    hints: [
      'cat machines.txt: the IP is field 1 and the pod subnet field 4 of each line.',
      'NODE_0_IP=$(grep node-0 machines.txt | cut -d " " -f 1) and NODE_0_SUBNET=$(grep node-0 machines.txt | cut -d " " -f 4); the same for node-1.',
      'ssh root@server "ip route add ${NODE_0_SUBNET} via ${NODE_0_IP}; ip route add ${NODE_1_SUBNET} via ${NODE_1_IP}"',
      'ssh root@node-0 "ip route add ${NODE_1_SUBNET} via ${NODE_1_IP}" and ssh root@node-1 "ip route add ${NODE_0_SUBNET} via ${NODE_0_IP}"',
    ],
    codex: { title: 'The Hard Way: pod routes', text: 'Kubernetes requires every pod to reach every other pod <b>without NAT</b>. With a per-node pod CIDR and plain Linux, that means routes: <code>ip route add &lt;other node\'s pod CIDR&gt; via &lt;other node IP&gt;</code> on every machine. Overlay networks (Flannel, Calico) automate exactly this.' },
  },

  {
    id: 'h-smoke', title: 'Smoke Test', tag: 'Lab 12: does it really work?',
    blurb: 'Encryption, deployments, port-forward, logs, exec and a NodePort service.',
    nodes: 0, slots: 6, hardway: 'cluster', traffic: null,
    story: `<p>The cluster is built. Prove it works end to end, with the same checks as the guide:</p>
      <ol><li><b>Encryption at rest:</b> create a Secret (<code>kubectl create secret generic kubernetes-the-hard-way --from-literal="mykey=mydata"</code>) and read it straight from etcd on the server: <code>ssh root@server 'etcdctl get /registry/secrets/default/kubernetes-the-hard-way | hexdump -C'</code>. The value must start with <code>k8s:enc:aescbc:v1:key1</code>, not plain text.</li>
      <li><b>Deployments:</b> <code>kubectl create deployment nginx --image=nginx:latest</code>.</li>
      <li><b>Port forwarding</b>, <b>logs</b> and <b>exec</b> against the nginx pod (these go API server &rarr; kubelet, so they need the RBAC rule from lab 08 and <code>socat</code> on the node).</li>
      <li><b>Services:</b> expose it as a <code>NodePort</code> and <code>curl -I</code> a node on that port. The pod may run on the <i>other</i> node: that only works because of the routes from lab 11.</li></ol>
      <p>Tip: put values into variables with <code>$(kubectl get ... -o jsonpath="...")</code>.</p>`,
    setup: lab(11),
    tutorial: LABS[11],
    objectives: [
      make('encrypted', s => s.secrets.some(x => x.name === 'kubernetes-the-hard-way') && !!s.flags.checkedEncryption, 'Create a Secret and look at it in etcd (encrypted at rest)'),
      make('deployment', s => readyCount(s, 'nginx') >= 1, 'Run an nginx Deployment'),
      make('forward', s => !!s.flags.portForwarded, 'Port-forward to the nginx pod'),
      make('logs', s => !!s.flags.readPodLogs, 'Read the nginx pod logs'),
      make('exec', s => !!s.flags.usedExec, 'Run nginx -v inside the pod with kubectl exec'),
      make('nodeport', s => !!s.flags.curledNodePort, 'Expose it as a NodePort Service and call it with curl'),
    ],
    cheats: ['kubectl create | a Secret or a Deployment', 'kubectl get | pods and services', 'kubectl port-forward | tunnel to a pod', 'kubectl logs | container output', 'kubectl exec | run a command in a pod', 'kubectl expose | create a Service', 'ssh | read etcd on the server', 'curl | call the service'],
    hints: [
      'kubectl create secret generic kubernetes-the-hard-way --from-literal="mykey=mydata", then ssh root@server \'etcdctl get /registry/secrets/default/kubernetes-the-hard-way | hexdump -C\'',
      'kubectl create deployment nginx --image=nginx:latest, then kubectl get pods -l app=nginx. Wait a few seconds for Running.',
      'POD_NAME=$(kubectl get pods -l app=nginx -o jsonpath="{.items[0].metadata.name}") then kubectl port-forward $POD_NAME 8080:80, kubectl logs $POD_NAME, kubectl exec -ti $POD_NAME -- nginx -v',
      'kubectl expose deployment nginx --port 80 --type NodePort, then NODE_PORT=$(kubectl get svc nginx --output=jsonpath="{.spec.ports[0].nodePort}")',
      'NODE_NAME=$(kubectl get pods -l app=nginx -o jsonpath="{.items[0].spec.nodeName}") then curl -I http://${NODE_NAME}:${NODE_PORT}',
    ],
    codex: { title: 'The Hard Way: smoke test', text: 'A cluster is only done when the whole path works: <b>API &rarr; scheduler &rarr; kubelet &rarr; containerd</b>, encryption in etcd, <b>port-forward / logs / exec</b> (API server calling the kubelet, authorised by RBAC), and a <b>NodePort</b> Service (kube-proxy opening the same port on every node and routing across the pod network).' },
  },
];
