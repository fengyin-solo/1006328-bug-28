// 冒烟测试打包器：用 esbuild 的 JS API（按当前平台解析二进制），避免 bin 软链的平台问题。
import { buildSync } from 'esbuild'

buildSync({
  entryPoints: ['scripts/smoke-leak.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@': './src' },
  outfile: 'node_modules/.cache/smoke-leak.mjs',
})
