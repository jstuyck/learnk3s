import { runCommand } from '../src/core/cli';
import { profit } from '../src/core/economy';
import { newState, step } from '../src/core/sim';
import type { Level, State } from '../src/core/types';
import { ALL_LEVELS } from '../src/data/campaigns';

export const SEED = 1234;

export function level(id: string): Level {
  const L = ALL_LEVELS.find(l => l.id === id);
  if (!L) throw new Error('unknown level ' + id);
  return L;
}

/** Fresh state for a level id with a fixed seed. */
export const start = (id: string, seed = SEED): State => newState(level(id), seed);

/** Advance the simulation by `seconds` of game time (50ms ticks). Stops early when the mission ends. */
export function sim(s: State, seconds: number): State {
  const ticks = Math.round(seconds * 20);
  for (let i = 0; i < ticks && !s.outcome; i++) step(s, 0.05);
  return s;
}

/** Run one or more commands; returns the printed text. */
export function cmd(s: State, ...lines: string[]): string {
  return lines.map(l => runCommand(s, l).map(x => x.t).join('\n')).join('\n');
}

// Red output is not always a failure (e.g. a crashing app's logs); real command errors look like this.
const FAILURE = /^(error|Error|usage|command not found|QuotaExceeded)/;

/** Run commands and fail the test run loudly if any of them printed a command error. */
export function cmdOk(s: State, ...lines: string[]): void {
  for (const l of lines) {
    const bad = runCommand(s, l).filter(x => x.c === 'err' && FAILURE.test(x.t));
    if (bad.length) throw new Error('command failed: ' + l + ' -> ' + bad.map(b => b.t).join(' / '));
  }
}

export const podNames = (s: State, prefix = ''): string[] =>
  s.pods.filter(p => p.name.startsWith(prefix) && p.phase !== 'Terminating').map(p => p.name);

export const openTraffic = (s: State): void => { s.mode = 'live'; };

/** Run until the mission is decided (or `maxSeconds` pass). */
export function finish(s: State, maxSeconds = 400): State {
  for (let i = 0; i < maxSeconds && !s.outcome; i++) sim(s, 1);
  return s;
}

/** Advance to `tt` seconds of live traffic. */
export function until(s: State, tt: number): State {
  if (tt > s.tt) sim(s, tt - s.tt);
  return s;
}

export { profit };
