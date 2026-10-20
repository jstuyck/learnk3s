import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/core/cli';
import { cmd, cmdOk, podNames, sim, start } from './helpers';

describe('parseArgs', () => {
  it('splits positionals from --flag=value and --flag value', () => {
    const r = parseArgs(['deployment', 'web', '--replicas=3', '--image', 'nginx']);
    expect(r.pos).toEqual(['deployment', 'web']);
    expect(r.flags).toEqual({ replicas: '3', image: 'nginx' });
  });
  it('keeps everything after the first = in a value', () => {
    expect(parseArgs(['--labels=app=web']).flags.labels).toBe('app=web');
  });
  it('collects repeated flags and skips -o/-n values', () => {
    const r = parseArgs(['x', '--from-literal=A=1', '--from-literal=B=2', '-o', 'wide']);
    expect(r.all['from-literal']).toEqual(['A=1', 'B=2']);
    expect(r.pos).toEqual(['x']);
  });
});

describe('kubectl basics', () => {
  it('rejects non-kubectl commands and unknown verbs', () => {
    const s = start('pods');
    expect(cmd(s, 'ls')).toMatch(/command not found/);
    expect(cmd(s, 'kubectl frobnicate')).toMatch(/unknown command/);
    expect(s.cmdErrors).toBe(2);
  });

  it('accepts the k alias and prints help', () => {
    const s = start('pods');
    expect(cmd(s, 'help')).toMatch(/kubectl/);
    cmdOk(s, 'k run web --image=nginx');
    expect(podNames(s)).toEqual(['web']);
  });

  it('run creates a bare pod that becomes Running and is scheduled on a node', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl run web --image=nginx');
    sim(s, 4);
    const p = s.pods[0];
    expect(p.phase).toBe('Running');
    expect(p.node).toMatch(/^node-/);
    expect(p.owner).toBeNull();
  });

  it('run validates its arguments and duplicates', () => {
    const s = start('pods');
    expect(cmd(s, 'kubectl run')).toMatch(/NAME is required/);
    expect(cmd(s, 'kubectl run web')).toMatch(/--image/);
    cmdOk(s, 'kubectl run web --image=nginx');
    expect(cmd(s, 'kubectl run web --image=nginx')).toMatch(/AlreadyExists/);
  });

  it('an unknown image ends in ImagePullBackOff and describe explains it', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl run oops --image=nginxx');
    sim(s, 4);
    expect(s.pods[0].phase).toBe('ImagePullBackOff');
    expect(cmd(s, 'kubectl describe pod oops')).toMatch(/Failed to pull image "nginxx"/);
  });

  it('get lists pods, nodes, and says so when empty', () => {
    const s = start('pods');
    expect(cmd(s, 'kubectl get pods')).toMatch(/No resources found/);
    expect(cmd(s, 'kubectl get nodes')).toMatch(/NAME\s+STATUS\s+ROLES\s+AGE\s+VERSION\s+node-1\s+Ready/);
    expect(cmd(s, 'kubectl get banana')).toMatch(/resource type/);
  });

  it('create deployment validates replicas and rejects duplicates', () => {
    const s = start('deployments');
    expect(cmd(s, 'kubectl create deployment web --image=nginx --replicas=99')).toMatch(/--replicas must be/);
    cmdOk(s, 'kubectl create deployment web --image=nginx --replicas=2');
    expect(cmd(s, 'kubectl create deployment web --image=nginx')).toMatch(/AlreadyExists/);
    expect(s.deployments[0].replicas).toBe(2);
  });
});

describe('scale, expose, autoscale', () => {
  it('scale changes replicas and complains for missing deployments', () => {
    const s = start('deployments');
    cmdOk(s, 'kubectl create deployment web --image=nginx');
    cmdOk(s, 'kubectl scale deployment web --replicas=4');
    expect(s.deployments[0].replicas).toBe(4);
    expect(cmd(s, 'kubectl scale deployment nope --replicas=2')).toMatch(/NotFound/);
    expect(cmd(s, 'kubectl scale deployment web')).toMatch(/--replicas/);
  });

  it('accepts both "deployment web" and "deployment/web" forms', () => {
    const s = start('deployments');
    cmdOk(s, 'kubectl create deployment web --image=nginx');
    cmdOk(s, 'kubectl scale deployment/web --replicas=3');
    expect(s.deployments[0].replicas).toBe(3);
  });

  it('expose creates a Service selecting the deployment label', () => {
    const s = start('services');
    cmdOk(s, 'kubectl expose deployment web --port=80');
    expect(s.services[0]).toMatchObject({ name: 'web', selector: { app: 'web' }, port: 80, targetPort: 80 });
    expect(cmd(s, 'kubectl expose deployment web --port=80')).toMatch(/AlreadyExists/);
  });

  it('autoscale validates min/max and replaces an existing HPA', () => {
    const s = start('hpa');
    expect(cmd(s, 'kubectl autoscale deployment web --min=5 --max=2')).toMatch(/cannot be greater/);
    expect(cmd(s, 'kubectl autoscale deployment web --min=2')).toMatch(/--max/);
    cmdOk(s, 'kubectl autoscale deployment web --min=2 --max=6');
    cmdOk(s, 'kubectl autoscale deployment web --min=3 --max=5 --cpu-percent=60');
    expect(s.hpas).toHaveLength(1);
    expect(s.hpas[0]).toMatchObject({ min: 3, max: 5, cpu: 60 });
  });
});

