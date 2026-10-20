// Bundles src/ui/main.ts into dist/game.js (a plain script that also works from file://)
// and copies the static files from public/ next to it.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

const options = {
  entryPoints: ['src/ui/main.ts'],
  outfile: 'dist/game.js',
  bundle: true,
  format: 'iife',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
};

const copyStatic = () => cpSync('public', 'dist', { recursive: true });

if (watch) {
  copyStatic();
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching src/ ... (re-run `npm run build` to refresh public/ files)');
} else {
  await build(options);
  copyStatic();
  console.log('built dist/ - open dist/index.html');
}
