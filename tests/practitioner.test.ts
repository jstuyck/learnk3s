// Jobs, CronJobs, labels/selectors, resources, exec/port-forward, pause/resume/restart/patch.
import { describe, expect, it } from 'vitest';
import { cronPeriod, MINUTE, planCommand, readyCount } from '../src/core/sim';
import { cmd, cmdOk, podNames, sim, start } from './helpers';

describe('planCommand', () => {
  it('understands sleep, echo, failure and shell wrappers', () => {
    expect(planCommand(['sleep', '7'], 'p').runFor).toBe(7);
    expect(planCommand(['echo', 'hello', 'world'], 'p').output).toEqual(['hello world']);
    expect(planCommand(['false'], 'p').fail).toBe(true);
    expect(planCommand(['sh', '-c', 'echo hi && sleep 3'], 'p')).toMatchObject({ runFor: 3, output: ['hi'], fail: false });
    expect(planCommand(['hostname'], 'my-pod').output).toEqual(['my-pod']);
    expect(planCommand([], 'p').runFor).toBeGreaterThan(0);
  });
});

describe('cronPeriod', () => {
  it('parses the supported minute fields', () => {
    expect(cronPeriod('* * * * *')).toBe(MINUTE);
    expect(cronPeriod('*/1 * * * *')).toBe(MINUTE);
    expect(cronPeriod('*/5 * * * *')).toBe(5 * MINUTE);
    expect(cronPeriod('30 * * * *')).toBe(60 * MINUTE);
    expect(cronPeriod('*/0 * * * *')).toBeNull();
    expect(cronPeriod('every minute')).toBeNull();
    expect(cronPeriod('* * * *')).toBeNull();
  });
});

describe('Jobs', () => {
  it('runs a pod to completion: Completed pod, Complete job, output kept in logs', () => {
    const s = start('p-jobs');
    cmdOk(s, 'kubectl create job hello --image=busybox -- echo hello from a job');
    sim(s, 8);
    expect(cmd(s, 'kubectl get jobs')).toMatch(/hello\s+Complete\s+1\/1/);
    expect(cmd(s, 'kubectl get pods')).toMatch(/hello-\w+\s+0\/1\s+Completed/);
    expect(cmd(s, 'kubectl logs job/hello')).toBe('hello from a job');
    expect(s.flags.readJobLogs).toBe(true);
  });

  it('a finished pod holds no node slot', () => {
    const s = start('p-jobs');
    cmdOk(s, 'kubectl create job a --image=busybox -- echo a');
    sim(s, 8);
    const done = s.pods.find(p => p.name.startsWith('a-'))!;
    expect(done.phase).toBe('Completed');
    expect(done.node).toBeNull();
    expect(done.ranOn).toMatch(/^node-/);
  });

  it('sleep keeps the pod Running for that long', () => {
    const s = start('p-jobs');
    cmdOk(s, 'kubectl create job nap --image=busybox -- sleep 10');
    sim(s, 6);
    expect(s.pods.find(p => p.name.startsWith('nap-'))!.phase).toBe('Running');
    sim(s, 8);
    expect(s.jobs.find(j => j.name === 'nap')!.status).toBe('Complete');
  });

  it('a failing command retries, then the Job fails (BackoffLimitExceeded)', () => {
    const s = start('p-jobs');
    cmdOk(s, 'kubectl create job bad --image=busybox -- false');
    sim(s, 40);
    const j = s.jobs.find(x => x.name === 'bad')!;
    expect(j.status).toBe('Failed');
    expect(s.pods.filter(p => p.name.startsWith('bad-') && p.phase === 'Error').length).toBeGreaterThanOrEqual(4);
    expect(cmd(s, 'kubectl describe job bad')).toMatch(/BackoffLimitExceeded/);
  });

  it('the seeded broken report fails with a helpful traceback; report:v2 fixes it', () => {
    const s = start('p-jobs');
    sim(s, 3);
    expect(cmd(s, 'kubectl logs job/nightly-report')).toMatch(/KeyError.*report:v2/);
    cmdOk(s, 'kubectl delete job nightly-report');
    sim(s, 3);
    cmdOk(s, 'kubectl create job nightly-report --image=report:v2 -- python report.py');
    sim(s, 8);
    expect(s.jobs.find(j => j.name === 'nightly-report')!.status).toBe('Complete');
  });

  it('create job validates its arguments; delete job removes the pods', () => {
    const s = start('p-jobs');
    expect(cmd(s, 'kubectl create job x')).toMatch(/"image" not set/);
    expect(cmd(s, 'kubectl create job nightly-report --image=busybox')).toMatch(/AlreadyExists/);
    cmdOk(s, 'kubectl create job tmp --image=busybox -- echo x');
    sim(s, 6);
    cmdOk(s, 'kubectl delete job tmp');
    sim(s, 3);
    expect(s.jobs.some(j => j.name === 'tmp')).toBe(false);
    expect(s.pods.some(p => p.name.startsWith('tmp-'))).toBe(false);
    expect(cmd(s, 'kubectl delete job tmp')).toMatch(/NotFound/);
  });

  it('run --restart=Never with a command behaves like a one-shot pod', () => {
    const s = start('p-jobs');
    cmdOk(s, 'kubectl run once --image=busybox --restart=Never -- echo done');
    sim(s, 8);
    expect(s.pods.find(p => p.name === 'once')!.phase).toBe('Completed');
    expect(cmd(s, 'kubectl logs once')).toBe('done');
  });
});

