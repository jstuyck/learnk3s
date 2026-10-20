// The game uses a random seed in the browser, so the "reasonable player" strategies must win
// reliably across many seeds, not just the one used in the other tests.
import { describe, expect, it } from 'vitest';
import type { State } from '../src/core/types';
import { cmd, cmdOk, finish, openTraffic, podNames, sim, start, until } from './helpers';

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

function winRate(id: string, play: (s: State) => void): number {
  let wins = 0;
  for (const seed of SEEDS) {
    const s = start(id, seed);
    play(s);
    finish(s);
    if (s.outcome === 'win') wins++;
  }
  return wins / SEEDS.length;
}

describe('win rate of a sensible strategy across 20 seeds', () => {
  it('Rookie 4: scale to 4 before the wave', () => {
    expect(winRate('scaling', s => { openTraffic(s); sim(s, 14); cmdOk(s, 'kubectl scale deployment web --replicas=4'); })).toBe(1);
  });

  it('Rookie 5: autoscale min 2 max 6', () => {
    expect(winRate('hpa', s => { cmdOk(s, 'kubectl autoscale deployment web --min=2 --max=6'); openTraffic(s); })).toBeGreaterThanOrEqual(0.95);
  });

  it('Rookie 8: 4 replicas + service + autoscaler', () => {
    expect(winRate('resilience', s => {
      cmdOk(s, 'kubectl create deployment shop --image=nginx --replicas=4', 'kubectl expose deployment shop --port=80', 'kubectl autoscale deployment shop --min=4 --max=6');
      sim(s, 5); openTraffic(s);
    })).toBeGreaterThanOrEqual(0.95);
  });

  it('Profit 1: scale to 3 within 8 seconds', () => {
    expect(winRate('m-cost', s => { cmd(s, 'cloud cost'); sim(s, 8); cmdOk(s, 'kubectl scale deployment shop --replicas=3'); })).toBeGreaterThanOrEqual(0.95);
  });

  it('Profit 2: trim two nodes within 15 seconds', () => {
    expect(winRate('m-trim', s => { sim(s, 15); cmdOk(s, 'kubectl drain node-4', 'kubectl drain node-3'); sim(s, 3); cmdOk(s, 'cloud remove-node node-4', 'cloud remove-node node-3'); })).toBeGreaterThanOrEqual(0.95);
  });

  it('Profit 3: autoscaler, extra node early, give it back after the rush', () => {
    expect(winRate('m-peak', s => {
      cmdOk(s, 'kubectl autoscale deployment shop --min=3 --max=6'); sim(s, 8); cmdOk(s, 'cloud add-node');
      until(s, 95); cmdOk(s, 'kubectl drain node-3'); sim(s, 3); cmdOk(s, 'cloud remove-node node-3');
    })).toBeGreaterThanOrEqual(0.9);
  });

  it('Profit 4: fix the secret within 25 seconds', () => {
    expect(winRate('m-secret', s => {
      sim(s, 20); cmd(s, 'kubectl logs ' + podNames(s, 'pay-')[0]);
      cmdOk(s, 'kubectl create secret generic pay-secret --from-literal=API_KEY=sk_live_9f2c41', 'kubectl set env deployment/pay --from=secret/pay-secret');
    })).toBeGreaterThanOrEqual(0.95);
  });

  it('Profit 5: three spot nodes, seven replicas, no on-demand', () => {
    expect(winRate('m-spot', s => {
      cmdOk(s, 'cloud add-node --spot', 'cloud add-node --spot', 'kubectl scale deployment shop --replicas=7'); sim(s, 8);
      cmdOk(s, 'kubectl drain node-1'); sim(s, 5); cmdOk(s, 'cloud remove-node node-1'); sim(s, 1);
      cmdOk(s, 'cloud add-node --spot'); sim(s, 6);
      cmdOk(s, 'kubectl drain node-2'); sim(s, 5); cmdOk(s, 'cloud remove-node node-2');
    })).toBeGreaterThanOrEqual(0.8);
  });

  it('Profit 6: min 5, two spare nodes, roll back promptly', () => {
    expect(winRate('m-final', s => {
      cmdOk(s, 'kubectl autoscale deployment shop --min=5 --max=9', 'cloud add-node', 'cloud add-node');
      until(s, 62); cmdOk(s, 'kubectl rollout undo deployment/shop');
    })).toBeGreaterThanOrEqual(0.9);
  });

  it('Profit 3 (Black Friday): a slow player who only reacts after the rush starts still wins', () => {
    expect(winRate('m-peak', s => {
      until(s, 45); cmdOk(s, 'kubectl autoscale deployment shop --min=2 --max=6');
      until(s, 52); cmdOk(s, 'cloud add-node');
      until(s, 105); cmdOk(s, 'kubectl drain node-3'); sim(s, 4); cmdOk(s, 'cloud remove-node node-3');
    })).toBe(1);
  });

  it('Practitioner 3: fix the selector, label a canary, open traffic', () => {
    expect(winRate('p-labels', s => {
      cmdOk(s, 'kubectl set selector service shop app=shop');
      const pod = podNames(s, 'shop-')[0];
      cmdOk(s, `kubectl label pods ${pod} track=canary`, `kubectl expose pod ${pod} --name=shop-canary --port=80`);
      cmdOk(s, 'kubectl describe service shop');
      openTraffic(s);
    })).toBe(1);
  });

  it('Practitioner 5: fix the target port, forward a port, open traffic', () => {
    expect(winRate('p-ports', s => {
      cmdOk(s, 'kubectl exec toolbox -- wget -qO- http://web', `kubectl port-forward pod/${podNames(s, 'web-')[0]} 8080:80`);
      cmdOk(s, 'kubectl delete service web', 'kubectl expose deployment web --port=80 --target-port=80');
      openTraffic(s);
    })).toBe(1);
  });

  it('Practitioner 6: pause, batch, resume, restart, patch', () => {
    expect(winRate('p-release', s => {
      cmdOk(s, 'kubectl rollout pause deployment/web', 'kubectl set image deployment/web web=web:v2', 'kubectl set resources deployment web --requests=cpu=200m');
      openTraffic(s); sim(s, 2);
      cmdOk(s, 'kubectl rollout resume deployment/web'); sim(s, 25);
      cmdOk(s, 'kubectl rollout restart deployment/web'); sim(s, 30);
      cmdOk(s, `kubectl patch deployment web -p '{"spec":{"replicas":5}}'`);
    })).toBeGreaterThanOrEqual(0.95);
  });
});
