// The simulated kubectl must behave like the real one where it claims to.
import { describe, expect, it } from 'vitest';
import { KUBECTL_HELP, REAL_COMMANDS, SUPPORTED, USAGE } from '../src/core/cli';
import { cmd, cmdOk, sim, start } from './helpers';

describe('kubectl --help', () => {
  it('prints the real top-level help for bare kubectl, --help, -h and help', () => {
    const s = start('pods');
    const real = cmd(s, 'kubectl --help');
    expect(real).toContain('kubectl controls the Kubernetes cluster manager.');
    expect(real).toContain('Basic Commands (Beginner):');
    expect(real).toContain('Use "kubectl <command> --help" for more information about a given command.');
    for (const form of ['kubectl', 'kubectl -h', 'kubectl help', 'k --help']) expect(cmd(s, form)).toBe(real);
    expect(s.cmdErrors).toBe(0);
  });

  it('lists exactly the commands of the real kubectl', () => {
    expect(REAL_COMMANDS).toEqual([
      'create', 'expose', 'run', 'set', 'explain', 'get', 'edit', 'delete', 'rollout', 'scale', 'autoscale',
      'certificate', 'cluster-info', 'top', 'cordon', 'uncordon', 'drain', 'taint',
      'describe', 'logs', 'attach', 'exec', 'port-forward', 'proxy', 'cp', 'auth', 'debug', 'events',
      'diff', 'apply', 'patch', 'replace', 'wait', 'kustomize', 'label', 'annotate', 'completion',
      'api-resources', 'api-versions', 'config', 'plugin', 'version',
    ]);
    expect(KUBECTL_HELP.length).toBeGreaterThan(60);
  });

  it('only implements commands that exist in real kubectl (no invented verbs like "cost")', () => {
    for (const c of SUPPORTED) expect(REAL_COMMANDS, c).toContain(c);
    expect(SUPPORTED).not.toContain('cost');
    expect(cmd(start('m-cost'), 'kubectl cost')).toMatch(/unknown command "cost"/);
  });

  it('gives usage for every supported command via --help and -h', () => {
    const s = start('pods');
    for (const c of SUPPORTED) {
      expect(USAGE[c], c).toBeDefined();
      expect(cmd(s, `kubectl ${c} --help`)).toBe(USAGE[c].join('\n'));
      expect(cmd(s, `kubectl ${c} -h`)).toBe(USAGE[c].join('\n'));
    }
    expect(s.cmdErrors).toBe(0);
  });

  it('is honest about real commands that are not simulated, and about typos', () => {
    const s = start('pods');
    expect(cmd(s, 'kubectl apply -f x.yaml')).toMatch(/real command, but it is not available in this simulator/);
    expect(cmd(s, 'kubectl attach web')).toMatch(/not available in this simulator/);
    expect(cmd(s, 'kubectl gett pods')).toMatch(/unknown command "gett" for "kubectl"/);
    expect(cmd(s, 'kubectl gett pods')).toMatch(/Did you mean this\?\s+get/);
  });
});