describe('CronJobs', () => {
  it('spawns a Job per period and keeps only the 3 newest finished ones', () => {
    const s = start('p-cron');
    cmdOk(s, 'kubectl create cronjob backup --image=busybox --schedule="*/1 * * * *" -- echo backing up');
    sim(s, MINUTE * 6 + 2);
    const cj = s.cronjobs[0];
    expect(cj.counter).toBe(6);
    expect(s.jobs.filter(j => j.owner === 'backup').length).toBeLessThanOrEqual(4);
    expect(cmd(s, 'kubectl get cronjobs')).toMatch(/backup\s+\*\/1 \* \* \* \*\s+<none>\s+False/);
  });

  it('validates the schedule', () => {
    const s = start('p-cron');
    expect(cmd(s, 'kubectl create cronjob b --image=busybox --schedule="every minute"')).toMatch(/unsupported schedule/);
    expect(cmd(s, 'kubectl create cronjob b --image=busybox')).toMatch(/"schedule" not set/);
  });

  it('create job --from=cronjob runs the template once; patch suspend stops scheduling', () => {
    const s = start('p-cron');
    cmdOk(s, 'kubectl create cronjob backup --image=busybox --schedule="*/1 * * * *" -- echo hi');
    cmdOk(s, 'kubectl create job manual --from=cronjob/backup');
    expect(s.flags.manualJob).toBe(true);
    cmdOk(s, `kubectl patch cronjob backup -p '{"spec":{"suspend":true}}'`);
    const before = s.cronjobs[0].counter;
    sim(s, MINUTE * 3);
    expect(s.cronjobs[0].counter).toBe(before);
    expect(s.cronjobs[0].suspend).toBe(true);
    expect(cmd(s, 'kubectl create job m2 --from=cronjob/none')).toMatch(/NotFound/);
    cmdOk(s, `kubectl patch cronjob backup -p '{"spec":{"suspend":false}}'`);
    sim(s, MINUTE * 2);
    expect(s.cronjobs[0].counter).toBeGreaterThan(before);
  });
});

describe('labels and selectors', () => {
  it('the typo\'d Service has no endpoints until its selector is fixed', () => {
    const s = start('p-labels');
    expect(cmd(s, 'kubectl describe service shop')).toMatch(/Selector:\s+app=shopp[\s\S]*Endpoints:\s+<none>/);
    expect(cmd(s, 'kubectl get pods --show-labels')).toMatch(/LABELS[\s\S]*app=shop/);
    cmdOk(s, 'kubectl set selector service shop app=shop');
    expect(cmd(s, 'kubectl describe service shop')).toMatch(/Selector:\s+app=shop\b/);
    expect(cmd(s, 'kubectl get endpoints')).toMatch(/shop\s+10\.244\.[\d.:,]+/);
    expect(s.flags.fixedSelector).toBe(true);
  });

  it('label adds, refuses to overwrite silently, removes; -l filters', () => {
    const s = start('p-labels');
    const [a, b] = podNames(s, 'shop-');
    cmdOk(s, `kubectl label pods ${a} track=canary`);
    expect(cmd(s, `kubectl label pods ${a} track=stable`)).toMatch(/already has a value \(canary\)/);
    cmdOk(s, `kubectl label pods ${a} track=stable --overwrite`);
    cmdOk(s, `kubectl label pods ${b} track=stable`);
    expect(cmd(s, 'kubectl get pods -l track=stable').split('\n')).toHaveLength(3);
    cmdOk(s, `kubectl label pods ${b} track-`);
    expect(cmd(s, 'kubectl get pods -l track=stable').split('\n')).toHaveLength(2);
    expect(cmd(s, `kubectl label pods ${a}`)).toMatch(/label specification is required/);
    expect(cmd(s, 'kubectl label pods nope x=y')).toMatch(/NotFound/);
  });

  it('expose pod uses the pod\'s whole label set, giving a canary Service with one endpoint', () => {
    const s = start('p-labels');
    cmdOk(s, 'kubectl set selector service shop app=shop');
    const pod = podNames(s, 'shop-')[0];
    cmdOk(s, `kubectl label pods ${pod} track=canary`, `kubectl expose pod ${pod} --name=shop-canary --port=80`);
    const canary = s.services.find(v => v.name === 'shop-canary')!;
    expect(canary.selector).toMatchObject({ app: 'shop', track: 'canary' });
    expect(cmd(s, 'kubectl get endpoints shop-canary').length).toBeGreaterThan(0);
    expect(s.done.canary).toBeUndefined();
    sim(s, 1);
    expect(s.done.canary).toBe(true);
  });

  it('a label added to a Deployment\'s pod is lost when the pod is replaced', () => {
    const s = start('p-labels');
    const pod = podNames(s, 'shop-')[0];
    cmdOk(s, `kubectl label pods ${pod} track=canary`);
    cmdOk(s, `kubectl delete pod ${pod}`);
    sim(s, 6);
    expect(s.pods.filter(p => p.labels.track === 'canary' && p.phase !== 'Terminating')).toHaveLength(0);
  });
});

