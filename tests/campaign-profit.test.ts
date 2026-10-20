// Full playthroughs of Profit Mode. Besides "good wins / careless fails" these pin down the
// economy: the numbers in levels-operator.ts are calibrated so these strategies land where expected.
import { describe, expect, it } from 'vitest';
import { profit } from '../src/core/economy';
import { calcStars } from '../src/core/scoring';
import { level, cmd, cmdOk, finish, podNames, sim, start, until } from './helpers';

const secretFix = (s: ReturnType<typeof start>) => {
  cmd(s, 'kubectl logs ' + podNames(s, 'pay-')[0]);
  cmdOk(s, 'kubectl create secret generic pay-secret --from-literal=API_KEY=sk_live_9f2c41', 'kubectl set env deployment/pay --from=secret/pay-secret');
};

describe('Profit Mode', () => {
  it('1. Open for Business: right-sizing early earns the target, doing nothing loses money', () => {
    const idle = finish(start('m-cost'));
    expect(idle.outcome).toBe('fail');
    expect(profit(idle)).toBeLessThan(0);

    const s = start('m-cost');
    cmdOk(s, 'cloud cost');
    sim(s, 5);
    cmdOk(s, 'kubectl scale deployment shop --replicas=3');
    finish(s);
    expect(s.outcome).toBe('win');
    expect(profit(s)).toBeGreaterThanOrEqual(level('m-cost').econ!.target);
    expect(calcStars(s)).toBeGreaterThanOrEqual(2);
  });

  it('1. Open for Business: scaling below the 2-replica floor misses the objective even if profitable', () => {
    const s = start('m-cost');
    cmdOk(s, 'cloud cost', 'kubectl scale deployment shop --replicas=1');
    finish(s);
    expect(s.outcome).toBe('fail');
    expect(s.failReason).toMatch(/Right-size shop/);
  });

  it('2. Trim the Fat: drain + remove two nodes', () => {
    const idle = finish(start('m-trim'));
    expect(idle.outcome).toBe('fail');

    const s = start('m-trim');
    sim(s, 8);
    cmdOk(s, 'kubectl drain node-4', 'kubectl drain node-3');
    sim(s, 3);
    cmdOk(s, 'cloud remove-node node-4', 'cloud remove-node node-3');
    finish(s);
    expect(s.outcome).toBe('win');
    expect(s.nodes).toHaveLength(2);
  });

  it('3. Black Friday: autoscaler + extra node + give it back wins; autoscaler alone is not enough', () => {
    const lazy = start('m-peak');
    cmdOk(lazy, 'kubectl autoscale deployment shop --min=2 --max=6');
    finish(lazy);
    expect(lazy.outcome).toBe('fail');

    const s = start('m-peak');
    cmdOk(s, 'kubectl autoscale deployment shop --min=3 --max=6', 'cloud add-node');
    until(s, 92);
    cmdOk(s, 'kubectl autoscale deployment shop --min=2 --max=6');
    sim(s, 6);
    cmdOk(s, 'kubectl drain node-3');
    sim(s, 3);
    cmdOk(s, 'cloud remove-node node-3');
    finish(s);
    expect(s.outcome).toBe('win');
    expect(s.peak.nodes).toBeGreaterThanOrEqual(3);
  });

  it('3. Black Friday: with no spare node the extra pods stay Pending', () => {
    const s = start('m-peak');
    cmdOk(s, 'kubectl autoscale deployment shop --min=2 --max=6');
    until(s, 60);
    expect(s.pods.some(p => p.phase === 'Pending')).toBe(true);
    const pending = s.pods.find(p => p.phase === 'Pending')!;
    expect(cmd(s, 'kubectl describe pod ' + pending.name)).toMatch(/FailedScheduling/);
  });

  it('4. Pay Day: a quick Secret fix wins, a slow one goes bust or misses the target', () => {
    const fast = start('m-secret');
    sim(fast, 12);
    secretFix(fast);
    finish(fast);
    expect(fast.outcome).toBe('win');

    const never = finish(start('m-secret'));
    expect(never.outcome).toBe('fail');
    expect(never.failReason).toMatch(/Bankrupt/);
  });

  it('4. Pay Day: failures cost money while the pods are down', () => {
    const s = start('m-secret');
    sim(s, 10);
    expect(s.money.pen).toBeGreaterThan(0);
    expect(profit(s)).toBeLessThan(0);
  });

  it('5. Spot the Bargain: baseline misses the target, an all-spot spread wins', () => {
    const base = finish(start('m-spot'));
    expect(base.outcome).toBe('fail');
    expect(profit(base)).toBeGreaterThan(0);

    const s = start('m-spot');
    cmdOk(s, 'cloud add-node --spot', 'cloud add-node --spot', 'kubectl scale deployment shop --replicas=7');
    sim(s, 8);
    cmdOk(s, 'kubectl drain node-1');
    sim(s, 5);
    cmdOk(s, 'cloud remove-node node-1');
    sim(s, 1);
    cmdOk(s, 'cloud add-node --spot');
    sim(s, 6);
    cmdOk(s, 'kubectl drain node-2');
    sim(s, 5);
    cmdOk(s, 'cloud remove-node node-2');
    finish(s);
    expect(s.outcome).toBe('win');
    expect(s.nodes.every(n => n.spot)).toBe(true);
  });

  it('6. Quarter Close: autoscaler + spare nodes + rollback beat doing nothing', () => {
    const idle = finish(start('m-final'));
    expect(idle.outcome).toBe('fail');
    expect(profit(idle)).toBeLessThan(0);

    const s = start('m-final');
    cmdOk(s, 'kubectl autoscale deployment shop --min=5 --max=9', 'cloud add-node', 'cloud add-node');
    until(s, 61);
    expect(s.flags.badRelease).toBe(true);
    cmdOk(s, 'kubectl rollout undo deployment/shop');
    finish(s);
    expect(s.outcome).toBe('win');
  });

  it('6. Quarter Close: never rolling back the bad release fails the mission', () => {
    const s = start('m-final');
    cmdOk(s, 'kubectl autoscale deployment shop --min=5 --max=9', 'cloud add-node', 'cloud add-node');
    finish(s);
    expect(s.outcome).toBe('fail');
    expect(s.failReason).toMatch(/Roll back the broken release|below the/);
  });
});
