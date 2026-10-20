// Smoke test: the renderer must not throw for any mission in any state the simulation can reach.
import { describe, expect, it } from 'vitest';
import { podAt, draw } from '../src/ui/render';
import { ALL_LEVELS } from '../src/data/campaigns';
import { cmd, openTraffic, sim, start } from './helpers';

/** A canvas context that records nothing and accepts everything. */
function stubContext(): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

describe('renderer', () => {
  it.each(ALL_LEVELS.map(l => [l.id] as const))('draws %s through a whole run', id => {
    const s = start(id, 5);
    const c = stubContext();
    cmd(s, 'kubectl run extra --image=nonexistent');
    openTraffic(s);
    for (let i = 0; i < 120; i++) {
      sim(s, 1);
      expect(() => draw(c, s, s.pods[0]?.id ?? null)).not.toThrow();
    }
  });

  it('hit-tests pods', () => {
    const s = start('deployments');
    cmd(s, 'kubectl create deployment web --image=nginx --replicas=2');
    sim(s, 4);
    let found = 0;
    for (let x = 0; x < 960; x += 8) for (let y = 0; y < 500; y += 8) if (podAt(s, x, y)) found++;
    expect(found).toBeGreaterThan(20);
    expect(podAt(s, 5, 5)).toBeNull();
  });
});
