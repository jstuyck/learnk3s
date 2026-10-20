// The Elite campaign: advanced kubectl output, bulk operations, revisions, forensics and capacity.
import { describe, expect, it } from 'vitest';
import { jsonpath, toYaml } from '../src/core/cmd-elite';
import { calcStars } from '../src/core/scoring';
import { cmd, cmdOk, finish, openTraffic, podNames, sim, start } from './helpers';

describe('jsonpath and yaml', () => {
  const root = { items: [{ metadata: { name: 'a', labels: { 'k.io/x': '1' } }, n: 3, c: [{ type: 'Ready', status: 'True' }] }, { metadata: { name: 'b' }, n: 5, c: [{ type: 'Ready', status: 'False' }] }] };
  it('selects, indexes and loops', () => {
    expect(jsonpath('{.items[*].metadata.name}', root)).toBe('a b');
    expect(jsonpath("'{.items[1].n}'", root)).toBe('5');
    expect(jsonpath('{range .items[*]}{.metadata.name}={.n}{"\\n"}{end}', root)).toBe('a=3\nb=5\n');
    expect(jsonpath("{.items[0].metadata.labels['k.io/x']}", root)).toBe('1');
    expect(jsonpath('{.items[*].c[?(@.type=="Ready")].status}', root)).toBe('True False');
    expect(jsonpath('{.items[*].missing}', root)).toBe('');
  });
  it('rejects broken templates', () => {
    expect(() => jsonpath('{.items[', root)).toThrow();
    expect(() => jsonpath('{range .items[*]}{.n}', root)).toThrow();
  });
  it('prints yaml', () => {
    expect(toYaml({ a: 1, b: { c: 'x', d: [1, { e: 2 }] }, f: {}, g: 'true' }).join('\n')).toBe('a: 1\nb:\n  c: x\n  d:\n  - 1\n  - e: 2\nf: {}\ng: "true"');
  });
});

