// The Hard Way shell, and mistakes that must fail the way they would on real machines.
import { describe, expect, it } from 'vitest';
import { completeLine } from '../src/core/completion';
import { HW_SOLUTIONS } from '../src/data/levels-hardway';
import { cmd, sim, start } from './helpers';

describe('the Hard Way shell', () => {
  const sh = () => start('h-jumpbox');

  it('handles variables, quoting, pipes, redirects, globs and braces', () => {
    const s = sh();
    cmd(s, 'X=hello');
    expect(cmd(s, "echo \"$X world\" '$X'")).toBe('hello world $X');
    expect(cmd(s, 'echo a b c | cut -d " " -f 2')).toBe('b');
    cmd(s, 'echo one > f.txt', 'echo two >> f.txt');
    expect(cmd(s, 'cat f.txt')).toBe('one\ntwo');
    expect(cmd(s, 'wc -l < f.txt')).toBe('2');
    expect(cmd(s, 'grep tw f.txt | wc -l')).toBe('1');
    cmd(s, 'mkdir -p d/{a,b}', 'touch d/a/x d/b/y');
    expect(cmd(s, 'ls d')).toBe('a  b');
    expect(cmd(s, 'echo d/*/*')).toBe('d/a/x d/b/y');
    expect(cmd(s, 'sed "s|two|2|" f.txt')).toBe('one\n2');
    expect(cmd(s, 'for i in 1 2 3; do echo n$i; done')).toBe('n1\nn2\nn3');
    expect(cmd(s, 'true && echo yes', 'nosuchcmd && echo no')).toMatch(/yes[\s\S]*command not found/);
    expect(cmd(s, 'cat missing')).toMatch(/No such file or directory/);
    expect(cmd(s, 'echo hello | base64')).toBe('aGVsbG8=');
  });

  it('ssh needs a key, a copied key and a resolvable name', () => {
    const s = start('h-compute');
    expect(cmd(s, 'ssh root@server hostname')).toMatch(/Could not resolve hostname server/);
    const t = start('h-jumpbox');
    cmd(t, 'cd kubernetes-the-hard-way');
    expect(cmd(t, 'ssh root@10.240.0.10 hostname')).toMatch(/Permission denied.*ssh-keygen/);
    cmd(t, 'ssh-keygen');
    expect(cmd(t, 'ssh root@10.240.0.10 hostname')).toMatch(/Permission denied.*ssh-copy-id/);
    cmd(t, 'ssh-copy-id root@10.240.0.10');
    expect(cmd(t, 'ssh root@10.240.0.10 hostname')).toBe('debian');
    expect(cmd(t, 'ssh root@10.240.0.10 "mkdir /tmp/q"', 'ls /tmp')).not.toContain('q');
  });

  it('interactive ssh moves the prompt to another machine and exit comes back', () => {
    const s = start('h-etcd');
    cmd(s, 'ssh root@server');
    expect(s.hw!.active).toBe('server');
    expect(cmd(s, 'hostname')).toBe('server');
    cmd(s, 'exit');
    expect(s.hw!.active).toBe('jumpbox');
  });

  it('a binary must be executable before it runs', () => {
    const s = sh();
    cmd(s, 'git clone --depth 1 https://github.com/kelseyhightower/kubernetes-the-hard-way.git', 'cd kubernetes-the-hard-way',
      'wget -q -P downloads -i downloads-amd64.txt', 'cp downloads/kubectl /usr/local/bin/');
    expect(cmd(s, 'kubectl version --client')).toMatch(/Permission denied/);
    cmd(s, 'chmod +x /usr/local/bin/kubectl');
    expect(cmd(s, 'kubectl version --client')).toMatch(/Client Version: v1\.32/);
    expect(cmd(s, 'tar -xvf downloads/nothing.tgz')).toMatch(/Cannot open/);
    expect(cmd(s, 'git clone https://example.com/x.git')).toMatch(/not found/);
  });
});

