import { describe, expect, it } from 'vitest';
import { newState, readyCount, step } from '../src/core/sim';
import { burnRate, profit } from '../src/core/economy';
import { makeRng } from '../src/core/rng';
import { level, cmd, cmdOk, openTraffic, podNames, sim, start } from './helpers';

describe('rng', () => {
  it('is deterministic per seed and spreads over [0,1)', () => {
    const a = makeRng(7), b = makeRng(7), c = makeRng(8);
    const xs = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(xs);
    expect(Array.from({ length: 5 }, c)).not.toEqual(xs);
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true);
  });
  it('makes whole simulations reproducible', () => {
    const run = () => {
      const s = start('scaling', 99);
      openTraffic(s);
      sim(s, 40);
      return [s.stats.served, s.stats.failed, s.pods.map(p => p.name).join()];
    };
    expect(run()).toEqual(run());
  });
});

describe('pod lifecycle and scheduler', () => {
  it('goes Pending -> ContainerCreating -> Running', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl run web --image=nginx');
    expect(s.pods[0].phase).toBe('Pending');
    sim(s, 0.5);
    expect(s.pods[0].phase).toBe('ContainerCreating');
    sim(s, 3);
    expect(s.pods[0].phase).toBe('Running');
  });

  it('spreads replicas of one Deployment across nodes', () => {
    const s = start('deployments');
    cmdOk(s, 'kubectl create deployment web --image=nginx --replicas=3');
    sim(s, 5);
    expect(new Set(s.pods.map(p => p.node)).size).toBe(3);
  });

  it('leaves pods Pending with a FailedScheduling event when no node has room', () => {
    const s = start('pods'); // 2 nodes x 4 slots
    cmdOk(s, 'kubectl create deployment big --image=nginx --replicas=9');
    sim(s, 5);
    const pending = s.pods.filter(p => p.phase === 'Pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].events.some(e => e.reason === 'FailedScheduling')).toBe(true);
    expect(pending[0].node).toBeNull();
  });
});

