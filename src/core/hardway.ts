// Kubernetes the Hard Way: the lab. Four machines (jumpbox, server, node-0, node-1) with a virtual file system,
// certificates, kubeconfigs and systemd units. Whether a service starts depends on the files really being where the
// guide puts them, so a mistake produces the same kind of failure you would see on real machines.

// ---- file model -------------------------------------------------------------------------------------------------
export interface CertSpec { cn: string; org?: string; sans: string[] }

export type FileMeta =
  | { kind: 'key' }
  | { kind: 'csr'; section: string }
  | { kind: 'cert'; section: string; ca: boolean; sans: string[]; cn: string }
  | { kind: 'kubeconfig'; cluster?: { name: string; server: string; ca: boolean }; user?: { name: string; section?: string; embedded: boolean; cert?: string }; context?: { name: string; cluster: string; user: string }; current?: string }
  | { kind: 'encryption'; keyOk: boolean }
  | { kind: 'bin' };

export interface FileEntry { text: string; meta?: FileMeta; exec?: boolean }

export interface Unit { enabled: boolean; active: boolean; loaded: boolean; journal: string[] }

export interface Machine {
  name: string;
  fqdn: string;
  ip: string;
  /** pod CIDR of a worker */
  subnet?: string;
  hostname: string;
  files: Record<string, FileEntry>;
  dirs: Record<string, true>;
  units: Record<string, Unit>;
  routes: string[];
  swap: boolean;
  modules: string[];
  packages: string[];
  hasKey: boolean;
}

export interface HardWay {
  machines: Record<string, Machine>;
  /** the machine the terminal is on (ssh moves it) */
  active: string;
  stack: string[];
  cwd: Record<string, string>;
  vars: Record<string, string>;
  rbacApplied: boolean;
  /** the jumpbox has an SSH key pair */
  keyGenerated: boolean;
  /** files fetched into downloads/ by wget */
  cloned: boolean;
}

export const MACHINE_NAMES = ['jumpbox', 'server', 'node-0', 'node-1'];
const IPS: Record<string, string> = { jumpbox: '10.240.0.5', server: '10.240.0.10', 'node-0': '10.240.0.20', 'node-1': '10.240.0.21' };
const SUBNETS: Record<string, string> = { 'node-0': '10.200.0.0/24', 'node-1': '10.200.1.0/24' };

// ---- certificates ----------------------------------------------------------------------------------------------------
const API_SANS = ['kubernetes', 'kubernetes.default', 'kubernetes.default.svc', 'kubernetes.default.svc.cluster', 'kubernetes.svc.cluster.local', 'server.kubernetes.local', 'api-server.kubernetes.local'];
export const CERT_SPECS: Record<string, CertSpec> = {
  admin: { cn: 'admin', org: 'system:masters', sans: [] },
  'node-0': { cn: 'system:node:node-0', org: 'system:nodes', sans: ['node-0', 'node-0.kubernetes.local', 'IP:' + IPS['node-0'], 'IP:127.0.0.1'] },
  'node-1': { cn: 'system:node:node-1', org: 'system:nodes', sans: ['node-1', 'node-1.kubernetes.local', 'IP:' + IPS['node-1'], 'IP:127.0.0.1'] },
  'kube-proxy': { cn: 'system:kube-proxy', org: 'system:node-proxier', sans: ['kube-proxy', 'kube-proxy.kubernetes.local'] },
  'kube-scheduler': { cn: 'system:kube-scheduler', org: 'system:system:kube-scheduler', sans: ['kube-scheduler', 'kube-scheduler.kubernetes.local'] },
  'kube-controller-manager': { cn: 'system:kube-controller-manager', org: 'system:kube-controller-manager', sans: ['kube-controller-manager', 'kube-controller-manager.kubernetes.local'] },
  'kube-api-server': { cn: 'kubernetes', org: 'Kubernetes', sans: [...API_SANS, 'IP:127.0.0.1', 'IP:10.32.0.1'] },
  'service-accounts': { cn: 'service-accounts', org: 'Kubernetes', sans: [] },
};

