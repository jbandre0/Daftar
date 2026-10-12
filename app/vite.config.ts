import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

declare const process: { env: Record<string, string | undefined> } // (no @types/node in this project)

// Where the app is served from. '/' for localhost or a custom domain; '/Daftar/' on a GitHub project page.
// The Pages workflow sets VITE_BASE; the router, manifest, service worker and sign-in link all follow it.
const base = (process.env.VITE_BASE || '/').replace(/\/?$/, '/')

export default defineConfig({
  base,
  // dev only: preview mode reads the prompt seed file that lives next to the migrations
  server: { fs: { allow: ['..'] } },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['grain.svg', 'favicon.svg', 'fonts/*.woff2'],
      manifest: {
        name: 'Daftar',
        short_name: 'Daftar',
        description: 'The journal you actually own.',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        background_color: '#17110C',
        theme_color: '#17110C',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
      },
    }),
  ],
})
