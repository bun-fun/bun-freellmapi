import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'node:fs'
import zlib from 'node:zlib'

// Precompress every text asset into .br and .gz siblings at build time, so the
// server only negotiates via Accept-Encoding and streams a pre-built file —
// no per-request compression CPU on cold Hugging Face containers.
// Text assets under 1 KiB are skipped: the compressed sibling would not be
// smaller than the original once framing overhead is counted.
function precompressAssets(outDir: string): Plugin {
  const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|txt)$/
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    )
  return {
    name: 'precompress-assets',
    apply: 'build',
    closeBundle() {
      if (!fs.existsSync(outDir)) return
      let count = 0
      let rawBytes = 0
      let brBytes = 0
      for (const file of walk(outDir)) {
        if (!COMPRESSIBLE.test(file)) continue
        const data = fs.readFileSync(file)
        if (data.length < 1024) continue
        fs.writeFileSync(`${file}.gz`, zlib.gzipSync(data, { level: 9 }))
        fs.writeFileSync(
          `${file}.br`,
          zlib.brotliCompressSync(data, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 },
          }),
        )
        count += 1
        rawBytes += data.length
        brBytes += fs.statSync(`${file}.br`).size
      }
      console.log(
        `precompress: ${count} files, ${(rawBytes / 1024 / 1024).toFixed(2)} MB -> ${(brBytes / 1024 / 1024).toFixed(2)} MB brotli`,
      )
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const serverPort = env.PORT ?? process.env.PORT ?? 3001

  return {
    plugins: [react(), tailwindcss(), precompressAssets(path.resolve(__dirname, '../server/dist/web'))],
    base: process.env.VITE_BASE ?? '/',
    envDir: path.resolve(__dirname, '..'),
    define: {
      __SERVER_PORT__: JSON.stringify(String(serverPort)),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      outDir: '../server/dist/web',
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          // Split heavy vendor libraries into their own long-cacheable chunks
          // instead of one monolithic index.js. Higher priority wins, so the
          // specific groups are checked before the generic node_modules one.
          codeSplitting: {
            groups: [
              {
                name: 'charts',
                test: /[\\/]node_modules[\\/](recharts|victory-vendor|d3-[a-z-]+|internmap|eventemitter3|decimal\.js-light)/,
                priority: 30,
              },
              {
                name: 'markdown',
                test: /[\\/]node_modules[\\/](react-markdown|remark-[^\\/]*|rehype-[^\\/]*|micromark[^\\/]*|mdast-[^\\/]*|unist-[^\\/]*|hast-[^\\/]*|unified|bail|trough|vfile|devlop|zwitch|decode-named-character-reference|character-entities[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|web-namespaces|html-url-attributes|longest-streak)/,
                priority: 20,
              },
              {
                name: 'react',
                test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                priority: 15,
              },
              {
                name: 'vendor',
                test: /[\\/]node_modules[\\/]/,
                priority: 10,
              },
            ],
          },
        },
      },
    },
    server: {
      proxy: {
        '/api': `http://localhost:${serverPort}`,
        '/v1': `http://localhost:${serverPort}`,
      },
    },
  }
})
