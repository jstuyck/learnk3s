import type { State } from './types';

export interface Burn {
  nodes: number;
  spot: number;
  pods: number;
  total: number;
  onDemand: number;
  spotN: number;
  podN: number;
}

/** Revenue minus running costs minus refund penalties. */
export const profit = (s: State): number => s.money.rev - s.money.cost - s.money.pen;

/** What the cluster costs right now, per second. */
export function burnRate(s: State): Burn {
  const E = s.level.econ;
  if (!E) return { nodes: 0, spot: 0, pods: 0, total: 0, onDemand: 0, spotN: 0, podN: 0 };
  const spotN = s.nodes.filter(n => n.spot).length;
  const onDemand = s.nodes.length - spotN;
  const podN = s.pods.filter(p => p.node).length;
  const nodes = onDemand * E.nodeCost;
  const spot = spotN * E.spotCost;
  const pods = podN * E.podCost;
  return { nodes, spot, pods, total: nodes + spot + pods, onDemand, spotN, podN };
}

/** Revenue per second over the last 10 seconds. */
export function revenueRate(s: State): number {
  const E = s.level.econ;
  if (!E) return 0;
  s.recent = s.recent.filter(x => s.t - x < 10);
  return (s.recent.length / Math.min(10, Math.max(1, s.t))) * E.price;
}