describe('Deployment controller', () => {
  it('replaces a deleted pod (self-healing)', () => {
    const s = start('deployments');
    cmdOk(s, 'kubectl create deployment web --image=nginx --replicas=3');
    sim(s, 5);
    cmdOk(s, 'kubectl delete pod ' + podNames(s, 'web-')[0]);
    sim(s, 6);
    expect(readyCount(s, 'web')).toBe(3);
    expect(s.flags.selfHealed).toBe(true);
  });

  it('scales down by removing surplus pods', () => {
    const s = start('deployments');
    cmdOk(s, 'kubectl create deployment web --image=nginx --replicas=5');
    sim(s, 5);
    cmdOk(s, 'kubectl scale deployment web --replicas=2');
    sim(s, 4);
    expect(podNames(s, 'web-')).toHaveLength(2);
  });

  it('rolls out a good image without ever dropping below the desired ready count', () => {
    const s = start('rollout');
    openTraffic(s);
    cmdOk(s, 'kubectl set image deployment/web web=web:v2');
    for (let i = 0; i < 13 * 20; i++) { // before the mission's scripted bad release (4s after completion)
      step(s, 0.05);
      expect(readyCount(s, 'web')).toBeGreaterThanOrEqual(4);
    }
    expect(s.pods.filter(p => p.owner === 'web').every(p => p.image === 'web:v2')).toBe(true);
    expect(cmd(s, 'kubectl rollout status deployment/web')).toMatch(/successfully rolled out/);
  });

  it('a broken image stalls the rollout and the old pods keep serving; undo recovers', () => {
    const s = start('rollout');
    openTraffic(s);
    cmdOk(s, 'kubectl set image deployment/web web=web:v2-broken');
    sim(s, 20);
    const pods = s.pods.filter(p => p.owner === 'web');
    expect(pods.filter(p => p.phase === 'Running' && p.image === 'web:v1')).toHaveLength(4);
    expect(pods.some(p => p.phase === 'CrashLoopBackOff')).toBe(true);
    expect(cmd(s, 'kubectl rollout status deployment/web')).toMatch(/Waiting for deployment "web" rollout to finish/);
    expect(s.stats.failed).toBe(0);
    cmdOk(s, 'kubectl rollout undo deployment/web');
    sim(s, 6);
    expect(s.pods.filter(p => p.owner === 'web' && p.phase === 'CrashLoopBackOff')).toHaveLength(0);
    expect(readyCount(s, 'web')).toBe(4);
  });

  it('crashing images enter CrashLoopBackOff and count restarts', () => {
    const s = start('rollout');
    cmdOk(s, 'kubectl set image deployment/web web=web:v2-broken');
    sim(s, 20);
    const crashed = s.pods.find(p => p.phase === 'CrashLoopBackOff')!;
    expect(crashed.restarts).toBeGreaterThan(0);
    expect(crashed.logs[0]).toMatch(/panic/);
  });

  it('config and secrets are only honoured when they carry the right value from the right source', () => {
    const s = start('config');
    sim(s, 1);
    expect(readyCount(s, 'api')).toBe(0);
    cmdOk(s, 'kubectl create configmap bad --from-literal=DB_URL=postgres://wrong');
    cmdOk(s, 'kubectl set env deployment/api --from=configmap/bad');
    sim(s, 8);
    expect(readyCount(s, 'api')).toBe(0);
    expect(cmd(s, 'kubectl logs ' + podNames(s, 'api-')[0])).toMatch(/connection refused/);
    cmdOk(s, 'kubectl create configmap good --from-literal=DB_URL=postgres://db.internal:5432/app');
    cmdOk(s, 'kubectl set env deployment/api --from=configmap/good');
    sim(s, 8);
    expect(readyCount(s, 'api')).toBe(2);
  });

  it('a credential supplied through a ConfigMap is rejected; a Secret works', () => {
    const s = start('m-secret');
    cmdOk(s, 'kubectl create configmap leak --from-literal=API_KEY=sk_live_9f2c41');
    cmdOk(s, 'kubectl set env deployment/pay --from=configmap/leak');
    sim(s, 8);
    expect(cmd(s, 'kubectl logs ' + podNames(s, 'pay-')[0])).toMatch(/only accepts credentials from a Secret/);
    cmdOk(s, 'kubectl create secret generic ok --from-literal=API_KEY=sk_live_9f2c41');
    cmdOk(s, 'kubectl set env deployment/pay --from=secret/ok');
    sim(s, 8);
    expect(readyCount(s, 'pay')).toBe(3);
  });
});

describe('Services and traffic', () => {
  it('without a Service every request is refused', () => {
    const s = start('services');
    openTraffic(s);
    sim(s, 5);
    expect(s.stats.served).toBe(0);
    expect(s.stats.failed).toBeGreaterThan(3);
  });

  it('with a Service and ready pods requests succeed', () => {
    const s = start('services');
    cmdOk(s, 'kubectl expose deployment web --port=80');
    openTraffic(s);
    sim(s, 10);
    expect(s.stats.served).toBeGreaterThan(8);
    expect(s.stats.failed).toBe(0);
  });

  it('a lone pod saturates and sheds load (503) under a spike', () => {
    const s = start('scaling');
    openTraffic(s);
    sim(s, 35);
    expect(s.stats.failed).toBeGreaterThan(10);
  });

  it('losing a node marks pods Unknown, evicts them, and the Deployment reschedules', () => {
    const s = start('resilience');
    cmdOk(s, 'kubectl create deployment shop --image=nginx --replicas=3', 'kubectl expose deployment shop --port=80');
    sim(s, 5);
    openTraffic(s);
    sim(s, 21); // node-2 dies at tt=20
    expect(s.nodes[1].down).toBe(true);
    expect(s.pods.some(p => p.phase === 'Unknown' || p.node === 'node-2')).toBe(true);
    sim(s, 8);
    expect(readyCount(s, 'shop')).toBe(3);
    expect(s.pods.filter(p => p.owner === 'shop' && p.node === 'node-2' && p.phase === 'Running')).toHaveLength(0);
  });

  it('bare pods lost with their node are gone for good', () => {
    const s = start('resilience');
    cmdOk(s, 'kubectl run lone --image=nginx');
    sim(s, 4);
    const node = s.pods[0].node!;
    s.nodes.find(n => n.name === node)!.down = true;
    s.pods[0].phase = 'Unknown';
    sim(s, 6);
    expect(s.pods).toHaveLength(0);
  });
});