describe('structured kubectl get', () => {
  it('formats output', () => {
    const s = start('e-query');
    const pod = podNames(s, 'web-')[0];
    expect(cmd(s, 'kubectl get pods -o name').split('\n')).toHaveLength(9);
    expect(cmd(s, 'kubectl get pods -o name')).toContain('pod/' + pod);
    expect(cmd(s, `kubectl get pods -o jsonpath='{.items[*].spec.containers[0].image}'`).split(' ').sort()).toEqual(
      ['busybox', 'busybox', 'nginx', 'nginx', 'nginx', 'nginx', 'nginx', 'web:v2-broken', 'web:v2-broken']);
    expect(cmd(s, `kubectl get pod ${pod} -o jsonpath='{.status.phase}'`)).toBe('Running');
    expect(cmd(s, 'kubectl get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName')).toMatch(/^NAME\s+NODE\n/);
    expect(cmd(s, `kubectl get pod ${pod} -o yaml`)).toMatch(/kind: Pod[\s\S]*phase: Running/);
    expect(JSON.parse(cmd(s, `kubectl get pod ${pod} -o json`)).metadata.name).toBe(pod);
    expect(cmd(s, 'kubectl get nodes -o name')).toBe('node/node-1\nnode/node-2\nnode/node-3');
    expect(cmd(s, 'kubectl get deploy -o name')).toContain('deployment.apps/web');
    expect(cmd(s, `kubectl get nodes -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}'`)).toBe('True True True');
    expect(s.cmdErrors).toBe(0);
  });

  it('sorts and filters', () => {
    const s = start('e-query');
    const names = cmd(s, 'kubectl get pods --sort-by=.metadata.name').split('\n').slice(1).map(l => l.split(/\s+/)[0]);
    expect(names).toEqual([...names].sort());
    // crash-looping pods still have phase Running in the API
    expect(cmd(s, 'kubectl get pods --field-selector=status.phase=Running -o name').split('\n')).toHaveLength(9);
    expect(cmd(s, 'kubectl get pods --field-selector=status.phase=Pending')).toMatch(/No resources found/);
    expect(cmd(s, 'kubectl get pods --field-selector=spec.nodeName=node-1 -o name').split('\n').every(l => l.startsWith('pod/'))).toBe(true);
    expect(cmd(s, 'kubectl get pods --field-selector=spec.foo=1')).toMatch(/field label not supported/);
    expect(cmd(s, 'kubectl get pods --sort-by=.nope')).toMatch(/couldn't find any field/);
    expect(cmd(s, 'kubectl get pod nope -o name')).toMatch(/NotFound/);
    expect(cmd(s, 'kubectl get pods -o weird')).toMatch(/unable to match a printer/);
    expect(cmd(s, `kubectl get pods -o jsonpath='{.items['`)).toMatch(/error parsing jsonpath/);
  });
});

describe('Elite campaign', () => {
  it('1. Needle in a Haystack', () => {
    const s = start('e-query');
    const pod = podNames(s, 'web-')[0];
    cmdOk(s, 'kubectl get pods -o name', `kubectl get pod ${pod} -o yaml`, `kubectl get pods -o jsonpath='{.items[*].spec.containers[0].image}'`,
      'kubectl get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName', 'kubectl get pods --sort-by=.metadata.name',
      'kubectl get pods --field-selector=spec.nodeName=node-1');
    expect(s.outcome).toBeNull();
    cmdOk(s, 'kubectl set image deployment/search search=web:v2');
    finish(s, 40);
    expect(s.outcome).toBe('win');
  });

  it('2. Spring Cleaning', () => {
    const t = start('e-clean');
    cmdOk(t, 'kubectl get pods --field-selector=spec.nodeName=node-3');
    expect(cmd(t, 'kubectl delete pods -l env=test loadtest-1')).toMatch(/cannot specify pod names/);
    cmdOk(t, 'kubectl delete pods -l env=test');
    sim(t, 4);
    expect(t.pods.filter(p => p.labels.env === 'staging')).toHaveLength(3);
    expect(cmd(t, 'kubectl scale deployment shop --replicas=6 --current-replicas=9')).toMatch(/Expected replicas to be 9, was 3/);
    cmdOk(t, 'kubectl scale deployment shop --replicas=6 --current-replicas=3');
    sim(t, 6);
    openTraffic(t);
    finish(t, 120);
    expect(t.outcome).toBe('win');
    expect(calcStars(t)).toBeGreaterThanOrEqual(2);
  });

  it('2. Spring Cleaning: deleting everything with --all loses the staging pods', () => {
    const s = start('e-clean');
    cmdOk(s, 'kubectl get pods --field-selector=spec.nodeName=node-3', 'kubectl delete pods --all');
    sim(s, 4);
    cmdOk(s, 'kubectl scale deployment shop --replicas=6 --current-replicas=3');
    sim(s, 8);
    openTraffic(s);
    sim(s, 60);
    expect(s.outcome).toBeNull();
    expect(s.done.bulk).toBeUndefined();
  });

  it('delete: several names, pod/name form, and nothing matching', () => {
    const s = start('e-clean');
    cmdOk(s, 'kubectl delete pod loadtest-1 loadtest-2', 'kubectl delete pod/loadtest-3 pod/loadtest-4');
    expect(s.flags.bulkDeleted).toBe(2);
    expect(cmd(s, 'kubectl delete pods -l env=nothing')).toMatch(/No resources found/);
    expect(cmd(s, 'kubectl delete pod loadtest-5 ghost')).toMatch(/NotFound/);
    expect(s.pods.find(p => p.name === 'loadtest-5')!.phase).toBe('Running');
  });

  it('3. Time Machine: --to-revision wins', () => {
    const s = start('e-time');
    expect(cmd(s, 'kubectl rollout history deployment/web')).toMatch(/web:v3-broken/);
    expect(cmd(s, 'kubectl rollout history deployment/web --revision=2')).toMatch(/revision #2[\s\S]*web:v2/);
    expect(cmd(s, 'kubectl rollout history deployment/web --revision=9')).toMatch(/unable to find/);
    expect(cmd(s, 'kubectl rollout undo deployment/web --to-revision=9')).toMatch(/unable to find/);
    expect(cmd(s, 'kubectl rollout undo deployment/web --to-revision=4')).toMatch(/skipped rollback/);
    sim(s, 3);
    expect(s.pods.some(p => p.phase === 'CrashLoopBackOff')).toBe(true);
    cmdOk(s, 'kubectl rollout undo deployment/web --to-revision=2');
    sim(s, 20);
    cmdOk(s, 'kubectl rollout status deployment/web');
    openTraffic(s);
    finish(s, 120);
    expect(s.outcome).toBe('win');
  });

  it('3. Time Machine: undo one step lands on another broken revision', () => {
    const s = start('e-time');
    cmdOk(s, 'kubectl rollout history deployment/web --revision=2', 'kubectl rollout undo deployment/web');
    sim(s, 20);
    expect(s.done.undo).toBeUndefined();
    expect(s.pods.some(p => p.phase === 'CrashLoopBackOff')).toBe(true);
  });

  it('4. Detective Work', () => {
    const s = start('e-detect');
    sim(s, 3);
    expect(cmd(s, 'kubectl events --types=Bogus')).toMatch(/must be Normal and\/or Warning/);
    const warn = cmd(s, 'kubectl events --types=Warning');
    expect(warn).toMatch(/Warning/);
    expect(warn).not.toMatch(/\bNormal\b/);
    const pod = podNames(s, 'billing-')[0];
    expect(cmd(s, `kubectl events --for=pod/${pod}`)).toContain('Pod/' + pod);
    expect(cmd(s, 'kubectl events --for=deployment/billing')).toContain('Pod/' + pod);
    expect(cmd(s, 'kubectl logs -l app=billing')).toMatch(/\[pod\/billing-.*\] FATAL: environment variable API_KEY/);
    expect(cmd(s, 'kubectl logs -l app=search --tail=1').split('\n')).toHaveLength(2);
    expect(cmd(s, `kubectl logs ${pod} --previous`)).toMatch(/FATAL/);
    expect(cmd(s, `kubectl logs ${podNames(s, 'web-')[0]} --previous`)).toMatch(/BadRequest/);
    expect(cmd(s, 'kubectl logs deployment/search')).toMatch(/Found 2 pods, using pod\/search-/);
    cmdOk(s, 'kubectl set resources deployment cart --limits=memory=256Mi',
      'kubectl create secret generic pay --from-literal=API_KEY=sk_live_9f2c41', 'kubectl set env deployment/billing --from=secret/pay',
      'kubectl rollout undo deployment/search');
    finish(s, 60);
    expect(s.outcome).toBe('win');
  });

  it('5. Capacity Planner', () => {
    const s = start('e-capacity');
    sim(s, 3);
    expect(s.pods.filter(p => p.owner === 'web' && p.phase === 'Pending')).toHaveLength(6);
    expect(cmd(s, 'kubectl top nodes')).toMatch(/NAME\s+CPU\(cores\)\s+CPU%\s+MEMORY\(bytes\)\s+MEMORY%/);
    expect(cmd(s, 'kubectl top pods --sort-by=bogus')).toMatch(/accepts only cpu or memory/);
    cmdOk(s, 'kubectl top pods --sort-by=cpu', 'kubectl top pods --sort-by=memory', 'kubectl describe node node-1');
    cmdOk(s, 'kubectl set resources deployment hog --requests=cpu=200m');
    sim(s, 40);
    expect(s.done.rightsize && s.done.web).toBe(true);
    cmdOk(s, 'kubectl drain node-3');
    sim(s, 10);
    openTraffic(s);
    finish(s, 120);
    expect(s.outcome).toBe('win');
  });

  it('5. Capacity Planner: doing nothing never wins', () => {
    const s = start('e-capacity');
    sim(s, 60);
    expect(s.outcome).toBeNull();
    expect(cmd(s, 'kubectl top nodes')).toContain('node-3');
  });

  it('6. Black Friday: prepared player wins, passive player fails', () => {
    const good = start('e-finale');
    cmdOk(good, `kubectl get pods -o jsonpath='{.items[*].spec.nodeName}'`, 'kubectl autoscale deployment web --min=8 --max=10');
    sim(good, 10);
    openTraffic(good);
    sim(good, 13);                       // the broken release lands at 12s
    expect(good.pods.some(p => p.image === 'web:v3-broken')).toBe(true);
    cmdOk(good, 'kubectl events --types=Warning', 'kubectl rollout undo deployment/web');
    finish(good, 200);
    expect(good.outcome).toBe('win');

    const bad = start('e-finale');
    openTraffic(bad);
    finish(bad, 200);
    expect(bad.outcome).toBe('fail');
  });
});
