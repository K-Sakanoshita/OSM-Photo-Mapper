import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    rollupOptions: { input: { ja: resolve('index.html'), en: resolve('en/index.html') } }
  },
  plugins: [
    {
      name: 'map-data-assets',
      writeBundle(options) {
        for (const directory of ['icon', 'tiles', 'data']) {
          cpSync(resolve(directory), resolve(options.dir ?? 'dist', directory), { recursive: true });
        }
      }
    },
    VitePWA({
      injectRegister: false,
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'OSM Photo Mapper',
        short_name: 'PhotoMapper',
        description:
          'Photo-assisted field mapping tool for OpenStreetMap. Walk, photograph, then review and upload OSM edit candidates.',
        theme_color: '#1a5276',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '.',
        icons: [
          {
            src: 'icons/icon-192.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any'
          },
          {
            src: 'icons/icon-512.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any'
          }
        ]
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,json,svg,woff2}'],
        // Large local ML chunks load on demand, not as part of PWA installation.
        globIgnores: ['**/worker-*.js', '**/transformers*.js', '**/ort*.js', '**/*mobilenet*.js', '**/group1-shard*.js'],
        navigateFallbackDenylist: [/^\/api\//, /\/en(?:\/|$)/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/assets\/(?:worker-|transformers|group1-shard|ort-).+\.(?:js|wasm)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'browser-vision-runtime', expiration: { maxEntries: 32, maxAgeSeconds: 30 * 86400 } }
          },
          {
            urlPattern: ({ url }) => url.pathname.includes('/icon/'),
            handler: 'CacheFirst',
            options: { cacheName: 'poi-icons', expiration: { maxEntries: 500 } }
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly'
          }
        ]
      }
    }),
    {
      name: 'language-manifest-path',
      writeBundle(options) {
        const path = resolve(options.dir ?? 'dist', 'en/index.html');
        const html = readFileSync(path, 'utf8');
        writeFileSync(path, html.replace('href="./manifest.webmanifest"', 'href="../manifest.webmanifest"'));
      }
    }
  ]
});
