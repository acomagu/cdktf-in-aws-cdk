import esbuild from 'esbuild';
import pkg from './package.json' with { type: 'json' };

await esbuild.build({
  bundle: true,
  entryPoints: ['./src/index.ts'],
  outdir: './dist',
  outExtension: { '.js': '.mjs' },
  sourcemap: 'inline',
  platform: 'node',
  external: Object.keys(pkg.peerDependencies),
  format: 'esm',
  banner: {
    js: 'import { createRequire } from "module"; import url from "url"; const require = createRequire(import.meta.url); const __filename = url.fileURLToPath(import.meta.url); const __dirname = url.fileURLToPath(new URL(".", import.meta.url));',
  },
});

await esbuild.build({
  bundle: true,
  entryPoints: ['./src/index.ts'],
  outdir: './dist',
  outExtension: { '.js': '.cjs' },
  sourcemap: 'inline',
  platform: 'node',
  external: Object.keys(pkg.peerDependencies),
  format: 'cjs',
});
