import esbuild from 'esbuild';

await esbuild.build({
  bundle: true,
  entryPoints: ['./index.ts'],
  outdir: './dist',
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  format: 'esm',
  banner: {
    js: 'import { createRequire } from "module"; import url from "url"; const require = createRequire(import.meta.url); const __filename = url.fileURLToPath(import.meta.url); const __dirname = url.fileURLToPath(new URL(".", import.meta.url));',
  },
})