describe('resources', () => {
  it('a too-low memory limit gets the container OOMKilled; raising it heals the Deployment', () => {
    const s = start('p-limits');
    sim(s, 7);
    const api = s.pods.find(p => p.name.startsWith('api-'))!;
    expect(api.phase).toBe('CrashLoopBackOff');
    expect(api.reason).toBe('OOMKilled');
    expect(cmd(s, 'kubectl describe pod ' + api.name)).toMatch(/OOMKilled[\s\S]*Exit Code: 137/);
    expect(cmd(s, 'kubectl get pods')).toMatch(/OOMKilled|CrashLoopBackOff/);
    cmdOk(s, 'kubectl set resources deployment api --limits=memory=256Mi');
    sim(s, 8);
    expect(readyCount(s, 'api')).toBe(2);
    expect(cmd(s, 'kubectl describe deployment api')).toMatch(/Limits:\s+memory 256Mi/);
  });

  it('a CPU request larger than the free node CPU leaves pods Pending with Insufficient cpu', () => {
    const s = start('p-limits');
    sim(s, 3);
    const pending = s.pods.filter(p => p.name.startsWith('worker-') && p.phase === 'Pending');
    expect(pending.length).toBeGreaterThan(0);
    expect(cmd(s, 'kubectl describe pod ' + pending[0].name)).toMatch(/Insufficient cpu/);
    cmdOk(s, 'kubectl set resources deployment worker --requests=cpu=250m');
    sim(s, 15);
    expect(readyCount(s, 'worker')).toBe(4);
  });

  it('set resources validates quantities', () => {
    const s = start('p-limits');
    expect(cmd(s, 'kubectl set resources deployment api')).toMatch(/you must specify an update/);
    expect(cmd(s, 'kubectl set resources deployment api --limits=memory=lots')).toMatch(/invalid --limits/);
    expect(cmd(s, 'kubectl set resources deployment nope --limits=memory=1Gi')).toMatch(/NotFound/);
    cmdOk(s, 'kubectl set resources deployment api --requests=cpu=1 --limits=memory=1Gi');
    expect(s.deployments.find(d => d.name === 'api')!.res).toEqual({ cpu: 1000, mem: 1024 });
  });
});

describe('exec and port-forward', () => {
  it('exec runs simulated commands inside a running pod', () => {
    const s = start('p-ports');
    expect(cmd(s, 'kubectl exec toolbox -- hostname')).toBe('toolbox');
    expect(cmd(s, 'kubectl exec -it toolbox -- echo hi there')).toBe('hi there');
    expect(cmd(s, 'kubectl exec toolbox -- env')).toMatch(/WEB_SERVICE_HOST=10\.96\./);
    expect(cmd(s, 'kubectl exec toolbox -- nslookup web')).toMatch(/web\.default\.svc\.cluster\.local/);
    expect(cmd(s, 'kubectl exec toolbox')).toMatch(/specify at least one command/);
    expect(cmd(s, 'kubectl exec nope -- ls')).toMatch(/NotFound/);
    expect(s.flags.usedExec).toBe(true);
  });

  it('a Service whose targetPort does not match the container refuses connections', () => {
    const s = start('p-ports');
    expect(cmd(s, 'kubectl exec toolbox -- wget -qO- http://web')).toMatch(/Connection refused/);
    expect(cmd(s, 'kubectl exec toolbox -- wget -qO- http://nothere')).toMatch(/bad address/);
    cmdOk(s, 'kubectl delete service web', 'kubectl expose deployment web --port=80 --target-port=80');
    expect(cmd(s, 'kubectl exec toolbox -- wget -qO- http://web')).toMatch(/Welcome to web/);
    expect(cmd(s, 'kubectl exec toolbox -- curl web:81')).toMatch(/Connection refused/);
  });

  it('requests through a mismatched targetPort fail; the fixed Service serves them', () => {
    const bad = start('p-ports');
    bad.mode = 'live';
    sim(bad, 8);
    expect(bad.stats.served).toBe(0);
    expect(bad.stats.failed).toBeGreaterThan(5);
    const good = start('p-ports');
    cmdOk(good, 'kubectl delete service web', 'kubectl expose deployment web --port=80 --target-port=80');
    good.mode = 'live';
    sim(good, 8);
    expect(good.stats.served).toBeGreaterThan(5);
    expect(good.stats.failed).toBe(0);
  });

  it('port-forward succeeds on the real container port and refuses a wrong one', () => {
    const s = start('p-ports');
    const pod = podNames(s, 'web-')[0];
    expect(cmd(s, `kubectl port-forward pod/${pod} 8080:8080`)).toMatch(/connection refused/);
    expect(s.flags.portForwarded).toBeUndefined();
    expect(cmd(s, `kubectl port-forward pod/${pod} 8080:80`)).toMatch(/Forwarding from 127\.0\.0\.1:8080 -> 80/);
    expect(s.flags.portForwarded).toBe(true);
    expect(cmd(s, 'kubectl port-forward deployment/web 9090:80')).toMatch(/9090 -> 80/);
    expect(cmd(s, 'kubectl port-forward')).toMatch(/usage/);
  });
});

