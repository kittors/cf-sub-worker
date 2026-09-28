// 本地预览：在 Node 里直接跑 worker.js，不需要 wrangler，也不碰线上。
//
//   node dev/server.mjs            → http://localhost:8787/admin  密码 devpassword
//   PORT=9000 node dev/server.mjs
//   rm dev/.kv.json                → 回到初始示例数据
//
// KV 落盘到 dev/.kv.json，重启不丢。worker.js 改了不用重启，下一个请求自动重新加载。
// 首次启动会写入一套示例数据，两个示例机场的订阅由本服务器自己在 /__feed/* 上提供，
// 走的是和线上一模一样的拉取、解析、命名流程。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { FEEDS, seedData, userinfo } from './fixtures.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(ROOT, 'worker.js')
const KV_FILE = path.join(ROOT, 'dev', '.kv.json')
const PORT = +process.env.PORT || 8787
const ORIGIN = `http://localhost:${PORT}`
// 示例机场的地址写 127.0.0.1：Node 的 fetch 可能把 localhost 解析成 ::1，而这里只听 IPv4
const FEED_ORIGIN = `http://127.0.0.1:${PORT}`
const PASSWORD = 'devpassword'
const SETUP_TOKEN = 'dev-setup-token-0000'

// ---- KV：语义照 Workers KV，get(k,'json') 要真的解析 ----
let store = {}
try { store = JSON.parse(fs.readFileSync(KV_FILE, 'utf8')) } catch {}
const persist = () => fs.writeFileSync(KV_FILE, JSON.stringify(store, null, 1))
const CONF = {
  async get(k, type) {
    const v = store[k]
    if (v === undefined) return null
    return type === 'json' ? JSON.parse(v) : v
  },
  async put(k, v) { store[k] = String(v); persist() },
  async delete(k) { delete store[k]; persist() },
  async list({ prefix = '' } = {}) {
    return { keys: Object.keys(store).filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }
  }
}

// ---- 加载 worker：每次源文件变动重新执行一遍，相当于重新部署 ----
let W = null, loadedAt = 0
function worker() {
  const m = fs.statSync(SRC).mtimeMs
  if (W && m === loadedAt) return W
  let handler = null
  const ctx = vm.createContext({
    addEventListener: (type, fn) => { if (type === 'fetch') handler = fn },
    CONF, SETUP_TOKEN,
    fetch: (...a) => fetch(...a),
    Request, Response, Headers, URL, URLSearchParams, FormData, Blob,
    crypto: globalThis.crypto, btoa, atob, TextEncoder, TextDecoder,
    AbortController, AbortSignal, structuredClone,
    setTimeout, clearTimeout, console
  })
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'worker.js' })
  if (!handler) throw new Error('worker.js 没有注册 fetch 事件')
  W = { handler, ctx }
  loadedAt = m
  if (m) console.log(`  ↻ 已加载 worker.js（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`)
  return W
}

// 按 Workers 的方式调一次：respondWith 拿响应，waitUntil 的活等它跑完再说
async function run(req) {
  const { handler } = worker()
  let res = Promise.resolve(new Response('worker 没有调用 respondWith', { status: 500 }))
  const bg = []
  handler({
    request: req,
    respondWith: p => { res = Promise.resolve(p) },
    waitUntil: p => { bg.push(Promise.resolve(p).catch(e => console.error('  waitUntil 出错：', e))) }
  })
  const out = await res
  Promise.all(bg)
  return out
}

// ---- 首次启动写示例数据；密码走真实的初始化接口，哈希算法怎么改都不用动这里 ----
async function seed() {
  if (Object.keys(store).length) return false
  for (const [k, v] of Object.entries(seedData(FEED_ORIGIN))) store[k] = JSON.stringify(v)
  persist()
  const r = await run(new Request(ORIGIN + '/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, initToken: SETUP_TOKEN })
  }))
  if (!r.ok) throw new Error('初始化密码失败：' + await r.text())
  return true
}

const server = http.createServer(async (inc, out) => {
  try {
    // 按实际访问的 Host 拼 URL：用 127.0.0.1 打开时 Origin 也是它，同源校验才对得上
    const url = new URL(inc.url, 'http://' + (inc.headers.host || `localhost:${PORT}`))
    // 示例机场。/__feed/blocked 模拟机场拦 Worker 出站，用来看诊断和粘贴导入
    if (url.pathname.startsWith('/__feed/')) {
      const f = FEEDS[url.pathname.slice(8)]
      if (!f) { out.writeHead(404); return out.end('no feed') }
      out.writeHead(f.status || 200, { 'Content-Type': f.type, ...(f.usage ? { 'Subscription-Userinfo': userinfo(f.usage) } : {}) })
      return out.end(f.body())
    }
    // 静态演示页（scripts/build-demo.mjs 生成）与截图，方便在浏览器里直接看
    if (url.pathname.startsWith('/__docs/')) {
      const f = path.join(ROOT, 'docs', path.basename(url.pathname))
      if (!fs.existsSync(f)) { out.writeHead(404); return out.end('no such file') }
      const type = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream'
      out.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      return out.end(fs.readFileSync(f))
    }
    const chunks = []
    for await (const c of inc) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const headers = new Headers()
    for (const [k, v] of Object.entries(inc.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
    headers.set('cf-connecting-ip', inc.socket.remoteAddress || '127.0.0.1')
    const req = new Request(url, { method: inc.method, headers, body: ['GET', 'HEAD'].includes(inc.method) ? undefined : body })
    const t0 = performance.now()
    const res = await run(req)
    const ms = (performance.now() - t0).toFixed(0)
    const h = {}
    res.headers.forEach((v, k) => { if (k !== 'set-cookie') h[k] = v })
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []
    // 本地是 http，Secure cookie 在 localhost 上 Chrome 认，Safari 不认 —— 去掉以便各浏览器都能登录
    if (cookies.length) h['set-cookie'] = cookies.map(c => c.replace(/;\s*Secure/i, ''))
    out.writeHead(res.status, h)
    out.end(Buffer.from(await res.arrayBuffer()))
    if (!url.pathname.startsWith('/admin') || inc.method !== 'GET') console.log(`  ${inc.method} ${url.pathname}${url.search.replace(/token=[^&]+/, 'token=…')} → ${res.status} ${ms}ms`)
  } catch (e) {
    console.error(e)
    out.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    out.end(String(e && e.stack || e))
  }
})

server.listen(PORT, '127.0.0.1', async () => {
  const fresh = await seed()
  console.log(`\n  管理端  ${ORIGIN}/admin   密码 ${PASSWORD}`)
  console.log(`  订阅    ${ORIGIN}/sub?token=${JSON.parse(store.profiles || '[{}]')[0].token || ''}`)
  console.log(`  数据    ${path.relative(ROOT, KV_FILE)}${fresh ? '（已写入示例数据）' : ''}\n`)
})
