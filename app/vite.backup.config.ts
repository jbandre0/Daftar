import { defineConfig } from 'vite'

// Bundles the nightly backup (scripts/backup/cli.ts) into ONE self-contained Node file, so the scheduled copy in
// ~/Library/Application Support/Daftar Backup/ needs nothing from this folder. `npm run backup:build`.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'scripts/backup/cli.ts',
    outDir: 'scripts/backup/dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      // the WebP encoder is only for making photos in Safari; a backup never encodes one
      external: ['@jsquash/webp/encode'],
      output: { entryFileNames: 'daftar-backup.mjs', codeSplitting: false },
    },
  },
  ssr: { noExternal: true, target: 'node' },
})
