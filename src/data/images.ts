/**
 * Image catalog: what happens when a container with this image starts.
 *   (unlisted)  -> ImagePullBackOff
 *   crash       -> CrashLoopBackOff (Error for Job pods), logs = crash lines
 *   needs       -> crashes unless the right value arrives in that env var,
 *                  from a ConfigMap (default) or a Secret (src: 'secret')
 *   memNeed     -> OOMKilled when the container's memory limit (Mi) is lower
 *   port        -> the TCP port the server listens on (default 80)
 */
export interface ImageSpec {
  crash?: string[];
  needs?: string;
  value?: string;
  src?: 'configmap' | 'secret';
  memNeed?: number;
  port?: number;
}

const PANIC = [
  'panic: runtime error: invalid memory address or nil pointer dereference',
  'goroutine 1 [running]: main.handler() at handler.go:42',
];

export const IMAGES: Record<string, ImageSpec> = {
  nginx: {},
  'nginx:latest': {},
  'nginx:1.25': {},
  'nginx:1.26': {},
  busybox: {},
  'busybox:1.36': {},
  toolbox: {},
  'web:v1': {},
  'web:v2': {},
  'web:v3': {},
  'web:v2-broken': { crash: PANIC },
  'web:v3-broken': { crash: PANIC },
  'api:v1': { needs: 'DB_URL', value: 'postgres://db.internal:5432/app', port: 8080 },
  'api:v3': { memNeed: 128, port: 8080 },
  'pay:v1': { needs: 'API_KEY', value: 'sk_live_9f2c41', src: 'secret' },
  'report:v1': {
    crash: [
      'Traceback (most recent call last):',
      '  File "report.py", line 31, in <module>',
      "KeyError: 'quarter'   (report v1 forgets to default the quarter; fixed in report:v2)",
    ],
  },
  'report:v2': {},
};

/** Port an image listens on. */
export const portOf = (image: string): number => IMAGES[image]?.port ?? 80;
