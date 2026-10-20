import { describe, expect, it } from 'vitest';
import { commonPrefix, completeLine } from '../src/core/completion';
import { cmdOk, sim, start } from './helpers';

const opts = (id: string, line: string, setup?: (s: ReturnType<typeof start>) => void) => {
  const s = start(id);
  setup?.(s);
  return completeLine(s, line).options;
};

describe('Tab completion', () => {
  it('completes the first word and the verb', () => {
    expect(opts('pods', 'kub')).toEqual(['kubectl']);
    expect(opts('pods', 'cl')).toEqual(['cloud', 'clear']);
    expect(opts('pods', 'kubectl s').sort()).toEqual(['scale', 'set']);
    expect(opts('pods', 'kubectl ')).toContain('drain');
    expect(opts('pods', 'k get')).toEqual(['get']);
  });

  it('completes resource kinds and their aliases', () => {
    expect(opts('pods', 'kubectl get ')).toEqual(['pods', 'deployments', 'services', 'nodes', 'configmaps', 'secrets', 'hpa', 'endpoints', 'jobs', 'cronjobs', 'all']);
    expect(opts('pods', 'kubectl get po')).toEqual(['pods', 'po']);
    expect(opts('pods', 'kubectl describe sec')).toEqual(['secret']);
  });

  it('completes live object names', () => {
    const run = (s: ReturnType<typeof start>) => { cmdOk(s, 'kubectl create deployment web --image=nginx --replicas=2'); sim(s, 1); };
    const names = opts('deployments', 'kubectl delete pod ', run);
    expect(names).toHaveLength(2);
    expect(names.every(n => n.startsWith('web-'))).toBe(true);
    expect(opts('deployments', 'kubectl scale deployment w', run)).toEqual(['web']);
    expect(opts('deployments', 'kubectl rollout undo deployment/', run)).toEqual(['deployment/web']);
    expect(opts('deployments', 'kubectl get pods w', run)).toHaveLength(2); // get pods <name>
    expect(opts('deployments', 'kubectl get pods x', run)).toEqual([]);
  });

  it('completes flags and flag values', () => {
    expect(opts('pods', 'kubectl create deployment x --im')).toEqual(['--image=']);
    expect(opts('pods', 'kubectl run x --image=ngin')).toEqual(['--image=nginx', '--image=nginx:latest', '--image=nginx:1.25', '--image=nginx:1.26']);
    expect(opts('pods', 'kubectl set image deployment/web web=web:v2-')).toEqual(['web=web:v2-broken']);
    expect(opts('config', 'kubectl set env deployment/api --from=conf', s => cmdOk(s, 'kubectl create configmap c --from-literal=A=1')))
      .toEqual(['--from=configmap/c']);
    expect(opts('config', 'kubectl set env deployment/api --from=', s => cmdOk(s, 'kubectl create configmap c --from-literal=A=1', 'kubectl create secret generic k --from-literal=A=1')))
      .toEqual(['--from=configmap/c', '--from=secret/k']);
    expect(opts('config', 'kubectl set env deployment/api --from=configmap/', s => cmdOk(s, 'kubectl create configmap c --from-literal=A=1')))
      .toEqual(['--from=configmap/c']);
    expect(opts('config', 'kubectl set env deployment/api --from=secret/', s => cmdOk(s, 'kubectl create secret generic k --from-literal=A=1')))
      .toEqual(['--from=secret/k']);
  });

  it('completes -o values and secret subcommands', () => {
    expect(opts('pods', 'kubectl get pods -o ')).toEqual(['wide', 'name', 'json', 'yaml', 'jsonpath=', 'custom-columns=']);
    expect(opts('pods', 'kubectl get pods -o j')).toEqual(['json', 'jsonpath=']);
    expect(opts('pods', 'kubectl top ')).toEqual(['pods', 'nodes']);
    expect(opts('pods', 'kubectl top pods --sort-by=')).toEqual(['--sort-by=cpu', '--sort-by=memory']);
    expect(opts('pods', 'kubectl events --types=')).toEqual(['--types=Warning', '--types=Normal']);
    expect(opts('pods', 'kubectl get pods --sort')).toEqual(['--sort-by=']);
    expect(opts('pods', 'kubectl get pods --output=w')).toEqual(['--output=wide']);
    expect(opts('pods', 'kubectl create secret ')).toEqual(['generic']);
  });

  it('completes the cloud console', () => {
    expect(opts('m-trim', 'cloud ')).toEqual(['add-node', 'remove-node', 'list-nodes', 'cost']);
    expect(opts('m-trim', 'cloud remove-node node-')).toEqual(['node-1', 'node-2', 'node-3', 'node-4']);
    expect(opts('m-trim', 'cloud add-node --s')).toEqual(['--spot']);
    expect(opts('m-trim', 'kubectl drain node-1')).toEqual(['node-1']);
  });

  it('reports where the completed token starts', () => {
    const s = start('pods');
    expect(completeLine(s, 'kubectl get po').start).toBe('kubectl get '.length);
    expect(completeLine(s, 'kubectl ').start).toBe('kubectl '.length);
  });

  it('commonPrefix finds the longest shared prefix', () => {
    expect(commonPrefix(['nginx', 'nginx:1.25', 'nginx:latest'])).toBe('nginx');
    expect(commonPrefix(['web-abc', 'web-abd'])).toBe('web-ab');
    expect(commonPrefix([])).toBe('');
  });
});
