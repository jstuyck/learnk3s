// Shared types for the cluster simulation, the CLI and the campaign data.

export type Phase =
  | 'Pending'
  | 'ContainerCreating'
  | 'Running'
  | 'CrashLoopBackOff'
  | 'ImagePullBackOff'
  | 'Terminating'
  | 'Unknown'
  | 'Completed'
  | 'Error';

export interface PodEvent {
  t: number;
  type: 'Normal' | 'Warning';
  reason: string;
  msg: string;
}

export interface Request {
  stage: 'toSvc' | 'toPod' | 'proc';
  t: number;
  svc: Service | undefined;
  pod: Pod | null;
  dead: boolean;
  endAt?: number;
}

export type Labels = Record<string, string>;

export interface Pod {
  id: number;
  name: string;
  /** value of the "app" label (kept in sync with labels.app) */
  app: string;
  labels: Labels;
  image: string;
  tpl: string;
  config: string | null;
  secret: string | null;
  /** Deployment name, or "job/NAME" for pods created by a Job; null for bare pods */
  owner: string | null;
  node: string | null;
  /** node a finished (Completed / Error) pod ran on; such pods hold no slot */
  ranOn: string | null;
  slot: number;
  phase: Phase;
  phaseT: number;
  age: number;
  restarts: number;
  busy: Request[];
  util: number;
  logs: string[];
  /** e.g. OOMKilled */
  reason: string;
  events: PodEvent[];
  warned: boolean;
  cpuReq: number;
  /** memory limit in Mi, null = unlimited */
  memLimit: number | null;
  command: string[];
  /** seconds the container runs before exiting (jobs, `run --restart=Never`); undefined = runs forever */
  runFor?: number;
  /** why a finished Job pod failed (command or image) */
  willFail?: boolean;
}

export interface ClusterNode {
  name: string;
  slots: number;
  spot: boolean;
  down: boolean;
  downUntil: number;
  bootUntil: number;
  unsched: boolean;
  announced: boolean;
}

export interface Resources {
  /** CPU request in millicores */
  cpu: number;
  /** memory limit in Mi, null = none */
  mem: number | null;
}

export interface RevisionEntry {
  image: string;
  config: string | null;
  secret: string | null;
  res: Resources;
  restart: number;
}

export interface Deployment {
  name: string;
  app: string;
  image: string;
  config: string | null;
  secret: string | null;
  res: Resources;
  /** bumped by `kubectl rollout restart` */
  restart: number;
  /** while paused, new pods use this template and no rollout happens */
  frozen: RevisionEntry | null;
  replicas: number;
  createdAt: number;
  history: RevisionEntry[];
  /** number of rollouts triggered so far (template changes that were rolled out) */
  rollouts: number;
}

export interface Service {
  name: string;
  selector: Labels;
  port: number;
  targetPort: number;
  createdAt: number;
  ip: string;
  /** set for `--type=NodePort`: the port opened on every node */
  nodePort?: number;
}

export interface KeyValueObject {
  name: string;
  data: Record<string, string>;
}

export interface Job {
  name: string;
  image: string;
  command: string[];
  status: 'Running' | 'Complete' | 'Failed';
  /** CronJob that created it */
  owner: string | null;
  createdAt: number;
  doneAt: number | null;
  nextTry: number;
}

export interface CronJob {
  name: string;
  schedule: string;
  /** seconds between runs (1 simulated minute = 10 seconds) */
  period: number;
  image: string;
  command: string[];
  suspend: boolean;
  createdAt: number;
  nextRun: number;
  lastSchedule: number | null;
  counter: number;
}

export interface Hpa {
  dep: string;
  min: number;
  max: number;
  cpu: number;
  lastScale: number;
  current: number;
  created: number;
  recs?: { t: number; d: number }[];
}

export interface Econ {
  price: number;
  podCost: number;
  nodeCost: number;
  spotCost: number;
  penalty: number;
  bankrupt: number;
  maxNodes: number;
  target: number;
  duration: number;
  /** profit needed for [2 stars, 3 stars] */
  stars: [number, number];
}

export interface TrafficSegment {
  from: number;
  to: number;
  rps: number;
}

export interface Traffic {
  /** name of the Service users call (falls back to a Service selecting app=<this>) */
  app: string;
  profile: TrafficSegment[];
  /** requests may fail until this many have; then the mission is lost */
  maxFail: number;
  /** failed-request thresholds for [3 stars, 2 stars] (non-economy missions) */
  stars: [number, number];
  /** start sending traffic immediately instead of waiting for the player */
  auto?: boolean;
}

export interface Objective {
  id: string;
  text: string;
  check(s: State): boolean;
}

export interface LevelEvent {
  /** fire at this many seconds of live traffic ... */
  at?: number;
  /** ... or `delay` seconds after this becomes true */
  when?: (s: State) => boolean;
  delay?: number;
  run(s: State): void;
}

