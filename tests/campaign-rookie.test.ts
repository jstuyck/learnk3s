// Full playthroughs of campaign 1: a sensible player wins, a careless one fails.
import { describe, expect, it } from 'vitest';
import { calcStars } from '../src/core/scoring';
import { cmd, cmdOk, finish, openTraffic, podNames, sim, start, until } from './helpers';

describe('Rookie campaign', () => {
  it('1. Hello, Pod - kubectl run path', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl run web --image=nginx');
    sim(s, 4);
    cmdOk(s, 'kubectl get pods', 'kubectl describe pod web', 'kubectl delete pod web');
    finish(s, 10);
    expect(s.outcome).toBe('win');
    expect(calcStars(s)).toBe(3);
  });

  it('1. Hello, Pod - jumping straight to a Deployment is accepted too', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl create deployment nginx --image=nginx');
    sim(s, 4);
    cmdOk(s, 'kubectl get pods', 'kubectl describe pod ' + podNames(s, 'nginx-')[0]);
    cmdOk(s, 'kubectl delete pod ' + podNames(s, 'nginx-')[0]);
    finish(s, 15);
    expect(s.outcome).toBe('win');
  });

  it('2. Deploy & Heal', () => {
    const s = start('deployments');
    cmdOk(s, 'kubectl create deployment web --image=nginx --replicas=3');
    sim(s, 5);
    cmdOk(s, 'kubectl delete pod ' + podNames(s, 'web-')[0]);
    sim(s, 6);
    cmdOk(s, 'kubectl scale deployment web --replicas=5');
    finish(s, 15);
    expect(s.outcome).toBe('win');
  });

  it('3. Open the Doors: expose, open traffic, win; forgetting the Service fails', () => {
    const good = start('services');
    cmdOk(good, 'kubectl expose deployment web --port=80');
    openTraffic(good);
    expect(finish(good).outcome).toBe('win');

    const bad = start('services');
    openTraffic(bad);
    expect(finish(bad).outcome).toBe('fail');
    expect(bad.failReason).toMatch(/Too many requests failed/);
  });

  it('4. Campaign Day: scaling ahead of the wave wins, ignoring it fails', () => {
    const good = start('scaling');
    openTraffic(good);
    sim(good, 14);
    cmdOk(good, 'kubectl scale deployment web --replicas=4');
    expect(finish(good).outcome).toBe('win');

    const bad = start('scaling');
    openTraffic(bad);
    expect(finish(bad).outcome).toBe('fail');
  });

  it('5. Autopilot: an HPA gets through both waves', () => {
    const s = start('hpa');
    cmdOk(s, 'kubectl autoscale deployment web --min=2 --max=6');
    openTraffic(s);
    expect(finish(s).outcome).toBe('win');
    expect(s.done.up && s.done.down).toBe(true);
  });

  it('5. Autopilot: without an autoscaler the waves overwhelm two pods', () => {
    const s = start('hpa');
    openTraffic(s);
    expect(finish(s).outcome).toBe('fail');
  });

  it('6. Ship It Safely: roll out v2, survive the bad v3 push by rolling back', () => {
    const s = start('rollout');
    openTraffic(s);
    sim(s, 3);
    cmdOk(s, 'kubectl set image deployment/web web=web:v2');
    until(s, 30);
    expect(s.flags.badRelease).toBe(true);
    expect(s.deployments[0].image).toBe('web:v3-broken');
    cmdOk(s, 'kubectl rollout undo deployment/web');
    expect(finish(s).outcome).toBe('win');
    expect(s.stats.failed).toBeLessThanOrEqual(2);
  });

  it('7. Missing Settings: logs -> configmap -> set env', () => {
    const s = start('config');
    sim(s, 1);
    cmdOk(s, 'kubectl logs ' + podNames(s, 'api-')[0]);
    cmdOk(s, 'kubectl create configmap api-config --from-literal=DB_URL=postgres://db.internal:5432/app');
    cmdOk(s, 'kubectl set env deployment/api --from=configmap/api-config');
    sim(s, 10);
    openTraffic(s);
    expect(finish(s).outcome).toBe('win');
  });

  it('7. Missing Settings: the wrong DB_URL does not complete the mission', () => {
    const s = start('config');
    cmdOk(s, 'kubectl logs ' + podNames(s, 'api-')[0]);
    cmdOk(s, 'kubectl create configmap api-config --from-literal=DB_URL=postgres://db:5432');
    cmdOk(s, 'kubectl set env deployment/api --from=configmap/api-config');
    sim(s, 30);
    expect(s.done.cm).toBeFalsy();
    expect(s.outcome).not.toBe('win');
  });

  it('8. Pull the Plug: 4 replicas + Service + autoscaler survive; 1 replica does not', () => {
    const good = start('resilience');
    cmdOk(good, 'kubectl create deployment shop --image=nginx --replicas=4', 'kubectl expose deployment shop --port=80');
    cmdOk(good, 'kubectl autoscale deployment shop --min=4 --max=6');
    sim(good, 5);
    openTraffic(good);
    expect(finish(good).outcome).toBe('win');

    const bad = start('resilience');
    cmdOk(bad, 'kubectl create deployment shop --image=nginx --replicas=1', 'kubectl expose deployment shop --port=80');
    sim(bad, 5);
    openTraffic(bad);
    expect(finish(bad).outcome).toBe('fail');
  });

  it('a mission does not report success until every objective is done', () => {
    const s = start('services');
    expect(s.outcome).toBeNull();
    sim(s, 30);
    expect(s.outcome).toBeNull();
    expect(cmd(s, 'kubectl get pods')).toMatch(/web-/);
  });
});
