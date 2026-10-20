# learnk3s

**Play it online: https://jstuyck.github.io/learnk3s/**

A 2D browser game that teaches Kubernetes. Four campaigns, a simulated `kubectl` terminal with Tab completion, history and Ctrl+R.

The terminal only accepts real `kubectl` commands, with real flags and output columns (`kubectl --help` prints the real help). Real commands the simulator does not implement (`apply`, `exec`, ...) say so. Money-related things live in a separate `cloud` console (`cloud cost`, `cloud add-node`, `cloud remove-node`, `cloud list-nodes`), since kubectl has no such commands.

**Campaign mode**
- **Rookie** (8 missions): pods, deployments, services, scaling, autoscaling, rollouts, ConfigMaps, node failure.
- **Practitioner** (6 missions): everyday intermediate kubectl: Jobs (`create job`), CronJobs (`create cronjob`, `--from=cronjob/`, `patch`), labels & selectors (`label`, `set selector`, `--show-labels`, `-l`), requests/limits (`set resources`, OOMKilled, Insufficient cpu), debugging (`exec`, `port-forward`, `--target-port`), and `rollout pause|resume|restart`.

- **Elite** (6 missions): advanced kubectl. Structured output (`-o json|yaml|name|jsonpath|custom-columns`, `--sort-by`, `--field-selector`), bulk deletes by selector, `--current-replicas` scale guards, `rollout history --revision` / `undo --to-revision`, forensics (`events --types --for`, `logs -l|--previous|--tail|deployment/NAME`), capacity analysis (`top nodes`, `top pods --sort-by`), and a final incident.

- **The Hard Way** (12 missions): [Kubernetes The Hard Way](https://github.com/kelseyhightower/kubernetes-the-hard-way) as a game. The terminal becomes a Linux shell on four machines (`jumpbox`, `server`, `node-0`, `node-1`): clone the guide, download the binaries, set up SSH and DNS, build a CA and eight certificates with `openssl`, write kubeconfigs, encrypt Secrets, run etcd, the API server, controller manager and scheduler as systemd services, turn two blank machines into nodes (containerd, kubelet, kube-proxy, CNI), add pod routes, and smoke-test the result. Services only start if the files really are where the guide puts them, so a missing certificate, a forgotten `swapoff` or a wrong node certificate fails with a realistic message in `systemctl status` / `journalctl -u`. The shell supports variables, `$(...)`, pipes, redirects, globs, brace expansion and `for` / `while read` loops, so the guide's commands work as typed (no heredocs or interactive editors).

**Namespaces and system pods**: `kubectl get namespaces`, `-n NAMESPACE` and `-A` / `--all-namespaces` work. The cluster has `kube-system` with CoreDNS, etcd, the API server, scheduler, controller manager, and one kube-proxy and CNI pod per node (plus the `kube-dns` Service and DaemonSets), which never compete with your workloads for slots. `describe` and `logs` work on them; creating workloads in other namespaces is not simulated.

**Profit Mode** (6 missions, its own button on the title screen): the same cluster, but every pod and node costs money and every served request earns it. Cost basics, draining nodes, cluster capacity, Secrets, spot nodes, and a final exam.

## Play

```
npm install
npm run build        # bundles src/ into dist/
```

Open `dist/index.html` in a browser (works from `file://`). `?unlock` in the URL unlocks every mission.

## Develop

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict) over `src/` and `tests/` |
| `npm test` | vitest: unit, simulation, playthrough and robustness tests |
| `npm run build` | esbuild bundle to `dist/game.js` + copies `public/` |
| `npm run watch` | rebuild the bundle on change |
| `npm run check` | typecheck, test, build |

## Layout

```
public/            index.html, style.css (copied to dist/)
scripts/build.mjs  esbuild bundling
src/
  core/            the game engine; no DOM access, fully testable
    sim.ts           cluster simulation: scheduler, controllers, Jobs/CronJobs, HPA, traffic, events, objectives
    cli.ts           the kubectl / cloud interpreter (help, dispatch, core commands)
    cmd-batch.ts     Job and CronJob commands
    cmd-advanced.ts  label, set selector/resources, rollout pause/resume/restart, patch, exec, port-forward
    ctx.ts           argument parsing, shell-style word splitting, shared command context
    completion.ts    Tab completion
    economy.ts       profit, burn rate, revenue rate
    scoring.ts       star ratings
    format.ts        kubectl-style tables
    rng.ts           seedable PRNG (tests are deterministic)
    types.ts         shared types
  data/            images.ts (container catalog), levels-rookie.ts, levels-operator.ts, campaigns.ts
  ui/              render.ts (canvas), main.ts (screens, loop), shell.ts (terminal input),
                   history.ts, save.ts
tests/             vitest suites (see below)
```

## Tests

- `cli`, `sim`, `practitioner`, `real-kubectl`, `completion`, `ui-units`: behaviour of the engine and UI support code.
- `campaign-rookie`, `campaign-practitioner`, `campaign-profit`: full playthroughs. A sensible player wins, a careless one fails.
- `robustness`: the sensible strategies must win across 20 random seeds. This is what keeps the economy calibrated; change numbers in `levels-profit.ts` and this suite tells you if you broke the balance.
- `levels`, `html`, `render`: data integrity, DOM ids, renderer smoke test.

## Adding a mission

1. Add a `Level` to `src/data/levels-*.ts` (`setup`, `objectives`, optional `traffic`, `econ`, `events`).
2. `npm test`: `levels.test.ts` validates it automatically; add a playthrough to the matching `campaign-*.test.ts`.
