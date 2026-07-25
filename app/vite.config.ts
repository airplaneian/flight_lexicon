import { defineConfig } from 'vite'

export default defineConfig({
  build: { target: 'es2022' },
  // atproto OAuth loopback clients must be reached over 127.0.0.1, not localhost.
  server: { host: '127.0.0.1', port: 5173 },
})
