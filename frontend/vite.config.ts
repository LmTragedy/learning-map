import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Big libraries go in their own chunks: they change less often than the app, so a rebuild keeps them cached.
// CodeMirror is left out on purpose: it belongs to the lazily loaded note editor and must not load with the page.
const vendorChunks: [string, RegExp][] = [
  ['react', /node_modules\/(react|react-dom|scheduler)\//],
  ['flow', /node_modules\/@xyflow\//],
  ['ui', /node_modules\/@radix-ui\//],
  ['markdown', /node_modules\/(react-markdown|remark-|rehype-|mdast-|micromark|hast-|unist-|unified|vfile|property-information|katex)/],
]

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8741' } },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          return vendorChunks.find(([, test]) => test.test(id))?.[0]
        },
      },
    },
  },
})
