// Namespaces and the cluster's own pods.
import { describe, expect, it } from 'vitest';
import { cmd, cmdOk, sim, start } from './helpers';

describe('namespaces and system pods', () => {
  it('get namespaces lists the four system namespaces', () => {
    const s = start('pods');
    const out = cmd(s, 'kubectl get namespaces');
    expect(out).toMatch(/^NAME\s+STATUS\s+AGE/);
    for (const n of ['default', 'kube-node-lease', 'kube-public', 'kube-system']) expect(out).toContain(n);
    expect(cmd(s, 'kubectl get ns')).toBe(out);
  });

  it('plain get pods shows only default; -A and -n kube-system show the system pods', () => {
    const s = start('deployments');
    cmdOk(s, 'kubectl create deployment web --image=nginx');
    sim(s, 4);
    const mine = cmd(s, 'kubectl get pods');
    expect(mine).toContain('web-');
    expect(mine).not.toContain('coredns');
    const all = cmd(s, 'kubectl get pods -A');
    expect(all).toMatch(/^NAMESPACE\s+NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE/);
    expect(all).toMatch(/kube-system\s+coredns-/);
    expect(all).toMatch(/kube-system\s+kube-apiserver-node-1/);
    expect(all).toMatch(/default\s+web-/);
    const sys = cmd(s, 'kubectl get pods -n kube-system');
    expect(sys).toMatch(/^NAME\s+READY\s+STATUS/);
    expect(sys).toContain('etcd-node-1');
    expect(sys).not.toContain('web-');
    expect(cmd(s, 'kubectl get pods --all-namespaces')).toBe(all);
  });

  it('has one kube-proxy and one CNI pod per node, a kube-dns Service and DaemonSets', () => {
    const s = start('m-trim');
    const sys = cmd(s, 'kubectl get pods -n kube-system -o wide');
    expect(sys.match(/kube-proxy-/g)).toHaveLength(4);
    expect(sys.match(/kindnet-/g)).toHaveLength(4);
    expect(cmd(s, 'kubectl get svc -n kube-system')).toMatch(/kube-dns\s+ClusterIP\s+10\.96\.0\.10/);
    expect(cmd(s, 'kubectl get ds -n kube-system')).toMatch(/kube-proxy\s+4\s+4\s+4/);
    expect(cmd(s, 'kubectl get deploy -n kube-system')).toMatch(/coredns\s+2\/2/);
    expect(cmd(s, 'kubectl get all -n kube-system')).toMatch(/pods[\s\S]*services[\s\S]*daemonsets[\s\S]*deployments/);
  });

  it('describes and reads logs of a system pod', () => {
    const s = start('pods');
    const pod = /(coredns-\S+)/.exec(cmd(s, 'kubectl get pods -n kube-system'))![1];
    expect(cmd(s, `kubectl describe pod ${pod} -n kube-system`)).toMatch(/Namespace:\s+kube-system[\s\S]*Controlled By:\s+ReplicaSet\/coredns/);
    expect(cmd(s, `kubectl logs ${pod} -n kube-system`)).toContain('CoreDNS');
    expect(cmd(s, `kubectl describe pod ${pod}`)).toMatch(/NotFound/);
    expect(cmd(s, 'kubectl get pods -n nope')).toMatch(/namespaces "nope" not found/);
    expect(cmd(s, 'kubectl describe pod x -n nope')).toMatch(/namespaces "nope" not found/);
  });

  it('creates and deletes namespaces, but protects the system ones', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl create namespace dev');
    expect(cmd(s, 'kubectl get ns')).toContain('dev');
    expect(cmd(s, 'kubectl create namespace dev')).toMatch(/AlreadyExists/);
    expect(cmd(s, 'kubectl create ns Bad_Name')).toMatch(/invalid/);
    expect(cmd(s, 'kubectl get pods -n dev')).toBe('No resources found in dev namespace.');
    expect(cmd(s, 'kubectl run x --image=nginx -n dev')).toBe('pod/x created');
    expect(cmd(s, 'kubectl delete namespace kube-system')).toMatch(/may not be deleted/);
    cmdOk(s, 'kubectl delete namespace dev');
    expect(cmd(s, 'kubectl get ns')).not.toContain('dev');
    expect(cmd(s, 'kubectl describe ns kube-system')).toMatch(/Status:\s+Active/);
  });

  it('system pods on a failed node become Unknown', () => {
    const s = start('pods');
    s.nodes[1].down = true;
    expect(cmd(s, 'kubectl get pods -n kube-system')).toMatch(/kube-proxy-\S+\s+0\/1\s+Unknown/);
  });

  it('Hard Way clusters have no system pods (components are systemd services)', () => {
    const s = start('h-smoke');
    expect(cmd(s, 'kubectl get pods -A')).toMatch(/No resources found/);
  });
});
