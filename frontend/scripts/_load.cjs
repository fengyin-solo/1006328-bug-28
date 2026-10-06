/**
 * 规则验证脚本（node --test）。
 * 用 esbuild 把 src 里的真实源码（含 @ 别名）打成临时 ESM 后执行，
 * 不复制业务实现，保证测的就是线上跑的那一份。
 */
const { build } = require('esbuild')
const { writeFileSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const outDir = mkdtempSync(join(tmpdir(), 'leak-rules-'))
const outfile = join(outDir, 'bundle.mjs')

function makeLocalStorage(initial = null) {
  let store = initial
  return {
    getItem: (key) => (store && key in store ? store[key] : null),
    setItem: (key, value) => {
      store = { ...(store ?? {}), [key]: value }
    },
    removeItem: (key) => {
      if (store) delete store[key]
    },
    _dump: () => (store ? JSON.parse(Object.values(store)[0]) : null),
  }
}

async function loadEnv(lsOrV1 = null) {
  // 传 localStorage 桩直接用；否则把参数视为 v1 原始数据包成桩
  const ls = lsOrV1 && typeof lsOrV1.getItem === 'function' ? lsOrV1 : makeLocalStorage(lsOrV1)
  globalThis.__HARNESS_LS__ = ls
  const virtualPath = join(outDir, 'virtual-env.ts')
  writeFileSync(virtualPath, '')

  await build({
    entryPoints: [join(__dirname, 'harness.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    alias: { '@': join(__dirname, '..', 'src') },
    banner: {
      js: `globalThis.window = { localStorage: globalThis.__HARNESS_LS__, addEventListener() {} }; globalThis.localStorage = globalThis.__HARNESS_LS__;`,
    },
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(outfile).href) },
  })

  return import(pathToFileURL(outfile).href + `?t=${Date.now()}-${Math.random()}`)
}

module.exports = { loadEnv, makeLocalStorage }
