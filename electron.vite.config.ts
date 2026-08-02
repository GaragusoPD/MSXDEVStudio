import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        // monaco-editor's package.json "exports" map only rewrites '.js'-suffixed
        // subpaths; editors/monaco-full.ts also needs its .css assets, so this
        // aliases straight to the real directory instead of fighting that map.
        '@monaco': resolve('node_modules/monaco-editor/esm/vs')
      }
    },
    plugins: [vue()]
  }
})
