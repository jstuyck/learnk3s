// Workloads in namespaces: same names in different namespaces, context namespace, quotas, DNS and cascading delete.
import { describe, expect, it } from 'vitest';
import { cmd, cmdOk, sim, start } from './helpers';

describe('workloads in namespaces', () => {
  it('runs a Deployment named web in two namespaces independently', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl create namespace dev', 'kubectl create namespace prod');
    cmdOk(s, 'kubectl create deployment web --image=nginx --replicas=1 -n dev', 'kubectl create deployment web --image=nginx --replicas=3 --namespace prod');
    sim(s, 6);
    expect(cmd(s, 'kubectl get pods -n dev').match(/web-/g)).toHaveLength(1);
    expect(cmd(s, 'kubectl get pods -n prod').match(/web-/g)).toHaveLength(3);
    expect(cmd(s, 'kubectl get pods')).toMatch(/No resources found/);
    expect(cmd(s, 'kubectl get deploy -A')).toMatch(/dev\s+web\s+1\/1[\s\S]*prod\s+web\s+3\/3/);
    expect(cmd(s, 'kubectl create deployment web --image=nginx -n dev')).toMatch(/AlreadyExists/);
    cmdOk(s, 'kubectl scale deployment web --replicas=2 -n dev');
    sim(s, 5);
    expect(cmd(s, 'kubectl get pods -n dev').match(/web-/g)).toHaveLength(2);
    expect(cmd(s, 'kubectl get pods -n prod').match(/web-/g)).toHaveLength(3);
    const pod = /(web-\S+)/.exec(cmd(s, 'kubectl get pods -n prod'))![1];
    expect(cmd(s, `kubectl describe pod ${pod} -n prod`)).toMatch(/Namespace:\s+prod[\s\S]*Controlled By:\s+Deployment\/web/);
    expect(cmd(s, `kubectl describe pod ${pod} -n dev`)).toMatch(/NotFound/);
    expect(cmd(s, `kubectl get pods -A -o wide`)).toMatch(/NAMESPACE\s+NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE\s+IP\s+NODE/);
    cmdOk(s, 'kubectl delete deployment web -n dev');
    sim(s, 4);
    expect(cmd(s, 'kubectl get pods -n dev')).toMatch(/No resources found/);
    expect(cmd(s, 'kubectl get pods -n prod').match(/web-/g)).toHaveLength(3);
    expect(s.flags.deletedDeployment).toBe('dev/web');
    expect(cmd(s, 'kubectl get pods -o name -n prod').split('\n')).toHaveLength(3);
  });

  it('the namespace of the context applies when there is no -n', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl create namespace dev', 'kubectl run x --image=nginx -n dev');
    expect(cmd(s, 'kubectl get pods')).toMatch(/No resources found/);
    cmdOk(s, 'kubectl config set-context --current --namespace=dev');
    sim(s, 3);
    expect(cmd(s, 'kubectl get pods')).toMatch(/^NAME\s+READY[\s\S]*\nx\s/);
    expect(cmd(s, 'kubectl config get-contexts')).toMatch(/\*\s+learnk3s\s+learnk3s\s+learnk3s\s+dev/);
    expect(cmd(s, 'kubectl config view --minify')).toContain('namespace: dev');
    expect(cmd(s, 'kubectl get pods -n default')).toMatch(/No resources found/);
    cmdOk(s, 'kubectl config set-context --current --namespace=default');
    expect(cmd(s, 'kubectl get pods')).toMatch(/No resources found/);
    expect(cmd(s, 'kubectl config set-context --current --namespace=nope')).toMatch(/does not exist/);
    expect(cmd(s, 'kubectl get pods')).toMatch(/namespaces "nope" not found.*set-context/);
  });

  it('a ResourceQuota limits the pods of a namespace', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl create namespace team-a', 'kubectl create quota team-quota --hard=pods=2 -n team-a');
    expect(cmd(s, 'kubectl create quota q2 --hard=cpu=2 -n team-a')).toMatch(/--hard=pods=N/);
    cmdOk(s, 'kubectl create deployment worker --image=nginx --replicas=4 -n team-a');
    sim(s, 6);
    expect(cmd(s, 'kubectl get pods -n team-a').match(/worker-/g)).toHaveLength(2);
    expect(cmd(s, 'kubectl describe deployment worker -n team-a')).toMatch(/FailedCreate.*exceeded quota: team-quota.*limited: pods=2/);
    expect(cmd(s, 'kubectl get quota -n team-a')).toMatch(/team-quota\s+\S+\s+pods: 2\/2/);
    expect(cmd(s, 'kubectl describe quota team-quota -n team-a')).toMatch(/pods\s+2\s+2/);
    cmdOk(s, 'kubectl delete quota team-quota -n team-a', 'kubectl create quota team-quota --hard=pods=6 -n team-a');
    sim(s, 6);
    expect(cmd(s, 'kubectl get pods -n team-a').match(/worker-/g)).toHaveLength(4);
    expect(cmd(s, 'kubectl describe deployment worker -n team-a')).not.toMatch(/FailedCreate/);
  });

  it('Services select pods of their own namespace only, and DNS names carry the namespace', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl create namespace frontend', 'kubectl create namespace backend');
    cmdOk(s, 'kubectl create deployment api --image=nginx -n backend', 'kubectl expose deployment api --port=80 -n backend', 'kubectl run toolbox --image=toolbox -n frontend');
    cmdOk(s, 'kubectl create deployment api --image=nginx -n frontend');   // same label app=api, different namespace
    sim(s, 6);
    expect(cmd(s, 'kubectl get endpoints -n backend')).toMatch(/api\s+10\.244/);
    const bare = cmd(s, 'kubectl exec toolbox -n frontend -- wget -qO- http://api');
    expect(bare).toMatch(/bad address 'api'/);
    expect(bare).toMatch(/try api\.backend/);
    expect(s.flags.triedBareName).toBe(true);
    expect(cmd(s, 'kubectl exec toolbox -n frontend -- wget -qO- http://api.backend')).toMatch(/Welcome to api/);
    expect(cmd(s, 'kubectl exec toolbox -n frontend -- wget -qO- http://api.backend.svc.cluster.local')).toMatch(/Welcome/);
    expect(s.flags.crossNsCall).toBe(true);
    expect(cmd(s, 'kubectl exec toolbox -n frontend -- nslookup api.backend')).toMatch(/api\.backend\.svc\.cluster\.local/);
  });

  it('deleting a namespace deletes everything in it', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl create namespace tmp', 'kubectl create namespace keep');
    cmdOk(s, 'kubectl create deployment a --image=nginx --replicas=2 -n tmp', 'kubectl expose deployment a --port=80 -n tmp', 'kubectl create quota q --hard=pods=9 -n tmp', 'kubectl create deployment b --image=nginx -n keep');
    sim(s, 6);
    const out = cmd(s, 'kubectl delete namespace tmp');
    expect(out).toMatch(/namespace "tmp" deleted/);
    expect(out).toMatch(/everything inside it went with it: 4 objects/);
    sim(s, 4);
    expect(cmd(s, 'kubectl get all -n tmp')).toMatch(/namespaces "tmp" not found/);
    expect(s.pods.filter(p => p.ns === 'tmp')).toHaveLength(0);
    expect(cmd(s, 'kubectl get pods -n keep').match(/b-/g)).toHaveLength(1);
  });

  it('limits what can live outside default, and protects kube-system', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl create namespace dev');
    expect(cmd(s, 'kubectl create job j --image=busybox -n dev')).toMatch(/live in the default namespace/);
    expect(cmd(s, 'kubectl autoscale deployment web --max=3 -n dev')).toMatch(/default namespace/);
    expect(cmd(s, 'kubectl run x --image=nginx -n kube-system')).toMatch(/belongs to the cluster/);
    expect(cmd(s, 'kubectl delete pod nope -n kube-system')).toMatch(/belongs to the cluster/);
  });
});

describe('control plane pulse', () => {
  it('does not blink while a quota keeps refusing pods', () => {
    const s = start('n-quota');
    sim(s, 6);
    s.cpPulse = 0;
    sim(s, 3);
    expect(s.cpPulse).toBe(0);
  });
});