describe('rollout pause / resume / restart, patch', () => {
  it('changes made while paused do not touch pods; resume rolls once', () => {
    const s = start('p-release');
    const before = podNames(s, 'web-').sort();
    cmdOk(s, 'kubectl rollout pause deployment/web');
    cmdOk(s, 'kubectl set image deployment/web web=web:v2', 'kubectl set resources deployment web --requests=cpu=200m');
    sim(s, 15);
    expect(podNames(s, 'web-').sort()).toEqual(before);
    expect(s.deployments[0].rollouts).toBe(0);
    expect(cmd(s, 'kubectl rollout status deployment/web')).toMatch(/is paused/);
    cmdOk(s, 'kubectl rollout resume deployment/web');
    sim(s, 25);
    expect(s.deployments[0].rollouts).toBe(1);
    expect(s.pods.filter(p => p.owner === 'web' && p.phase === 'Running').every(p => p.image === 'web:v2' && p.cpuReq === 200)).toBe(true);
  });

  it('without pausing each change is its own rollout', () => {
    const s = start('p-release');
    cmdOk(s, 'kubectl set image deployment/web web=web:v2');
    cmdOk(s, 'kubectl set resources deployment web --requests=cpu=200m');
    expect(s.deployments[0].rollouts).toBe(2);
  });

  it('pause / resume guard against wrong states', () => {
    const s = start('p-release');
    expect(cmd(s, 'kubectl rollout resume deployment/web')).toMatch(/not paused/);
    cmdOk(s, 'kubectl rollout pause deployment/web');
    expect(cmd(s, 'kubectl rollout pause deployment/web')).toMatch(/already paused/);
    expect(cmd(s, 'kubectl rollout restart deployment/web')).toMatch(/can't be restarted while paused/);
  });

  it('restart replaces every pod gradually without dropping requests', () => {
    const s = start('p-release');
    s.mode = 'live';
    const before = new Set(podNames(s, 'web-'));
    cmdOk(s, 'kubectl rollout restart deployment/web');
    sim(s, 30);
    const after = podNames(s, 'web-');
    expect(after).toHaveLength(4);
    expect(after.some(n => before.has(n))).toBe(false);
    expect(s.stats.failed).toBeLessThanOrEqual(1);
  });

  it('undo returns to the previous template including resources', () => {
    const s = start('p-release');
    cmdOk(s, 'kubectl set resources deployment web --requests=cpu=300m');
    cmdOk(s, 'kubectl rollout undo deployment/web');
    expect(s.deployments[0].res.cpu).toBe(100);
  });

  it('patch changes replicas in place and rejects bad patches', () => {
    const s = start('p-release');
    cmdOk(s, `kubectl patch deployment web -p '{"spec":{"replicas":5}}'`);
    expect(s.deployments[0].replicas).toBe(5);
    expect(cmd(s, `kubectl patch deployment web -p '{"spec":{"replicas":99}}'`)).toMatch(/between 0 and 12/);
    expect(cmd(s, `kubectl patch deployment web -p {not-json`)).toMatch(/invalid JSON/);
    expect(cmd(s, `kubectl patch deployment web -p '{"metadata":{}}'`)).toMatch(/only supports/);
    expect(cmd(s, `kubectl patch deployment nope -p '{"spec":{"replicas":2}}'`)).toMatch(/NotFound/);
  });
});
