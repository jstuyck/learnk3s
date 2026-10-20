// Data integrity for every mission in every campaign.
import { describe, expect, it } from 'vitest';
import { IMAGES } from '../src/data/images';
import { ALL_LEVELS, CAMPAIGNS } from '../src/data/campaigns';
import { newState } from '../src/core/sim';

describe('campaign data', () => {
  it('has unique level ids', () => {
    const ids = ALL_LEVELS.map(l => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has the expected campaigns', () => {
    expect(CAMPAIGNS.map(c => c.id)).toEqual(['rookie', 'practitioner', 'elite', 'hardway', 'profit']);
    expect(CAMPAIGNS.map(c => c.mode)).toEqual(['campaign', 'campaign', 'campaign', 'campaign', 'profit']);
    expect(CAMPAIGNS[0].levels).toHaveLength(8);
    expect(CAMPAIGNS[1].levels).toHaveLength(6);
    expect(CAMPAIGNS[2].levels).toHaveLength(6);
    expect(CAMPAIGNS[3].levels).toHaveLength(12);
    expect(CAMPAIGNS[4].levels).toHaveLength(6);
  });

  describe.each(ALL_LEVELS.map(l => [l.id, l] as const))('%s', (_id, L) => {
    it('has all the text fields the UI shows', () => {
      for (const f of [L.title, L.tag, L.blurb, L.story, L.codex.title, L.codex.text]) expect(f.length).toBeGreaterThan(3);
      expect(L.hints.length).toBeGreaterThanOrEqual(3);
      expect(L.cheats.length).toBeGreaterThanOrEqual(2);
    });

    it('lists commands as "command | description" without ready-to-type arguments', () => {
      for (const c of L.cheats) {
        const [cmd, desc, ...rest] = c.split(' | ');
        expect(rest).toHaveLength(0);
        expect(desc?.length).toBeGreaterThan(3);
        expect(cmd).toMatch(L.hardway ? /^[a-z0-9-]+( [a-z0-9-]+)?$/ : /^(kubectl|cloud) [a-z-]+( [a-z]+)?$/);
        expect(cmd).not.toMatch(/--|=/);
      }
    });

    it('has objectives with unique ids that are not already satisfied at the start', () => {
      const ids = L.objectives.map(o => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      const s = newState(L, 1);
      expect(s.outcome).toBeNull();
      for (const o of L.objectives) expect(o.check(s), `objective "${o.id}" starts done`).toBe(false);
    });

    it('seeds a cluster whose images all exist in the catalog', () => {
      const s = newState(L, 1);
      for (const d of s.deployments) expect(IMAGES[d.image], d.image).toBeDefined();
      if (!L.hardway) expect(s.nodes).toHaveLength(L.nodes);
    });

    it('traffic missions have a positive rate and a Service-less start unless seeded', () => {
      if (!L.traffic) return;
      expect(L.traffic.profile.length).toBeGreaterThan(0);
      for (const seg of L.traffic.profile) { expect(seg.rps).toBeGreaterThan(0); expect(seg.to).toBeGreaterThan(seg.from); }
      expect(L.traffic.profile[0].from).toBe(0);
    });

    it('economy missions have a positive target and a prize reachable by the star thresholds', () => {
      if (!L.econ) return;
      expect(L.traffic?.auto).toBe(true);
      expect(L.econ.target).toBeGreaterThan(0);
      expect(L.econ.stars[0]).toBeGreaterThan(L.econ.target);
      expect(L.econ.stars[1]).toBeGreaterThan(L.econ.stars[0]);
      expect(L.econ.duration).toBeGreaterThan(20);
      expect(L.objectives.some(o => o.id === 'profit')).toBe(true);
    });
  });

  it('only Profit Mode has money', () => {
    expect(CAMPAIGNS[0].levels.some(l => l.econ)).toBe(false);
    expect(CAMPAIGNS[1].levels.some(l => l.econ)).toBe(false);
    expect(CAMPAIGNS[2].levels.some(l => l.econ)).toBe(false);
    expect(CAMPAIGNS[3].levels.some(l => l.econ)).toBe(false);
    expect(CAMPAIGNS[4].levels.every(l => l.econ)).toBe(true);
  });
});
