import { defineConfig } from 'tsdown'

const shared = {
  outDir: 'dist',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: ['electron'],
} as const

export default defineConfig([
  { ...shared, format: ['esm'], entry: { 'main/index': 'src/main/index.ts', 'main/plugin-manager': 'src/main/plugin-manager.ts' } },
  { ...shared, format: ['cjs'], entry: { 'preload/index': 'src/preload/index.ts' } },
])
