import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  treeshake: true,
  noExternal: [/^@tc\//, 'zod'],
  outExtension: () => ({ js: '.cjs' }),
});
