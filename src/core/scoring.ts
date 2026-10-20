import { profit } from './economy';
import type { State } from './types';

/** 1-3 stars for a won mission. Using more than two hints caps it at 2. */
export function calcStars(s: State): number {
  const L = s.level;
  let st: number;
  if (L.econ) {
    const p = profit(s);
    st = p >= L.econ.stars[1] ? 3 : p >= L.econ.stars[0] ? 2 : 1;
  } else if (L.traffic) {
    const [a, b] = L.traffic.stars;
    st = s.stats.failed <= a ? 3 : s.stats.failed <= b ? 2 : 1;
  } else {
    st = s.cmdErrors <= 1 ? 3 : s.cmdErrors <= 3 ? 2 : 1;
  }
  if (s.hintsUsed > 2) st = Math.min(st, 2);
  return st;
}