export interface Codex {
  title: string;
  text: string;
}

/** One step of a guided tutorial: a command to run and an explanation of what it does and why. */
export interface TutorialStep {
  title: string;
  cmd: string;
  /** HTML */
  why: string;
}

export interface Level {
  id: string;
  title: string;
  tag: string;
  blurb: string;
  nodes: number;
  slots: number;
  traffic: Traffic | null;
  econ?: Econ;
  setup?(s: State): void;
  /** Hard Way missions: the terminal is a Linux shell on the lab machines, and there are no system pods */
  hardway?: 'machines' | 'cluster';
  /** guided steps shown instead of hints (the Hard Way is a tutorial, not a challenge) */
  tutorial?: TutorialStep[];
  story: string;
  objectives: Objective[];
  /** "command | what it does" - deliberately without arguments */
  cheats: string[];
  hints: string[];
  events?: LevelEvent[];
  codex: Codex;
}

export interface Campaign {
  id: string;
  name: string;
  sub: string;
  /** which title-screen mode shows this campaign */
  mode: 'campaign' | 'profit';
  levels: Level[];
}

export interface Line {
  t: string;
  c?: string;
}

export interface Fx {
  kind: 'fail' | 'ok';
  where: 'users' | 'svc' | 'pod';
  svc?: Service;
  pod?: Pod | null;
  t: number;
}

export interface Flags {
  usedGet?: boolean;
  describedPod?: boolean;
  deletedBare?: boolean;
  deletedOwned?: string;
  selfHealed?: boolean;
  inspectedCrash?: boolean;
  undone?: boolean;
  badRelease?: boolean;
  usedCost?: boolean;
  drained?: boolean;
  addedNode?: boolean;
  removedNode?: boolean;
  usedCompletion?: boolean;
  readJobLogs?: boolean;
  manualJob?: boolean;
  suspendedCron?: boolean;
  describedService?: boolean;
  fixedSelector?: boolean;
  labeledPod?: boolean;
  usedExec?: boolean;
  portForwarded?: boolean;
  pausedRollout?: boolean;
  resumedRollout?: boolean;
  restartedRollout?: boolean;
  patched?: boolean;
  setResources?: boolean;
  /** rollouts that started while the Deployment was paused (should stay 0) */
  rolloutWhilePaused?: boolean;
  ranKubectl?: boolean;
  listedNodes?: boolean;
  inspectedCert?: boolean;
  usedEtcdctl?: boolean;
  curledApi?: boolean;
  jumpboxKubectl?: boolean;
  checkedEncryption?: boolean;
  readPodLogs?: boolean;
  curledNodePort?: boolean;
  listedNamespaces?: boolean;
  usedAllNamespaces?: boolean;
  listedSystemPods?: boolean;
  inspectedSystemPod?: boolean;
  createdNamespace?: boolean;
  /** scale with a --current-replicas precondition that held */
  guardedScale?: boolean;
  usedJsonpath?: boolean;
  usedCustomColumns?: boolean;
  usedSortBy?: boolean;
  usedFieldSelector?: boolean;
  usedOutputName?: boolean;
  usedJsonYaml?: boolean;
  /** most pods removed by a single delete command */
  bulkDeleted?: number;
  inspectedRevision?: boolean;
  undoneToRevision?: number;
  filteredEvents?: boolean;
  usedLogsSelector?: boolean;
  usedPrevious?: boolean;
  usedTopNodes?: boolean;
  usedTopSort?: boolean;
}

export interface State {
  level: Level;
  rng: () => number;
  t: number;
  tt: number;
  mode: 'prep' | 'live';
  nodes: ClusterNode[];
  pods: Pod[];
  deployments: Deployment[];
  services: Service[];
  configmaps: KeyValueObject[];
  secrets: KeyValueObject[];
  hpas: Hpa[];
  jobs: Job[];
  cronjobs: CronJob[];
  /** namespaces created by the player (besides default and the system ones) */
  namespaces?: string[];
  /** Kubernetes the Hard Way: the machines, files and services of the hand-built cluster */
  hw?: import('./hardway').HardWay;
  /** index of the tutorial step the player is on */
  tutStep?: number;
  money: { rev: number; cost: number; pen: number };
  recent: number[];
  nodeSeq: number;
  reqs: Request[];
  fx: Fx[];
  msgs: Line[];
  stats: { sent: number; served: number; failed: number };
  flags: Flags;
  done: Record<string, boolean>;
  peak: Record<string, number>;
  cmdErrors: number;
  hintsUsed: number;
  nextId: number;
  acc: { spawn: number; recon: number; obj: number; hpa: number };
  evFired: Record<number, boolean>;
  evArmed: Record<number, number>;
  banner: { text: string; until: number } | null;
  cpPulse: number;
  outcome: 'win' | 'fail' | null;
  failReason: string;
}
