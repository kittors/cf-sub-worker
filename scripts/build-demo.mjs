// 生成 docs/demo.html：一份不用部署就能试玩的完整演示页。
//
//   node scripts/build-demo.mjs
//
// 不是截图拼出来的静态页 —— 整份 worker.js 被原样放进页面，在浏览器里跑：
// 管理端发出的 /api/* 请求被截下来交给页面里的 Worker 处理，KV 存在 sessionStorage，
// 两个示例机场的订阅由页面自己提供。所以演示页的每个按钮都是真的：增删改、拖拽、
// 预览配置、规则测试、备份恢复，和线上走的是同一份代码，改完 worker.js 重新生成即可。

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { FEEDS, seedData } from '../dev/fixtures.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8')
// DEMO_OUT：端到端测试用，生成到临时位置，不动 docs/ 里的正式文件
const OUT = process.env.DEMO_OUT || path.join(ROOT, 'docs', 'demo.html')
const ORIGIN = 'https://sub.example.com'

// 在 Node 里执行一遍 worker.js，拿到已登录状态下的管理端页面
const ctx = vm.createContext({ addEventListener () {}, TextEncoder, TextDecoder, URL, Response, Request, Headers, crypto: globalThis.crypto, btoa, atob, console })
vm.runInContext(SRC, ctx)
let html = ctx.adminHTML(true, true)

// JSON 放进 <script> 里：</script 和 <!-- 会提前结束或打乱脚本块，必须转义
const inline = v => JSON.stringify(v).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
const feeds = {}
for (const [k, f] of Object.entries(FEEDS)) feeds[k] = { status: f.status || 200, type: f.type, usage: f.usage || null, body: f.body() }

const shim = `<script id="demo">
/* 演示模式：Worker 跑在页面里。见 scripts/build-demo.mjs */
(function () {
  var SRC = ${inline(SRC)}
  var FEEDS = ${inline(feeds)}
  var SEED = ${inline(seedData('https://feeds.example'))}
  var KEY = 'cf-sub-demo-kv'
  var kv = null
  try { kv = JSON.parse(sessionStorage.getItem(KEY) || 'null') } catch (e) {}
  if (!kv) { kv = {}; for (var k in SEED) kv[k] = JSON.stringify(SEED[k]) }
  var save = function () { try { sessionStorage.setItem(KEY, JSON.stringify(kv)) } catch (e) {} }
  var CONF = {
    get: function (k, t) { var v = kv[k]; return Promise.resolve(v === undefined ? null : t === 'json' ? JSON.parse(v) : v) },
    put: function (k, v) { kv[k] = String(v); save(); return Promise.resolve() },
    delete: function (k) { delete kv[k]; save(); return Promise.resolve() }
  }
  var DAY = 86400
  // Worker 去拉示例机场时走这里；用量按打开页面的时间算，过几个月再看也不会全过期
  var feedFetch = function (input) {
    var u = new URL(typeof input === 'string' ? input : input.url)
    var f = FEEDS[u.pathname.replace('/__feed/', '')]
    if (!f) return Promise.resolve(new Response('演示页里没有这个订阅源，只能用粘贴导入', { status: 404 }))
    var h = { 'Content-Type': f.type }
    if (f.usage) h['Subscription-Userinfo'] = 'upload=' + f.usage[0] + '; download=' + f.usage[1] + '; total=' + f.usage[2] + '; expire=' + (Math.floor(Date.now() / 1000) + f.usage[3] * DAY)
    return Promise.resolve(new Response(f.body, { status: f.status, headers: h }))
  }
  // 演示页没有登录这一步：会话校验直接放行
  var W = new Function('addEventListener', 'CONF', 'SETUP_TOKEN', 'fetch',
    SRC + '\\n;checkCookie = function () { return Promise.resolve(true) };\\nreturn { handle: handle }')(function () {}, CONF, '', feedFetch)
  var realFetch = window.fetch.bind(window)
  window.__origin = ${JSON.stringify(ORIGIN)}
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : input.url
    if (/^\\/(api|admin|sub)(\\/|\\?|$)/.test(u)) {
      if (u === '/admin/logout') return Promise.resolve(new Response(null, { status: 204 }))
      return W.handle(new Request(${JSON.stringify(ORIGIN)} + u, init), { waitUntil: function (p) { Promise.resolve(p).catch(function () {}) } })
    }
    return realFetch(input, init)
  }
  window.resetDemo = function () { try { sessionStorage.removeItem(KEY) } catch (e) {} location.reload() }
})()
</script>
`
const banner = `<div id="demobar" style="position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:40;display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--bd);box-shadow:var(--shT);border-radius:999px;padding:6px 8px 6px 14px;font-size:12.5px;color:var(--tx2);white-space:nowrap">
<span><b style="color:var(--acc)">演示模式</b> · 数据只存在这个标签页，刷新保留、关闭即清空</span>
<button class="g xs" onclick="resetDemo()">重置数据</button></div>
`
// 注意这几处替换都要找「最后一处」或「第一处」：worker.js 源码被整段嵌进了演示脚本，
// 页面结尾的 </body></html> 在那段源码字符串里也出现过，用 replace 会插错地方
const i = html.lastIndexOf('<script>')
if (i < 0) throw new Error('找不到管理端主脚本')
html = html.slice(0, i) + shim + html.slice(i)
html = html.replace('<title>订阅聚合</title>', '<title>订阅聚合 · 演示</title>')
const end = html.lastIndexOf('</body></html>')
html = html.slice(0, end) + banner + html.slice(end)
fs.writeFileSync(OUT, html)
if (!process.env.DEMO_OUT) console.log(`已生成 ${path.relative(ROOT, OUT)}（${(html.length / 1024).toFixed(0)} KB）`)
