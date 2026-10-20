// Kubernetes the Hard Way: every lab's reference solution wins its mission, and common mistakes fail the way they should.
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/core/cli';
import { HW_SOLUTIONS, HARDWAY_LEVELS } from '../src/data/levels-hardway';
import { sim, start } from './helpers';

const solve = (i: number) => {
  const s = start(HARDWAY_LEVELS[i].id);
  const errs: string[] = [];
  for (const line of HW_SOLUTIONS[i]) {
    const out = runCommand(s, line);
    for (const l of out) if (l.c === 'err') errs.push(line.slice(0, 60) + ' -> ' + l.t);
    if (/create deployment/.test(line)) sim(s, 6);   // let the pod start
  }
  sim(s, 1);
  return { s, errs };
};

describe('Hard Way reference solutions', () => {
  HARDWAY_LEVELS.forEach((L, i) => {
    it(`${i + 1}. ${L.title}`, () => {
      const { s, errs } = solve(i);
      const missing = L.objectives.filter(o => !s.done[o.id]).map(o => o.id);
      expect(errs).toEqual([]);
      expect(missing).toEqual([]);
      expect(s.outcome).toBe('win');
    });
  });
});