function caConf(): string {
  const out = [
    '[req]', 'distinguished_name = req_distinguished_name', 'prompt             = no', 'x509_extensions    = ca_x509_extensions', '',
    '[ca_x509_extensions]', 'basicConstraints = CA:TRUE', 'keyUsage         = cRLSign, keyCertSign', '',
    '[req_distinguished_name]', 'C   = US', 'ST  = Washington', 'L   = Seattle', 'CN  = CA', '',
  ];
  for (const [name, c] of Object.entries(CERT_SPECS)) {
    out.push('[' + name + ']', 'distinguished_name = ' + name + '_distinguished_name', 'prompt             = no', 'req_extensions     = ' + (c.sans.length ? name + '_req_extensions' : 'default_req_extensions'), '');
    if (c.sans.length) out.push('[' + name + '_req_extensions]', 'basicConstraints     = CA:FALSE', 'extendedKeyUsage     = clientAuth, serverAuth', 'subjectAltName       = @' + name + '_alt_names', '');
    out.push('[' + name + '_distinguished_name]', 'CN = ' + c.cn, ...(c.org ? ['O  = ' + c.org] : []), 'C  = US', '');
    if (c.sans.length) {
      out.push('[' + name + '_alt_names]');
      let d = 0, i = 0;
      for (const s of c.sans) out.push(s.startsWith('IP:') ? 'IP.' + ++i + ' = ' + s.slice(3) : 'DNS.' + ++d + ' = ' + s);
      out.push('');
    }
  }
  return out.join('\n');
}

// ---- the cloned repository ------------------------------------------------------------------------------------------------
export const REPO_DIR = '/root/kubernetes-the-hard-way';
const V = 'v1.32.3';
const URLS = [
  'https://dl.k8s.io/' + V + '/bin/linux/amd64/kubectl',
  'https://dl.k8s.io/' + V + '/bin/linux/amd64/kube-apiserver',
  'https://dl.k8s.io/' + V + '/bin/linux/amd64/kube-controller-manager',
  'https://dl.k8s.io/' + V + '/bin/linux/amd64/kube-scheduler',
  'https://dl.k8s.io/' + V + '/bin/linux/amd64/kube-proxy',
  'https://dl.k8s.io/' + V + '/bin/linux/amd64/kubelet',
  'https://github.com/kubernetes-sigs/cri-tools/releases/download/v1.32.0/crictl-v1.32.0-linux-amd64.tar.gz',
  'https://github.com/opencontainers/runc/releases/download/v1.3.0-rc.1/runc.amd64',
  'https://github.com/containernetworking/plugins/releases/download/v1.6.2/cni-plugins-linux-amd64-v1.6.2.tgz',
  'https://github.com/containerd/containerd/releases/download/v2.1.0-beta.0/containerd-2.1.0-beta.0-linux-amd64.tar.gz',
  'https://github.com/etcd-io/etcd/releases/download/v3.6.0-rc.3/etcd-v3.6.0-rc.3-linux-amd64.tar.gz',
];

/** What is inside each downloaded tarball. */
export const ARCHIVES: Record<string, string[]> = {
  'crictl-v1.32.0-linux-amd64.tar.gz': ['crictl'],
  'containerd-2.1.0-beta.0-linux-amd64.tar.gz': ['bin/containerd', 'bin/containerd-shim-runc-v2', 'bin/containerd-stress', 'bin/ctr'],
  'cni-plugins-linux-amd64-v1.6.2.tgz': ['./bridge', './host-local', './loopback', './portmap', './firewall'],
  'etcd-v3.6.0-rc.3-linux-amd64.tar.gz': ['etcd-v3.6.0-rc.3-linux-amd64/etcd', 'etcd-v3.6.0-rc.3-linux-amd64/etcdctl', 'etcd-v3.6.0-rc.3-linux-amd64/etcdutl', 'etcd-v3.6.0-rc.3-linux-amd64/README.md'],
};