describe('Hard Way mistakes', () => {
  it('openssl: unknown section, a missing serial and missing SANs', () => {
    const s = start('h-certs');
    cmd(s, 'openssl genrsa -out ca.key 4096', 'openssl req -x509 -new -sha512 -noenc -key ca.key -days 3653 -config ca.conf -out ca.crt', 'openssl genrsa -out kube-api-server.key 4096');
    expect(cmd(s, 'openssl req -new -key kube-api-server.key -sha256 -config ca.conf -section nope -out x.csr')).toMatch(/can't find section/);
    cmd(s, 'openssl req -new -key kube-api-server.key -sha256 -config ca.conf -section kube-api-server -out kube-api-server.csr');
    expect(cmd(s, 'openssl x509 -req -days 3653 -in kube-api-server.csr -sha256 -CA ca.crt -CAkey ca.key -out kube-api-server.crt')).toMatch(/ca\.srl/);
    cmd(s, 'openssl x509 -req -days 3653 -in kube-api-server.csr -sha256 -CA ca.crt -CAkey ca.key -CAcreateserial -out kube-api-server.crt');
    expect(cmd(s, 'openssl x509 -in kube-api-server.crt -noout -text')).toMatch(/no Subject Alternative Name/);
    cmd(s, 'openssl x509 -req -days 3653 -in kube-api-server.csr -copy_extensions copyall -sha256 -CA ca.crt -CAkey ca.key -CAcreateserial -out kube-api-server.crt');
    expect(cmd(s, 'openssl x509 -in kube-api-server.crt -noout -text')).toMatch(/DNS:server\.kubernetes\.local[\s\S]*IP Address:10\.32\.0\.1/);
  });

  it('a unit file needs daemon-reload, and the API server needs etcd and its files', () => {
    const s = start('h-controlplane');
    cmd(s, 'scp downloads/controller/kube-apiserver units/kube-apiserver.service root@server:~/');
    cmd(s, 'ssh root@server "mv kube-apiserver /usr/local/bin/; mv kube-apiserver.service /etc/systemd/system/"');
    expect(cmd(s, 'ssh root@server systemctl start kube-apiserver')).toMatch(/not found.*daemon-reload/);
    cmd(s, 'ssh root@server systemctl daemon-reload');
    s.hw!.machines.server.units.etcd.active = false;
    expect(cmd(s, 'ssh root@server systemctl start kube-apiserver')).toMatch(/failed because the control process exited/);
    expect(cmd(s, 'ssh root@server journalctl -u kube-apiserver')).toMatch(/service-accounts\.crt: no such file[\s\S]*is etcd running/);
    expect(cmd(s, 'ssh root@server systemctl status kube-apiserver')).toMatch(/failed \(Result: exit-code\)/);
    expect(cmd(s, 'ssh root@server systemctl enable nothing')).toMatch(/does not exist/);
  });

  it('an empty ENCRYPTION_KEY produces a config the API server rejects', () => {
    const s = start('h-encryption');
    cmd(s, 'envsubst < configs/encryption-config.yaml > encryption-config.yaml');
    expect(s.hw!.machines.jumpbox.files['/root/kubernetes-the-hard-way/encryption-config.yaml'].meta).toEqual({ kind: 'encryption', keyOk: false });
    cmd(s, 'export ENCRYPTION_KEY=abc', 'envsubst < configs/encryption-config.yaml > encryption-config.yaml');
    sim(s, 1);
    expect(s.done.config).toBeUndefined();
    cmd(s, 'export ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)', 'envsubst < configs/encryption-config.yaml > encryption-config.yaml');
    sim(s, 1);
    expect(s.done.config).toBe(true);
  });

  it('a kubeconfig made without --embed-certs breaks on the other machine', () => {
    const s = start('h-kubeconfig');
    cmd(s, 'kubectl config set-cluster c --certificate-authority=ca.crt --server=https://127.0.0.1:6443 --kubeconfig=x.kubeconfig',
      'kubectl config set-credentials u --client-certificate=admin.crt --client-key=admin.key --kubeconfig=x.kubeconfig',
      'kubectl config set-context default --cluster=c --user=u --kubeconfig=x.kubeconfig', 'kubectl config use-context default --kubeconfig=x.kubeconfig');
    expect(cmd(s, 'kubectl config view --kubeconfig=x.kubeconfig')).toMatch(/client-certificate: \/root\/kubernetes-the-hard-way\/admin\.crt/);
    cmd(s, 'scp x.kubeconfig root@server:~/');
    expect(cmd(s, 'ssh root@server kubectl get nodes --kubeconfig x.kubeconfig')).toBeDefined();
    expect(cmd(s, 'kubectl config use-context nope --kubeconfig=none.kubeconfig')).toMatch(/no context exists/);
    expect(cmd(s, 'kubectl config set-cluster c --certificate-authority=missing.crt --kubeconfig=z')).toMatch(/could not read certificate-authority/);
  });

  it('wrong certificate, swap and a missing package each stop a worker service', () => {
    const s = start('h-workers');
    const n0 = s.hw!.machines['node-0'];
    for (const line of HW_SOLUTIONS[8].slice(0, 3)) cmd(s, line);
    // prepare node-0 as the last solution step does, but without swapoff and the packages
    const prep = HW_SOLUTIONS[8][3]
      .replace('apt-get -y install socat conntrack ipset kmod; swapoff -a; ', '')
      .replace('for HOST in node-0 node-1;', 'for HOST in node-0;')
      .replace('systemctl start containerd kubelet kube-proxy', 'systemctl start containerd');
    cmd(s, prep);
    expect(n0.units.containerd.active).toBe(true);
    expect(cmd(s, 'ssh root@node-0 systemctl start kubelet')).toMatch(/failed/);
    expect(cmd(s, 'ssh root@node-0 journalctl -u kubelet')).toMatch(/swap on is not supported/);
    cmd(s, 'ssh root@node-0 swapoff -a', 'scp node-1.crt root@node-0:/var/lib/kubelet/kubelet.crt');
    expect(cmd(s, 'ssh root@node-0 systemctl start kubelet')).toMatch(/failed/);
    expect(cmd(s, 'ssh root@node-0 journalctl -u kubelet')).toMatch(/certificate is for system:node:node-1, but this machine is node-0/);
    cmd(s, 'scp node-0.crt root@node-0:/var/lib/kubelet/kubelet.crt');
    expect(cmd(s, 'ssh root@node-0 systemctl start kubelet')).toBe('');
    expect(cmd(s, 'ssh root@node-0 systemctl start kube-proxy')).toMatch(/failed/);
    expect(cmd(s, 'ssh root@node-0 journalctl -u kube-proxy')).toMatch(/conntrack is not installed/);
    cmd(s, 'ssh root@node-0 apt-get -y install conntrack');
    expect(cmd(s, 'ssh root@node-0 systemctl start kube-proxy')).toBe('');
    expect(s.nodes.map(n => n.name)).toEqual(['node-0']);
    expect(cmd(s, 'ssh root@server kubectl get nodes --kubeconfig admin.kubeconfig')).toMatch(/node-0\s+Ready/);
  });

  it('logs/exec need the RBAC rule, port-forward needs socat, NodePort across nodes needs routes', () => {
    const s = start('h-smoke');
    s.hw!.rbacApplied = false;
    cmd(s, 'kubectl create deployment nginx --image=nginx:latest');
    sim(s, 6);
    const pod = s.pods[0].name;
    expect(cmd(s, `kubectl logs ${pod}`)).toMatch(/Forbidden.*kube-apiserver-to-kubelet/);
    expect(cmd(s, `kubectl exec ${pod} -- nginx -v`)).toMatch(/Forbidden/);
    s.hw!.rbacApplied = true;
    expect(cmd(s, `kubectl exec ${pod} -- nginx -v`)).toBe('nginx version: nginx/1.27.4');
    const node = s.hw!.machines[s.pods[0].node!];
    node.packages = node.packages.filter(p => p !== 'socat');
    expect(cmd(s, `kubectl port-forward ${pod} 8080:80`)).toMatch(/socat not found/);
    node.packages.push('socat');
    expect(cmd(s, `kubectl port-forward ${pod} 8080:80`)).toMatch(/Forwarding from 127\.0\.0\.1:8080/);
    cmd(s, 'kubectl expose deployment nginx --port 80 --type NodePort');
    expect(cmd(s, 'kubectl get svc nginx')).toMatch(/NodePort[\s\S]*80:3\d{4}\/TCP/);
    const port = cmd(s, 'kubectl get svc nginx -o jsonpath="{.spec.ports[0].nodePort}"');
    const other = s.pods[0].node === 'node-0' ? 'node-1' : 'node-0';
    expect(cmd(s, `curl -I http://${s.pods[0].node}:${port}`)).toMatch(/HTTP\/1\.1 200 OK/);
    expect(cmd(s, `curl -I http://${other}:${port}`)).toMatch(/200 OK/);
    s.hw!.machines[other].routes = [];
    expect(cmd(s, `curl -I http://${other}:${port}`)).toMatch(/no route to that pod network/);
    expect(cmd(s, 'curl -I http://nope:1')).toMatch(/Could not resolve host/);
  });

  it('kubectl on the jumpbox needs the CA, a resolvable name and an admin identity', () => {
    const s = start('h-remote');
    expect(cmd(s, 'curl https://server.kubernetes.local:6443/version')).toMatch(/SSL certificate problem/);
    expect(cmd(s, 'kubectl get nodes')).toMatch(/localhost:8080 was refused/);
    cmd(s, 'kubectl config set-cluster k --certificate-authority=ca.crt --embed-certs=true --server=https://server.kubernetes.local:6443',
      'kubectl config set-credentials proxy --client-certificate=kube-proxy.crt --client-key=kube-proxy.key',
      'kubectl config set-context ctx --cluster=k --user=proxy', 'kubectl config use-context ctx');
    expect(cmd(s, 'kubectl get nodes')).toMatch(/Forbidden.*system:kube-proxy/);
    s.hw!.machines.jumpbox.files['/etc/hosts'].text = '127.0.0.1 localhost\n';
    expect(cmd(s, 'kubectl get nodes')).toMatch(/no such host/);
    expect(cmd(s, 'curl https://server.kubernetes.local:6443/version')).toMatch(/Could not resolve host/);
    expect(cmd(s, 'kubectl')).toMatch(/kubectl controls/);
  });
});

describe('Hard Way tab completion', () => {
  const opts = (s: ReturnType<typeof start>, line: string) => completeLine(s, line).options;
  it('completes commands, paths, hosts, units and subcommands', () => {
    const s = start('h-etcd');
    expect(opts(s, 'ss')).toEqual(['ssh', 'ssh-keygen', 'ssh-copy-id']);
    expect(opts(s, 'ls downloads/')).toContain('downloads/client/');
    expect(opts(s, 'ls dow')).toEqual(['downloads/', 'downloads-amd64.txt', 'downloads-arm64.txt']);
    expect(opts(s, 'ls downloads/con').sort()).toEqual(['downloads/controller/', 'downloads/containerd-2.1.0-beta.0-linux-amd64.tar.gz'].sort());
    expect(opts(s, 'cat units/etc')).toEqual(['units/etcd.service']);
    expect(opts(s, 'ssh ro')).toEqual(['root@server', 'root@node-0', 'root@node-1']);
    expect(opts(s, 'scp ca.crt root@ser')).toEqual(['root@server:']);
    expect(opts(s, 'scp ca.crt root@server:/etc/syst')).toEqual(['root@server:/etc/systemd/']);
    expect(opts(s, 'systemctl st')).toEqual(['start', 'stop', 'status']);
    s.hw!.machines.server.files['/etc/systemd/system/etcd.service'] = { text: '' };
    s.hw!.active = 'server';
    expect(opts(s, 'systemctl start et')).toEqual(['etcd']);
    s.hw!.active = 'jumpbox';
    expect(opts(s, 'openssl x')).toEqual(['x509']);
    expect(opts(s, 'kubectl get po')).toEqual(['pods', 'po']);
  });
});