describe('real output formats', () => {
  it('get pods has the real columns; -o wide adds IP and NODE', () => {
    const s = start('deployments');
    cmdOk(s, 'kubectl create deployment web --image=nginx --replicas=2');
    sim(s, 4);
    const plain = cmd(s, 'kubectl get pods').split('\n');
    expect(plain[0]).toMatch(/^NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE$/);
    expect(plain[1]).toMatch(/^web-\w{5}\s+1\/1\s+Running\s+0\s+\d+s$/);
    const wide = cmd(s, 'kubectl get pods -o wide').split('\n');
    expect(wide[0]).toMatch(/AGE\s+IP\s+NODE$/);
    expect(wide[1]).toMatch(/10\.244\.\d+\.\d+\s+node-\d$/);
    expect(cmd(s, 'kubectl get pods -owide')).toBe(cmd(s, 'kubectl get pods --output=wide'));
  });

  it('get pods -l filters by label selector', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl run a --image=nginx --labels=app=one', 'kubectl run b --image=nginx --labels=app=two');
    expect(cmd(s, 'kubectl get pods -l app=one')).toMatch(/^NAME[\s\S]*\na\s/);
    expect(cmd(s, 'kubectl get pods -l app=one')).not.toMatch(/\nb\s/);
    expect(cmd(s, 'kubectl get pods --selector=app=nope')).toMatch(/No resources found/);
  });

  it('get deployments / services / nodes / endpoints / hpa use the real columns', () => {
    const s = start('hpa');
    cmdOk(s, 'kubectl autoscale deployment web --min=2 --max=4');
    expect(cmd(s, 'kubectl get deployments').split('\n')[0]).toMatch(/^NAME\s+READY\s+UP-TO-DATE\s+AVAILABLE\s+AGE$/);
    expect(cmd(s, 'kubectl get svc').split('\n')[0]).toMatch(/^NAME\s+TYPE\s+CLUSTER-IP\s+EXTERNAL-IP\s+PORT\(S\)\s+AGE$/);
    expect(cmd(s, 'kubectl get nodes').split('\n')[0]).toMatch(/^NAME\s+STATUS\s+ROLES\s+AGE\s+VERSION$/);
    expect(cmd(s, 'kubectl get ep').split('\n')[0]).toMatch(/^NAME\s+ENDPOINTS\s+AGE$/);
    expect(cmd(s, 'kubectl get hpa').split('\n')[0]).toMatch(/^NAME\s+REFERENCE\s+TARGETS\s+MINPODS\s+MAXPODS\s+REPLICAS\s+AGE$/);
    expect(cmd(s, 'kubectl get deployments -o wide').split('\n')[0]).toMatch(/CONTAINERS\s+IMAGES\s+SELECTOR$/);
  });

  it('node capacity type is a label, shown with --show-labels', () => {
    const s = start('m-spot');
    cmdOk(s, 'cloud add-node --spot');
    const out = cmd(s, 'kubectl get nodes --show-labels');
    expect(out).toMatch(/LABELS/);
    expect(out).toMatch(/node-3[^\n]*capacity-type=spot/);
    expect(out).toMatch(/node-1[^\n]*capacity-type=on-demand/);
  });

  it('top pods reports CPU(cores) and MEMORY(bytes)', () => {
    const s = start('scaling');
    expect(cmd(s, 'kubectl top pods').split('\n')[0]).toMatch(/^NAME\s+CPU\(cores\)\s+MEMORY\(bytes\)$/);
    expect(cmd(s, 'kubectl top pods')).toMatch(/\d+m\s+\d+Mi/);
    expect(cmd(s, 'kubectl top')).toMatch(/must specify the type of resource/);
  });

  it('events, version and cluster-info exist', () => {
    const s = start('pods');
    cmdOk(s, 'kubectl run web --image=nginx');
    sim(s, 3);
    expect(cmd(s, 'kubectl events')).toMatch(/LAST SEEN\s+TYPE\s+REASON\s+OBJECT\s+MESSAGE[\s\S]*Scheduled\s+Pod\/web/);
    expect(cmd(s, 'kubectl version')).toMatch(/Client Version: v1\.\d+/);
    expect(cmd(s, 'kubectl cluster-info')).toMatch(/Kubernetes control plane is running at/);
  });

  it('rollout status uses the real wording', () => {
    const s = start('rollout');
    cmdOk(s, 'kubectl set image deployment/web web=web:v2');
    expect(cmd(s, 'kubectl rollout status deployment/web')).toMatch(/Waiting for deployment "web" rollout to finish: \d+ out of 4 new replicas have been updated/);
    sim(s, 12);
    expect(cmd(s, 'kubectl rollout status deployment/web')).toBe('deployment "web" successfully rolled out');
  });

  it('drain prints evictions the way kubectl does', () => {
    const s = start('m-trim');
    const out = cmd(s, 'kubectl drain node-1 --ignore-daemonsets');
    expect(out).toMatch(/node\/node-1 cordoned/);
    expect(out).toMatch(/evicting pod default\/shop-\w+/);
    expect(out).toMatch(/node\/node-1 drained/);
  });
});

describe('the cloud console is separate from kubectl', () => {
  it('cloud list-nodes shows type, state and price', () => {
    const s = start('m-spot');
    cmdOk(s, 'cloud add-node --spot');
    const out = cmd(s, 'cloud list-nodes');
    expect(out).toMatch(/NAME\s+TYPE\s+STATE\s+COST\/s/);
    expect(out).toMatch(/node-3\s+spot\s+provisioning\s+\$0\.030/);
    expect(out).toMatch(/node-1\s+on-demand\s+running\s+\$0\.200/);
  });

  it('cloud cost is the bill and marks the objective flag', () => {
    const s = start('m-cost');
    expect(cmd(s, 'cloud cost')).toMatch(/burn rate[\s\S]*Revenue[\s\S]*Profit so far/);
    expect(s.flags.usedCost).toBe(true);
  });
});