const unit = (desc: string, exec: string[], extra: string[] = [], after = ''): string => [
  '[Unit]', 'Description=' + desc, 'Documentation=https://github.com/kubernetes/kubernetes', ...(after ? ['After=' + after] : []), '',
  '[Service]', ...extra, 'ExecStart=' + exec.join(' \\\n  '), 'Restart=on-failure', 'RestartSec=5', '',
  '[Install]', 'WantedBy=multi-user.target', '',
].join('\n');

const REPO: Record<string, string> = {
  'ca.conf': caConf(),
  'machines.txt': [
    IPS.server + ' server.kubernetes.local server',
    IPS['node-0'] + ' node-0.kubernetes.local node-0 ' + SUBNETS['node-0'],
    IPS['node-1'] + ' node-1.kubernetes.local node-1 ' + SUBNETS['node-1'], '',
  ].join('\n'),
  'downloads-amd64.txt': URLS.join('\n') + '\n',
  'downloads-arm64.txt': URLS.join('\n').replace(/amd64/g, 'arm64') + '\n',
  'configs/10-bridge.conf': ['{', '  "cniVersion": "1.0.0",', '  "name": "bridge",', '  "type": "bridge",', '  "bridge": "cnio0",', '  "isGateway": true,', '  "ipMasq": true,', '  "ipam": {', '    "type": "host-local",', '    "ranges": [[{"subnet": "SUBNET"}]],', '    "routes": [{"dst": "0.0.0.0/0"}]', '  }', '}', ''].join('\n'),
  'configs/99-loopback.conf': ['{', '  "cniVersion": "1.1.0",', '  "name": "lo",', '  "type": "loopback"', '}', ''].join('\n'),
  'configs/containerd-config.toml': ['version = 2', '', '[plugins."io.containerd.grpc.v1.cri"]', '  [plugins."io.containerd.grpc.v1.cri".containerd]', '    snapshotter = "overlayfs"', '    default_runtime_name = "runc"', '  [plugins."io.containerd.grpc.v1.cri".cni]', '    bin_dir = "/opt/cni/bin"', '    conf_dir = "/etc/cni/net.d"', ''].join('\n'),
  'configs/encryption-config.yaml': ['kind: EncryptionConfiguration', 'apiVersion: apiserver.config.k8s.io/v1', 'resources:', '  - resources:', '      - secrets', '    providers:', '      - aescbc:', '          keys:', '            - name: key1', '              secret: ${ENCRYPTION_KEY}', '      - identity: {}', ''].join('\n'),
  'configs/kube-apiserver-to-kubelet.yaml': ['apiVersion: rbac.authorization.k8s.io/v1', 'kind: ClusterRole', 'metadata:', '  name: system:kube-apiserver-to-kubelet', 'rules:', '  - apiGroups: [""]', '    resources: ["nodes/proxy", "nodes/stats", "nodes/log", "nodes/spec", "nodes/metrics"]', '    verbs: ["*"]', '---', 'apiVersion: rbac.authorization.k8s.io/v1', 'kind: ClusterRoleBinding', 'metadata:', '  name: system:kube-apiserver', 'roleRef:', '  kind: ClusterRole', '  name: system:kube-apiserver-to-kubelet', 'subjects:', '  - kind: User', '    name: kubernetes', ''].join('\n'),
  'configs/kube-proxy-config.yaml': ['kind: KubeProxyConfiguration', 'apiVersion: kubeproxy.config.k8s.io/v1alpha1', 'clientConnection:', '  kubeconfig: "/var/lib/kube-proxy/kubeconfig"', 'mode: "iptables"', 'clusterCIDR: "10.200.0.0/16"', ''].join('\n'),
  'configs/kube-scheduler.yaml': ['apiVersion: kubescheduler.config.k8s.io/v1', 'kind: KubeSchedulerConfiguration', 'clientConnection:', '  kubeconfig: "/var/lib/kubernetes/kube-scheduler.kubeconfig"', 'leaderElection:', '  leaderElect: true', ''].join('\n'),
  'configs/kubelet-config.yaml': ['kind: KubeletConfiguration', 'apiVersion: kubelet.config.k8s.io/v1beta1', 'address: "0.0.0.0"', 'authentication:', '  x509:', '    clientCAFile: "/var/lib/kubelet/ca.crt"', 'authorization:', '  mode: Webhook', 'clusterDomain: "cluster.local"', 'clusterDNS:', '  - "10.32.0.10"', 'podCIDR: "SUBNET"', 'resolvConf: "/etc/resolv.conf"', 'runtimeRequestTimeout: "15m"', 'tlsCertFile: "/var/lib/kubelet/kubelet.crt"', 'tlsPrivateKeyFile: "/var/lib/kubelet/kubelet.key"', ''].join('\n'),
  'units/containerd.service': unit('containerd container runtime', ['/bin/containerd'], ['ExecStartPre=/sbin/modprobe overlay', 'Delegate=yes', 'KillMode=process'], 'network.target'),
  'units/etcd.service': unit('etcd', ['/usr/local/bin/etcd', '--name controller', '--initial-advertise-peer-urls http://127.0.0.1:2380', '--listen-peer-urls http://127.0.0.1:2380', '--listen-client-urls http://127.0.0.1:2379', '--advertise-client-urls http://127.0.0.1:2379', '--data-dir=/var/lib/etcd']),
  'units/kube-apiserver.service': unit('Kubernetes API Server', ['/usr/local/bin/kube-apiserver', '--allow-privileged=true', '--authorization-mode=Node,RBAC', '--bind-address=0.0.0.0', '--client-ca-file=/var/lib/kubernetes/ca.crt', '--etcd-servers=http://127.0.0.1:2379', '--encryption-provider-config=/var/lib/kubernetes/encryption-config.yaml', '--kubelet-certificate-authority=/var/lib/kubernetes/ca.crt', '--kubelet-client-certificate=/var/lib/kubernetes/kube-api-server.crt', '--kubelet-client-key=/var/lib/kubernetes/kube-api-server.key', '--service-account-key-file=/var/lib/kubernetes/service-accounts.crt', '--service-account-signing-key-file=/var/lib/kubernetes/service-accounts.key', '--service-cluster-ip-range=10.32.0.0/24', '--tls-cert-file=/var/lib/kubernetes/kube-api-server.crt', '--tls-private-key-file=/var/lib/kubernetes/kube-api-server.key', '--v=2']),
  'units/kube-controller-manager.service': unit('Kubernetes Controller Manager', ['/usr/local/bin/kube-controller-manager', '--bind-address=0.0.0.0', '--cluster-cidr=10.200.0.0/16', '--cluster-signing-cert-file=/var/lib/kubernetes/ca.crt', '--cluster-signing-key-file=/var/lib/kubernetes/ca.key', '--kubeconfig=/var/lib/kubernetes/kube-controller-manager.kubeconfig', '--root-ca-file=/var/lib/kubernetes/ca.crt', '--service-account-private-key-file=/var/lib/kubernetes/service-accounts.key', '--service-cluster-ip-range=10.32.0.0/24', '--use-service-account-credentials=true', '--v=2']),
  'units/kube-scheduler.service': unit('Kubernetes Scheduler', ['/usr/local/bin/kube-scheduler', '--config=/etc/kubernetes/config/kube-scheduler.yaml', '--v=2']),
  'units/kubelet.service': unit('Kubernetes Kubelet', ['/usr/local/bin/kubelet', '--config=/var/lib/kubelet/kubelet-config.yaml', '--kubeconfig=/var/lib/kubelet/kubeconfig', '--container-runtime-endpoint=unix:///var/run/containerd/containerd.sock', '--v=2'], [], 'containerd.service'),
  'units/kube-proxy.service': unit('Kubernetes Kube Proxy', ['/usr/local/bin/kube-proxy', '--config=/var/lib/kube-proxy/kube-proxy-config.yaml']),
  'README.md': '# Kubernetes The Hard Way\n\nThis tutorial walks you through setting up Kubernetes the hard way.\n',
};

