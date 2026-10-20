import { describe, expect, it } from 'vitest';
import { renderHint, splitHint } from '../src/ui/hints';

const cmds = (t: string) => splitHint(t).filter(s => s.cmd).map(s => s.text);

describe('hint commands', () => {
  it('finds commands inside sentences', () => {
    expect(cmds('Check on it with kubectl get pods. Wait for STATUS to say Running.')).toEqual(['kubectl get pods']);
    expect(cmds('kubectl get pods to find a pod name (web-xxxxx), then kubectl delete pod web-xxxxx. Watch a replacement appear.')).toEqual(['kubectl get pods', 'kubectl delete pod web-xxxxx']);
    expect(cmds('kubectl get endpoints (or kubectl describe service web) shows which pods back it.')).toEqual(['kubectl get endpoints', 'kubectl describe service web']);
    expect(cmds('kubectl describe quota team-quota -n team-a (the -n is needed).')).toEqual(['kubectl describe quota team-quota -n team-a']);
    expect(cmds('kubectl expose deployment nginx --port 80 --type NodePort, then curl -I http://node:30080')).toEqual(['kubectl expose deployment nginx --port 80 --type NodePort', 'curl -I http://node:30080']);
  });

  it('keeps quoted text, $( ) and chained commands together', () => {
    expect(cmds("kubectl patch cronjob backup -p '{\"spec\":{\"suspend\":true}}'")).toEqual(["kubectl patch cronjob backup -p '{\"spec\":{\"suspend\":true}}'"]);
    expect(cmds('export ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)   then   echo $ENCRYPTION_KEY')).toEqual(['export ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)', 'echo $ENCRYPTION_KEY']);
    expect(cmds('mv etcd.service /etc/systemd/system/ ; systemctl daemon-reload ; systemctl enable etcd')).toEqual(['mv etcd.service /etc/systemd/system/ ; systemctl daemon-reload ; systemctl enable etcd']);
    expect(cmds('for host in node-0 node-1; do ssh root@${host} mkdir /x; done')).toEqual(['for host in node-0 node-1; do ssh root@${host} mkdir /x; done']);
  });

  it('ignores ordinary words that look like commands', () => {
    expect(cmds('Wait for it to finish, then look for the Service.')).toEqual([]);
    expect(cmds('It refuses while pods remain, which is a safety net.')).toEqual([]);
  });

  it('renders clickable spans and escapes HTML', () => {
    const html = renderHint('Run kubectl get pods -o jsonpath="{.items[*].metadata.name}".');
    expect(html).toContain('class="hcmd"');
    expect(html).toContain('data-cmd="kubectl get pods -o jsonpath=&quot;{.items[*].metadata.name}&quot;"');
    expect(renderHint('a < b & c')).toBe('a &lt; b &amp; c');
  });
});
