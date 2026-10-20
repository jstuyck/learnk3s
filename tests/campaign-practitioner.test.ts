// Full playthroughs of the Practitioner campaign, plus the shell-style argument splitting they rely on.
import { describe, expect, it } from 'vitest';
import { splitWords } from '../src/core/ctx';
import { MINUTE } from '../src/core/sim';
import { calcStars } from '../src/core/scoring';
import { completeLine } from '../src/core/completion';
import { cmd, cmdOk, finish, openTraffic, podNames, sim, start, until } from './helpers';

describe('splitWords', () => {
  it('groups quoted words and strips the quotes', () => {
    expect(splitWords('kubectl create cronjob b --schedule="*/1 * * * *" -- echo hi')).toEqual(
      ['kubectl', 'create', 'cronjob', 'b', '--schedule=*/1 * * * *', '--', 'echo', 'hi']);
    expect(splitWords(`kubectl patch cronjob x -p '{"spec":{"suspend":true}}'`)).toEqual(['kubectl', 'patch', 'cronjob', 'x', '-p', '{"spec":{"suspend":true}}']);
    expect(splitWords('a  b\tc')).toEqual(['a', 'b', 'c']);
    expect(splitWords('echo ""')).toEqual(['echo', '']);
    expect(splitWords('')).toEqual([]);
  });
});

describe('Practitioner campaign', () => {
  it('1. Run to Completion', () => {
    const s = start('p-jobs');
    cmdOk(s, 'kubectl create job hello --image=busybox -- echo hello from a job');
    sim(s, 8);
    cmdOk(s, 'kubectl get jobs', 'kubectl logs job/hello', 'kubectl logs job/nightly-report');
    cmdOk(s, 'kubectl delete job nightly-report');
    sim(s, 3);
    cmdOk(s, 'kubectl create job nightly-report --image=report:v2 -- python report.py');
    finish(s, 30);
    expect(s.outcome).toBe('win');
    expect(calcStars(s)).toBeGreaterThanOrEqual(2);
  });

  it('1. Run to Completion: simply waiting never wins', () => {
    const s = start('p-jobs');
    sim(s, 60);
    expect(s.outcome).toBeNull();
    expect(s.jobs.find(j => j.name === 'nightly-report')!.status).toBe('Failed');
  });

  it('2. On a Schedule', () => {
    const s = start('p-cron');
    cmdOk(s, 'kubectl create cronjob backup --image=busybox --schedule="*/1 * * * *" -- echo backing up');
    sim(s, MINUTE * 3 + 1);
    cmdOk(s, 'kubectl get cronjobs', 'kubectl get jobs', 'kubectl create job backup-now --from=cronjob/backup');
    cmdOk(s, `kubectl patch cronjob backup -p '{"spec":{"suspend":true}}'`);
    finish(s, 20);
    expect(s.outcome).toBe('win');
  });

  it('2. On a Schedule: a 5-minute schedule does not satisfy the "every minute" objective', () => {
    const s = start('p-cron');
    cmdOk(s, 'kubectl create cronjob backup --image=busybox --schedule="*/5 * * * *"');
    sim(s, MINUTE * 6);
    expect(s.done.create).toBeUndefined();
  });

  it('3. Lost in the Selectors', () => {
    const s = start('p-labels');
    cmdOk(s, 'kubectl describe service shop', 'kubectl get pods --show-labels', 'kubectl set selector service shop app=shop');
    const pod = podNames(s, 'shop-')[0];
    cmdOk(s, `kubectl label pods ${pod} track=canary`, `kubectl expose pod ${pod} --name=shop-canary --port=80`);
    openTraffic(s);
    expect(finish(s).outcome).toBe('win');
  });

  it('3. Lost in the Selectors: opening traffic without fixing the selector fails', () => {
    const s = start('p-labels');
    openTraffic(s);
    expect(finish(s).outcome).toBe('fail');
  });

  it('4. Right-Sized', () => {
    const s = start('p-limits');
    sim(s, 6);
    cmdOk(s, 'kubectl describe pod ' + podNames(s, 'api-')[0]);
    cmdOk(s, 'kubectl set resources deployment api --limits=memory=256Mi');
    cmdOk(s, 'kubectl set resources deployment worker --requests=cpu=250m');
    finish(s, 40);
    expect(s.outcome).toBe('win');
  });

  it('4. Right-Sized: lowering the CPU request with the wrong unit is rejected', () => {
    const s = start('p-limits');
    expect(cmd(s, 'kubectl set resources deployment worker --requests=cpu=lots')).toMatch(/invalid --requests/);
  });

  it('5. Connection Refused', () => {
    const s = start('p-ports');
    cmdOk(s, 'kubectl exec toolbox -- wget -qO- http://web');
    cmdOk(s, `kubectl port-forward pod/${podNames(s, 'web-')[0]} 8080:80`);
    cmdOk(s, 'kubectl delete service web', 'kubectl expose deployment web --port=80 --target-port=80');
    openTraffic(s);
    expect(finish(s).outcome).toBe('win');
  });

  it('5. Connection Refused: opening traffic first burns through the failure budget', () => {
    const s = start('p-ports');
    openTraffic(s);
    expect(finish(s).outcome).toBe('fail');
  });

  it('6. Release Night', () => {
    const s = start('p-release');
    cmdOk(s, 'kubectl rollout pause deployment/web');
    cmdOk(s, 'kubectl set image deployment/web web=web:v2', 'kubectl set resources deployment web --requests=cpu=200m');
    sim(s, 2);
    openTraffic(s);
    cmdOk(s, 'kubectl rollout resume deployment/web');
    sim(s, 25);
    cmdOk(s, 'kubectl rollout restart deployment/web');
    sim(s, 30);
    cmdOk(s, `kubectl patch deployment web -p '{"spec":{"replicas":5}}'`);
    finish(s, 60);
    expect(s.outcome).toBe('win');
    expect(s.deployments[0].rollouts).toBe(2);   // one batched rollout + one restart
  });

  it('6. Release Night: rolling out without pausing fails the batching objective', () => {
    const s = start('p-release');
    cmdOk(s, 'kubectl set image deployment/web web=web:v2', 'kubectl set resources deployment web --requests=cpu=200m');
    openTraffic(s);
    until(s, 60);
    expect(s.done.batch).toBeUndefined();
  });
});

describe('Tab completion for the new commands', () => {
  const opts = (id: string, line: string) => completeLine(start(id), line).options;
  it('completes jobs, cronjobs and job logs', () => {
    expect(opts('p-jobs', 'kubectl get j')).toEqual(['jobs']);
    expect(opts('p-jobs', 'kubectl logs job/')).toEqual(['job/nightly-report']);
    expect(opts('p-jobs', 'kubectl create ')).toEqual(['deployment', 'configmap', 'secret', 'job', 'cronjob']);
    expect(opts('p-jobs', 'kubectl delete job ')).toEqual(['nightly-report']);
  });
  it('completes label, exec, port-forward, set and rollout subcommands', () => {
    expect(opts('p-labels', 'kubectl label pods ')).toHaveLength(3);
    expect(opts('p-ports', 'kubectl exec ')).toContain('toolbox');
    expect(opts('p-ports', 'kubectl port-forward svc/')).toEqual(['svc/web']);
    expect(opts('p-labels', 'kubectl set selector service ')).toEqual(['shop']);
    expect(opts('p-release', 'kubectl rollout ')).toEqual(['status', 'history', 'undo', 'pause', 'resume', 'restart']);
    expect(opts('p-limits', 'kubectl set resources deployment ')).toEqual(['api', 'worker']);
  });
});
