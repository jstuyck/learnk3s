// Full playthroughs of the Namespaces campaign.
import { describe, expect, it } from 'vitest';
import { cmd, cmdOk, finish, sim, start } from './helpers';

describe('Namespaces campaign', () => {
  it('1. Meet the Neighbours', () => {
    const s = start('n-tour');
    cmdOk(s, 'kubectl get namespaces', 'kubectl get pods', 'kubectl get pods -A', 'kubectl get pods -n kube-system -o wide', 'kubectl get svc -n kube-system');
    sim(s, 1);
    expect(s.outcome).toBeNull();                       // the picture still has to be opened
    const pod = /(coredns-\S+)/.exec(cmd(s, 'kubectl get pods -n kube-system'))![1];
    cmdOk(s, `kubectl describe pod ${pod} -n kube-system`);
    s.flags.openedNamespaceView = true;                 // set by the Namespaces button of the UI
    finish(s, 5);
    expect(s.outcome).toBe('win');
  });

  it('2. Dev and Prod', () => {
    const s = start('n-rooms');
    cmdOk(s, 'kubectl create namespace dev', 'kubectl create namespace prod');
    cmdOk(s, 'kubectl create deployment web --image=nginx --replicas=1 -n dev', 'kubectl create deployment web --image=nginx --replicas=3 -n prod');
    sim(s, 6);
    cmdOk(s, 'kubectl get deployments -A', 'kubectl scale deployment web --replicas=2 -n dev');
    sim(s, 6);
    cmdOk(s, 'kubectl delete deployment web -n dev');
    finish(s, 10);
    expect(s.outcome).toBe('win');
  });

  it('2. Dev and Prod: scaling without -n looks in default and fails', () => {
    const s = start('n-rooms');
    cmdOk(s, 'kubectl create namespace dev', 'kubectl create namespace prod', 'kubectl create deployment web --image=nginx -n dev');
    expect(cmd(s, 'kubectl scale deployment web --replicas=2')).toMatch(/NotFound/);
  });

  it('3. Across the Fence', () => {
    const s = start('n-dns');
    cmdOk(s, 'kubectl get svc -A');
    expect(cmd(s, 'kubectl exec toolbox -n frontend -- wget -qO- http://api')).toMatch(/try api\.backend/);
    cmdOk(s, 'kubectl exec toolbox -n frontend -- wget -qO- http://api.backend', 'kubectl exec toolbox -n frontend -- wget -qO- http://api.backend.svc.cluster.local');
    finish(s, 5);
    expect(s.outcome).toBe('win');
  });

  it('4. Fair Share: scale down inside the quota', () => {
    const s = start('n-quota');
    sim(s, 5);
    expect(s.pods.filter(p => p.ns === 'team-a')).toHaveLength(3);
    expect(s.outcome).toBeNull();
    cmdOk(s, 'kubectl get pods -n team-a', 'kubectl describe quota team-quota -n team-a', 'kubectl describe deployment worker -n team-a');
    cmdOk(s, 'kubectl scale deployment worker --replicas=3 -n team-a');
    finish(s, 10);
    expect(s.outcome).toBe('win');
  });

  it('4. Fair Share: or replace the quota', () => {
    const s = start('n-quota');
    sim(s, 5);
    cmdOk(s, 'kubectl describe quota team-quota -n team-a', 'kubectl describe deployment worker -n team-a');
    cmdOk(s, 'kubectl delete quota team-quota -n team-a', 'kubectl create quota team-quota --hard=pods=6 -n team-a');
    finish(s, 15);
    expect(s.outcome).toBe('win');
  });

  it('5. Which Room Am I In?: the careful way', () => {
    const s = start('n-context');
    expect(cmd(s, 'kubectl get deployments')).toMatch(/shop\s+2\/2/);          // this is prod
    cmdOk(s, 'kubectl config get-contexts', 'kubectl scale deployment shop --replicas=3 -n staging');
    sim(s, 6);
    cmdOk(s, 'kubectl config set-context --current --namespace=default');
    finish(s, 5);
    expect(s.outcome).toBe('win');
  });

  it('5. Which Room Am I In?: the careless way scales prod', () => {
    const s = start('n-context');
    cmdOk(s, 'kubectl config view --minify', 'kubectl scale deployment shop --replicas=3');
    sim(s, 6);
    cmdOk(s, 'kubectl config set-context --current --namespace=default');
    sim(s, 3);
    expect(s.done.staging).toBeUndefined();
    expect(s.outcome).toBeNull();
  });

  it('5. Which Room Am I In?: switching the context also works', () => {
    const s = start('n-context');
    cmdOk(s, 'kubectl config current-context', 'kubectl config set-context --current --namespace=staging', 'kubectl scale deployment shop --replicas=3');
    sim(s, 6);
    cmdOk(s, 'kubectl config set-context --current --namespace=default');
    finish(s, 5);
    expect(s.outcome).toBe('win');
  });

  it('6. Clean Slate', () => {
    const s = start('n-clean');
    expect(cmd(s, 'kubectl get all -n tmp')).toMatch(/deployment[\s\S]*a\s+2\/2/);
    expect(cmd(s, 'kubectl delete namespace kube-system')).toMatch(/may not be deleted/);
    expect(s.outcome).toBeNull();
    cmdOk(s, 'kubectl delete namespace tmp');
    finish(s, 10);
    expect(s.outcome).toBe('win');
  });
});
