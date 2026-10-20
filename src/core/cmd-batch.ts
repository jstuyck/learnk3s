// kubectl commands for Jobs and CronJobs.
import { IMAGES } from '../data/images';
import type { Ctx } from './ctx';
import { NONE, strFlag } from './ctx';
import { ageStr, cronRows, fmtAge, jobRows } from './format';
import { createCronJob, createJob, cronPeriod, deleteJob, jobPods, MINUTE } from './sim';

const clockNote = 'tip: in this simulator one cron "minute" lasts ' + MINUTE + ' seconds.';

/** kubectl create job NAME --image=IMG [-- command...]   |   kubectl create job NAME --from=cronjob/CRON */
export function createJobCmd(c: Ctx): void {
  const { s, pos, flags, cmdArgs } = c;
  const name = pos[1];
  if (!name) { c.err('error: exactly NAME is required'); return; }
  if (s.jobs.some(j => j.name === name)) { c.err('Error from server (AlreadyExists): jobs.batch "' + name + '" already exists'); return; }
  const from = strFlag(flags.from);
  if (from !== undefined) {
    const m = /^(?:cronjob|cj)\/(.+)$/.exec(from);
    const cj = m ? s.cronjobs.find(x => x.name === m[1]) : undefined;
    if (!m) { c.err('error: unknown object type "' + from + '", use cronjob/NAME'); return; }
    if (!cj) { c.notFound('cronjob', m[1]); return; }
    createJob(s, { name, image: cj.image, command: cj.command, owner: null });
    s.flags.manualJob = true; s.cpPulse = 1;
    c.ok('job.batch/' + name + ' created');
    return;
  }
  const image = strFlag(flags.image);
  if (!image) { c.err('error: required flag(s) "image" not set'); return; }
  createJob(s, { name, image, command: cmdArgs, owner: null });
  s.cpPulse = 1;
  c.ok('job.batch/' + name + ' created');
}

/** kubectl create cronjob NAME --image=IMG --schedule="*\/1 * * * *" [-- command...] */
export function createCronJobCmd(c: Ctx): void {
  const { s, pos, flags, cmdArgs } = c;
  const name = pos[1];
  const image = strFlag(flags.image);
  const schedule = strFlag(flags.schedule);
  if (!name) { c.err('error: exactly NAME is required'); return; }
  if (!image || !schedule) { c.err('error: required flag(s) "' + [!image && 'image', !schedule && 'schedule'].filter(Boolean).join('", "') + '" not set'); return; }
  if (s.cronjobs.some(x => x.name === name)) { c.err('Error from server (AlreadyExists): cronjobs.batch "' + name + '" already exists'); return; }
  const sched = schedule.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  if (cronPeriod(sched) === null) {
    c.err('error: failed to create cronjob: unsupported schedule "' + sched + '". This simulator understands "* * * * *", "*/N * * * *" and "M * * * *"');
    return;
  }
  createCronJob(s, { name, schedule: sched, image, command: cmdArgs });
  c.ok('cronjob.batch/' + name + ' created');
  c.say(clockNote, 'dim');
}

export function getJobs(c: Ctx): void {
  if (!c.s.jobs.length) c.say(NONE, 'dim'); else c.emit(jobRows(c.s));
}
export function getCronJobs(c: Ctx): void {
  if (!c.s.cronjobs.length) c.say(NONE, 'dim'); else c.emit(cronRows(c.s));
}

export function describeJob(c: Ctx, name: string): void {
  const { s } = c;
  const j = s.jobs.find(x => x.name === name);
  if (!j) { c.notFound('job', name); return; }
  const pods = jobPods(s, j.name);
  const failed = pods.filter(p => p.phase === 'Error').length;
  const ok = pods.filter(p => p.phase === 'Completed').length;
  const active = pods.filter(p => ['Pending', 'ContainerCreating', 'Running'].includes(p.phase)).length;
  c.say('Name:             ' + j.name);
  c.say('Controlled By:    ' + (j.owner ? 'CronJob/' + j.owner : '<none>'));
  c.say('Parallelism:      1');
  c.say('Completions:      1');
  c.say('Backoff Limit:    3');
  c.say('Start Time:       ' + ageStr(s, j.createdAt) + ' ago');
  c.say('Pods Statuses:    ' + active + ' Active (0 Ready) / ' + ok + ' Succeeded / ' + failed + ' Failed');
  c.say('Image:            ' + j.image);
  c.say('Command:          ' + (j.command.join(' ') || '<none>'));
  c.say('Events:');
  if (j.status === 'Failed') c.say('  Warning  BackoffLimitExceeded  Job has reached the specified backoff limit', 'warn');
  else if (j.status === 'Complete') c.say('  Normal   Completed             Job completed');
  else c.say('  Normal   SuccessfulCreate      Created pod: ' + (pods[pods.length - 1]?.name ?? '<pending>'));
}

export function describeCronJob(c: Ctx, name: string): void {
  const { s } = c;
  const cj = s.cronjobs.find(x => x.name === name);
  if (!cj) { c.notFound('cronjob', name); return; }
  c.say('Name:                          ' + cj.name);
  c.say('Schedule:                      ' + cj.schedule);
  c.say('Concurrency Policy:            Allow');
  c.say('Suspend:                       ' + (cj.suspend ? 'True' : 'False'));
  c.say('Successful Job History Limit:  3');
  c.say('Image:                         ' + cj.image);
  c.say('Last Schedule Time:            ' + (cj.lastSchedule === null ? '<unset>' : fmtAge(s.t - cj.lastSchedule) + ' ago'));
  c.say('Active Jobs:                   ' + (s.jobs.filter(j => j.owner === cj.name && j.status === 'Running').map(j => j.name).join(', ') || '<none>'));
}

export function deleteJobCmd(c: Ctx, name: string): void {
  const j = c.s.jobs.find(x => x.name === name);
  if (!j) { c.notFound('job', name); return; }
  deleteJob(c.s, j);
  c.ok('job.batch "' + name + '" deleted');
}

export function deleteCronJobCmd(c: Ctx, name: string): void {
  const { s } = c;
  const cj = s.cronjobs.find(x => x.name === name);
  if (!cj) { c.notFound('cronjob', name); return; }
  s.cronjobs = s.cronjobs.filter(x => x !== cj);
  for (const j of s.jobs.filter(x => x.owner === cj.name)) deleteJob(s, j);
  c.ok('cronjob.batch "' + name + '" deleted');
}

/** kubectl logs job/NAME : the output of the job's newest pod. */
export function logsOfJob(c: Ctx, name: string): void {
  const { s } = c;
  const j = s.jobs.find(x => x.name === name);
  if (!j) { c.notFound('job', name); return; }
  const pods = jobPods(s, j.name).filter(x => x.phase !== 'Terminating');
  // like kubectl, pick a pod that actually has something to show: finished pods first, newest last
  const p = [...pods].reverse().find(x => x.phase === 'Completed' || x.phase === 'Error') ?? pods[pods.length - 1];
  if (!p) { c.err('error: job "' + name + '" has no pods yet'); return; }
  s.flags.readJobLogs = true;
  if (p.phase === 'Error' || p.phase === 'ImagePullBackOff') s.flags.inspectedCrash = true;
  if (p.logs.length) p.logs.forEach(l => c.say(l, p.phase === 'Error' ? 'err' : ''));
  else if (p.phase === 'Completed') c.say('', 'dim');
  else c.say('container "' + p.image + '" is not ready yet (status: ' + p.phase + ')', 'warn');
}

/** Warn about images the simulator does not know before a Job tries to run them. */
export const knownImage = (image: string): boolean => image in IMAGES;