describe('Horizontal Pod Autoscaler', () => {
  it('scales out under load and back in afterwards', () => {
    const s = start('hpa');
    cmdOk(s, 'kubectl autoscale deployment web --min=2 --max=6');
    openTraffic(s);
    sim(s, 30);
    expect(s.peak.web).toBeGreaterThanOrEqual(4);
    sim(s, 17); // tt=47: wave 1 is over (32s), wave 2 starts at 48s
    expect(s.deployments[0].replicas).toBeLessThan(s.peak.web); // scale-in is gradual
  });

  it('never leaves the min/max bounds', () => {
    const s = start('hpa');
    cmdOk(s, 'kubectl autoscale deployment web --min=3 --max=4');
    sim(s, 3);
    expect(s.deployments[0].replicas).toBe(3);
    openTraffic(s);
    sim(s, 30);
    expect(s.peak.web).toBeLessThanOrEqual(4);
  });
});

describe('economy', () => {
  it('missions without an economy never charge', () => {
    const s = start('services');
    cmdOk(s, 'kubectl expose deployment web --port=80');
    openTraffic(s);
    sim(s, 10);
    expect(profit(s)).toBe(0);
    expect(burnRate(s).total).toBe(0);
  });

  it('burn rate is nodes plus scheduled pods, priced per type', () => {
    const s = start('m-spot');
    const E = level('m-spot').econ!;
    expect(burnRate(s).total).toBeCloseTo(2 * E.nodeCost + 4 * E.podCost, 6);
    cmdOk(s, 'cloud add-node --spot');
    expect(burnRate(s).total).toBeCloseTo(2 * E.nodeCost + E.spotCost + 4 * E.podCost, 6);
  });

  it('money accrues: revenue per served request, penalty per failure, cost per second', () => {
    const s = start('m-cost');
    sim(s, 30);
    const E = level('m-cost').econ!;
    expect(s.money.rev).toBeCloseTo(s.stats.served * E.price, 6);
    expect(s.money.pen).toBeCloseTo(s.stats.failed * E.penalty, 6);
    expect(s.money.cost).toBeGreaterThan(0);
    expect(profit(s)).toBeCloseTo(s.money.rev - s.money.cost - s.money.pen, 9);
  });

  it('starts live immediately in auto-traffic missions', () => {
    expect(start('m-cost').mode).toBe('live');
    expect(start('services').mode).toBe('prep');
  });

  it('a spot node reclaimed by the provider takes its pods down for a while', () => {
    const s = start('m-spot');
    cmdOk(s, 'cloud add-node --spot');
    sim(s, 6);
    cmdOk(s, 'kubectl scale deployment shop --replicas=8');
    sim(s, 24); // reclaim at tt=28
    sim(s, 6);
    const spot = s.nodes.find(n => n.spot)!;
    expect(spot.down).toBe(true);
    sim(s, 14); // tt=50: back after its 20s outage, before the next reclaim at 55
    expect(spot.down).toBe(false);
  });

  it('going bust or missing the target ends the mission as a failure', () => {
    const a = start('m-secret');
    sim(a, 200);
    expect(a.outcome).toBe('fail');
    expect(a.failReason).toMatch(/Bankrupt/);
    const b = start('m-cost');
    sim(b, 200);
    expect(b.outcome).toBe('fail');
    expect(b.failReason).toMatch(/below the \$/);
  });
});

describe('state creation', () => {
  it('seeded levels start with their objects already running', () => {
    const s = newState(level('scaling'), 1);
    expect(readyCount(s, 'web')).toBe(1);
    expect(s.services).toHaveLength(1);
    expect(s.msgs).toHaveLength(0);
    expect(s.t).toBe(0);
  });
});
