import type { Campaign } from '../core/types';
import { ELITE_LEVELS } from './levels-elite';
import { HARDWAY_LEVELS } from './levels-hardway';
import { PRACTITIONER_LEVELS } from './levels-practitioner';
import { PROFIT_LEVELS } from './levels-profit';
import { ROOKIE_LEVELS } from './levels-rookie';

export const CAMPAIGNS: Campaign[] = [
  { id: 'rookie', name: 'Rookie', sub: 'Learn the basics', mode: 'campaign', levels: ROOKIE_LEVELS },
  { id: 'practitioner', name: 'Practitioner', sub: 'Jobs, labels, limits, debugging', mode: 'campaign', levels: PRACTITIONER_LEVELS },
  { id: 'elite', name: 'Elite', sub: 'Advanced kubectl: queries, bulk ops, forensics', mode: 'campaign', levels: ELITE_LEVELS },
  { id: 'hardway', name: 'The Hard Way', sub: 'Build a cluster by hand: certs, etcd, control plane, nodes', mode: 'campaign', levels: HARDWAY_LEVELS },
  { id: 'profit', name: 'Profit Mode', sub: 'Run the cluster for money', mode: 'profit', levels: PROFIT_LEVELS },
];

export const ALL_LEVELS = CAMPAIGNS.flatMap(c => c.levels);