describe('config, secrets and rollouts', () => {
  it('configmaps and secrets store literals; describe secret hides values', () => {
    const s = start('config');
    cmdOk(s, 'kubectl create configmap c --from-literal=A=1 --from-literal=B=2');
    cmdOk(s, 'kubectl create secret generic k --from-literal=TOKEN=hunter2');
    expect(s.configmaps[0].data).toEqual({ A: '1', B: '2' });
    const out = cmd(s, 'kubectl describe secret k');
    expect(out).toMatch(/TOKEN/);
    expect(out).not.toMatch(/hunter2/);
    expect(cmd(s, 'kubectl create configmap c2')).toMatch(/--from-literal/);
    expect(cmd(s, 'kubectl create secret generic')).toMatch(/usage/);
  });

  it('set env refuses missing configmaps / secrets', () => {
    const s = start('config');
    expect(cmd(s, 'kubectl set env deployment/api --from=configmap/none')).toMatch(/NotFound/);
    expect(cmd(s, 'kubectl set env deployment/api --from=secret/none')).toMatch(/NotFound/);
    expect(cmd(s, 'kubectl set env deployment/api')).toMatch(/usage/);
  });

  it('set image / rollout history / undo keep a revision stack', () => {
    const s = start('rollout');
    cmdOk(s, 'kubectl set image deployment/web web=web:v2');
    expect(cmd(s, 'kubectl set image deployment/web web=web:v2')).toMatch(/unchanged/);
    expect(cmd(s, 'kubectl rollout history deployment/web')).toMatch(/web:v2\s+<none>\s+\(current\)/);
    cmdOk(s, 'kubectl rollout undo deployment/web');
    expect(s.deployments[0].image).toBe('web:v1');
    expect(cmd(s, 'kubectl rollout undo deployment/web')).toMatch(/no rollout history/);
  });
});

describe('delete, describe, logs', () => {
  it('deleting a bare pod removes it for good; flags are recorded', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl run web --image=nginx');
    sim(s, 3);
    cmdOk(s, 'kubectl delete pod web');
    sim(s, 5);
    expect(s.pods).toHaveLength(0);
    expect(s.flags.deletedBare).toBe(true);
    expect(cmd(s, 'kubectl delete pod web')).toMatch(/NotFound/);
  });

  it('deleting a deployment removes its pods and its autoscaler', () => {
    const s = start('hpa');
    cmdOk(s, 'kubectl autoscale deployment web --min=2 --max=4');
    cmdOk(s, 'kubectl delete deployment web');
    sim(s, 5);
    expect(s.deployments).toHaveLength(0);
    expect(s.hpas).toHaveLength(0);
    expect(s.pods).toHaveLength(0);
  });

  it('logs show app output for crashing pods and mark the investigation flag', () => {
    const s = start('config');
    const pod = podNames(s, 'api-')[0];
    expect(cmd(s, 'kubectl logs ' + pod)).toMatch(/DB_URL is not set/);
    expect(s.flags.inspectedCrash).toBe(true);
  });

  it('describe service warns when no pod is ready', () => {
    const s = start('services');
    cmdOk(s, 'kubectl expose deployment web --port=80');
    cmdOk(s, 'kubectl scale deployment web --replicas=0');
    sim(s, 5);
    expect(cmd(s, 'kubectl describe service web')).toMatch(/no Ready pods/);
  });
});

describe('cloud console, drain, cost', () => {
  it('cost is disabled in missions without an economy', () => {
    expect(cmd(start('pods'), 'cloud cost')).toMatch(/not enabled/);
  });

  it('cost prints the bill and records the flag', () => {
    const s = start('m-cost');
    const out = cmd(s, 'cloud cost');
    expect(out).toMatch(/burn rate/);
    expect(out).toMatch(/Revenue/);
    expect(s.flags.usedCost).toBe(true);
  });

  it('cloud remove-node refuses a node that still runs pods', () => {
    const s = start('m-trim');
    expect(cmd(s, 'cloud remove-node node-1')).toMatch(/Drain it first/);
    expect(s.nodes).toHaveLength(4);
  });

  it('drain evicts pods, then the node can be removed', () => {
    const s = start('m-trim');
    cmdOk(s, 'kubectl drain node-4');
    sim(s, 6);
    cmdOk(s, 'cloud remove-node node-4');
    expect(s.nodes.map(n => n.name)).not.toContain('node-4');
    expect(s.flags.drained).toBe(true);
  });

  it('cordoned nodes receive no new pods; uncordon restores them', () => {
    const s = start('m-trim');
    cmdOk(s, 'kubectl cordon node-1', 'kubectl cordon node-2', 'kubectl cordon node-3', 'kubectl cordon node-4');
    cmdOk(s, 'kubectl scale deployment shop --replicas=6');
    sim(s, 3);
    expect(s.pods.some(p => p.phase === 'Pending')).toBe(true);
    cmdOk(s, 'kubectl uncordon node-1');
    sim(s, 5);
    expect(s.pods.filter(p => p.phase === 'Pending')).toHaveLength(0);
  });

  it('add-node boots in about 5s and respects the quota', () => {
    const s = start('m-peak');
    cmdOk(s, 'cloud add-node');
    expect(s.nodes[2].bootUntil).toBeGreaterThan(s.t);
    cmdOk(s, 'cloud add-node');
    expect(cmd(s, 'cloud add-node')).toMatch(/QuotaExceeded/);
  });

  it('spot nodes only exist in missions that price them', () => {
    expect(cmd(start('m-peak'), 'cloud add-node --spot')).toMatch(/not available/);
    expect(cmd(start('m-spot'), 'cloud add-node --spot')).toMatch(/spot\), ready in/);
  });
});
