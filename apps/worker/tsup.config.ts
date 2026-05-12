import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  treeshake: true,
  noExternal: [/^@tc\//],
  outExtension: () => ({ js: '.mjs' }),
  // Bundled CJS deps (e.g. @solana/buffer-layout) use dynamic require().
  // createRequire shim makes those calls work inside an ESM .mjs bundle.
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});