// ---- creating the lab ---------------------------------------------------------------------------------------------------------
const STANDARD_DIRS = ['/', '/root', '/etc', '/etc/systemd', '/etc/systemd/system', '/etc/sysctl.d', '/etc/modules-load.d', '/usr', '/usr/local', '/usr/local/bin', '/bin', '/var', '/var/lib', '/var/run', '/opt', '/tmp'];

function newMachine(name: string): Machine {
  const m: Machine = {
    name, fqdn: name === 'jumpbox' ? 'jumpbox' : name + '.kubernetes.local', ip: IPS[name], subnet: SUBNETS[name], hostname: name === 'jumpbox' ? 'jumpbox' : 'debian',
    files: {}, dirs: {}, units: {}, routes: [], swap: name.startsWith('node'), modules: [], packages: ['openssh-server', 'curl', 'coreutils'], hasKey: false,
  };
  for (const d of STANDARD_DIRS) m.dirs[d] = true;
  m.files['/etc/hosts'] = { text: '127.0.0.1\tlocalhost\n127.0.1.1\tdebian\n' };
  m.files['/etc/hostname'] = { text: 'debian\n' };
  if (name === 'jumpbox') { m.packages.push('git', 'wget', 'openssl', 'vim'); m.dirs['/root/.ssh'] = true; }
  return m;
}

