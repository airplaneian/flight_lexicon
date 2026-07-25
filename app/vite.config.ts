import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { lexiconDocs } from './scripts/lexicon-docs.mjs'

export default defineConfig({
  plugins: [lexiconDocs()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        docs: resolve(__dirname, 'docs/index.html'),
        importer: resolve(__dirname, 'import/index.html'),
      },
    },
  },
  // atproto OAuth loopback clients must be reached over 127.0.0.1, not localhost.
  server: { host: '127.0.0.1', port: 5173 },
})
