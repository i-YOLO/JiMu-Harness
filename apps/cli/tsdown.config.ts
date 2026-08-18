import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships the `bin` entry plus the profile boot used by JiMu's
 * in-process desktop host. The root tsdown builds only `lib/types/index.js`,
 * so this override points at both emitted declaration-side entries.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/profile-boot.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