export function newHardWay(): HardWay {
  const machines: Record<string, Machine> = {};
  for (const n of MACHINE_NAMES) machines[n] = newMachine(n);
  return {
    machines, active: 'jumpbox', stack: [], cwd: Object.fromEntries(MACHINE_NAMES.map(n => [n, '/root'])), vars: {},
    rbacApplied: false, keyGenerated: false, cloned: false,
  };
}

/** What `git clone` puts on the jumpbox. */
export function cloneRepo(m: Machine): void {
  for (const [path, text] of Object.entries(REPO)) writeFile(m, REPO_DIR + '/' + path, { text });
}

// ---- path helpers & file access -----------------------------------------------------------------------------------------------------
export function normalize(path: string, cwd: string): string {
  const raw = path.startsWith('~') ? '/root' + path.slice(1) : path;
  const parts = (raw.startsWith('/') ? raw : cwd + '/' + raw).split('/');
  const out: string[] = [];
  for (const p of parts) { if (!p || p === '.') continue; if (p === '..') out.pop(); else out.push(p); }
  return '/' + out.join('/');
}
export const dirname = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/';
export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export function mkdirs(m: Machine, path: string): void {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) { cur += '/' + part; m.dirs[cur] = true; }
  m.dirs['/'] = true;
}
export function writeFile(m: Machine, path: string, e: FileEntry): void {
  mkdirs(m, dirname(path));
  m.files[path] = e;
}
export const isDir = (m: Machine, path: string): boolean => !!m.dirs[path] || Object.keys(m.files).some(f => f.startsWith(path === '/' ? '/' : path + '/'));
/** Immediate children (files and sub-directories) of a directory. */
export function listDir(m: Machine, path: string): { name: string; dir: boolean }[] {
  const base = path === '/' ? '/' : path + '/';
  const out = new Map<string, boolean>();
  for (const f of Object.keys(m.files)) if (f.startsWith(base)) { const rest = f.slice(base.length); const i = rest.indexOf('/'); if (i < 0) out.set(rest, false); else out.set(rest.slice(0, i), true); }
  for (const d of Object.keys(m.dirs)) if (d.startsWith(base) && d.length > base.length) { const rest = d.slice(base.length); out.set(rest.split('/')[0], rest.includes('/') ? true : true); }
  return [...out.entries()].map(([name, dir]) => ({ name, dir })).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- kubeconfig text ----------------------------------------------------------------------------------------------------------------------
export function renderKubeconfig(meta: Extract<FileMeta, { kind: 'kubeconfig' }>): string {
  const L = ['apiVersion: v1', 'kind: Config', 'clusters:'];
  if (meta.cluster) L.push('- cluster:', '    certificate-authority-data: ' + (meta.cluster.ca ? 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUZ...' : '<none>'), '    server: ' + meta.cluster.server, '  name: ' + meta.cluster.name);
  L.push('contexts:');
  if (meta.context) L.push('- context:', '    cluster: ' + meta.context.cluster, '    user: ' + meta.context.user, '  name: ' + meta.context.name);
  L.push('current-context: ' + (meta.current ?? '""'), 'preferences: {}', 'users:');
  if (meta.user) {
    L.push('- name: ' + meta.user.name, '  user:');
    if (meta.user.embedded) L.push('    client-certificate-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...', '    client-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ...');
    else L.push('    client-certificate: ' + (meta.user.cert ?? '?'), '    client-key: ' + (meta.user.cert ?? '?').replace(/\.crt$/, '.key'));
  }
  return L.join('\n') + '\n';
}

/** Why a component cannot use this kubeconfig on this machine (null when it is fine). */
export function kubeconfigProblem(machine: Machine, path: string): string | null {
  const e = machine.files[path];
  const m = e?.meta;
  if (!e || m?.kind !== 'kubeconfig') return 'unable to load kubeconfig ' + path + ': no such file or directory';
  if (!m.cluster || !m.user || !m.context || !m.current) return 'invalid configuration: no configuration has been provided (kubeconfig is incomplete: ' + [!m.cluster && 'cluster', !m.user && 'credentials', !m.context && 'context', !m.current && 'current-context'].filter(Boolean).join(', ') + ' missing)';
  if (!m.cluster.ca) return 'x509: certificate signed by unknown authority (the kubeconfig has no certificate-authority-data)';
  if (!m.user.embedded && !(m.user.cert && machine.files[m.user.cert])) return 'unable to load client certificate: open ' + (m.user.cert ?? 'client.crt') + ': no such file or directory (the kubeconfig was made without --embed-certs and then moved to another machine)';
  return null;
}

// ---- systemd ----------------------------------------------------------------------------------------------------------------------------------
const need = (m: Machine, paths: string[]): string[] => paths.filter(p => !m.files[p]).map(p => 'open ' + p + ': no such file or directory');
const bin = (m: Machine, name: string, dir = '/usr/local/bin'): string[] => (m.files[dir + '/' + name] ? [] : ['Failed at step EXEC spawning ' + dir + '/' + name + ': No such file or directory (status=203/EXEC)']);

export const unitActive = (hw: HardWay, machine: string, name: string): boolean => !!hw.machines[machine]?.units[name]?.active;
export const apiserverUp = (hw: HardWay): boolean => unitActive(hw, 'server', 'kube-apiserver');

/** Everything that stops a unit from starting right now; an empty list means it runs. */
export function unitProblems(hw: HardWay, m: Machine, name: string): string[] {
  const kube = '/var/lib/kubernetes/';
  switch (name) {
    case 'etcd':
      return [...bin(m, 'etcd'), ...(m.dirs['/var/lib/etcd'] ? [] : ['etcd: data directory /var/lib/etcd does not exist (mkdir -p /var/lib/etcd)'])];
    case 'kube-apiserver': {
      const p = [...bin(m, 'kube-apiserver'), ...need(m, ['ca.crt', 'kube-api-server.crt', 'kube-api-server.key', 'service-accounts.crt', 'service-accounts.key', 'encryption-config.yaml'].map(f => kube + f))];
      const enc = m.files[kube + 'encryption-config.yaml']?.meta;
      if (enc?.kind === 'encryption' && !enc.keyOk) p.push('error: error while parsing encryption config: secret is not of the expected length (the key is empty: was ENCRYPTION_KEY exported before envsubst?)');
      if (!unitActive(hw, m.name, 'etcd')) p.push('Error: context deadline exceeded: dial tcp 127.0.0.1:2379: connect: connection refused (is etcd running?)');
      return p;
    }
    case 'kube-controller-manager': {
      const p = [...bin(m, 'kube-controller-manager'), ...need(m, ['ca.crt', 'ca.key', 'service-accounts.key'].map(f => kube + f))];
      const kc = kubeconfigProblem(m, kube + 'kube-controller-manager.kubeconfig');
      if (kc) p.push(kc);
      if (!apiserverUp(hw)) p.push('Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused (is kube-apiserver running?)');
      return p;
    }
    case 'kube-scheduler': {
      const p = [...bin(m, 'kube-scheduler'), ...need(m, ['/etc/kubernetes/config/kube-scheduler.yaml'])];
      const kc = kubeconfigProblem(m, kube + 'kube-scheduler.kubeconfig');
      if (kc) p.push(kc);
      if (!apiserverUp(hw)) p.push('Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused (is kube-apiserver running?)');
      return p;
    }
    case 'containerd':
      return [...bin(m, 'containerd', '/bin'), ...bin(m, 'containerd-shim-runc-v2', '/bin'), ...bin(m, 'runc'), ...need(m, ['/etc/containerd/config.toml'])];
    case 'kubelet': {
      const p = [...bin(m, 'kubelet')];
      if (m.swap) p.push('failed to run Kubelet: running with swap on is not supported, please disable swap (swapoff -a)');
      p.push(...need(m, ['/var/lib/kubelet/kubelet-config.yaml', '/var/lib/kubelet/ca.crt', '/var/lib/kubelet/kubelet.crt', '/var/lib/kubelet/kubelet.key']));
      const kc = m.files['/var/lib/kubelet/kubeconfig'];
      const prob = kubeconfigProblem(m, '/var/lib/kubelet/kubeconfig');
      if (prob) p.push(prob);
      else if (kc?.meta?.kind === 'kubeconfig' && kc.meta.user?.section !== m.hostname) p.push('Unable to register node "' + m.hostname + '": nodes "' + m.hostname + '" is forbidden: node "' + (kc.meta.user?.section ?? '?') + '" is not allowed to modify node "' + m.hostname + '"');
      const crt = m.files['/var/lib/kubelet/kubelet.crt']?.meta;
      if (crt?.kind === 'cert' && crt.section !== m.hostname) p.push('tls: certificate is for ' + crt.cn + ', but this machine is ' + m.hostname + ' (kubelet.crt must be the certificate generated for this node)');
      if (!unitActive(hw, m.name, 'containerd')) p.push('failed to run Kubelet: unable to connect to the container runtime: /var/run/containerd/containerd.sock (is containerd running?)');
      if (!apiserverUp(hw)) p.push('Unable to register node: Post "https://server.kubernetes.local:6443/api/v1/nodes": dial tcp: connection refused');
      return p;
    }
    case 'kube-proxy': {
      const p = [...bin(m, 'kube-proxy'), ...need(m, ['/var/lib/kube-proxy/kube-proxy-config.yaml'])];
      const kc = kubeconfigProblem(m, '/var/lib/kube-proxy/kubeconfig');
      if (kc) p.push(kc);
      if (!m.packages.includes('conntrack')) p.push('can\'t set sysctl net/netfilter/nf_conntrack_max: conntrack is not installed (apt-get install conntrack)');
      if (!apiserverUp(hw)) p.push('Unable to connect to the server: connection refused');
      return p;
    }
    default: return [];
  }
}

export const KNOWN_UNITS = ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler', 'containerd', 'kubelet', 'kube-proxy'];

/** After the pod network prerequisites are in place a node can run pods. */
export const networkReady = (m: Machine): boolean => m.modules.includes('br_netfilter') && /bridge-nf-call-iptables/.test(m.files['/etc/sysctl.d/kubernetes.conf']?.text ?? '') && !!m.files['/etc/cni/net.d/10-bridge.conf'] && !!m.files['/opt/cni/bin/bridge'];
