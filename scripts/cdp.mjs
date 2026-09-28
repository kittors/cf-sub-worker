// 驱动本机 Chrome 的最小封装：无头启动，走调试协议发命令。截图与端到端测试共用。
// Node 18+ 自带 fetch 与 WebSocket，不需要装 Puppeteer / Playwright。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const sleep = ms => new Promise(r => setTimeout(r, ms))

export function findChrome() {
  return process.env.CHROME || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].find(p => fs.existsSync(p))
}

export async function launch() {
  const bin = findChrome()
  if (!bin) throw new Error('找不到 Chrome，用 CHROME=/path/to/chrome 指定')
  const port = 9300 + Math.floor(Math.random() * 600)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cfsub-chrome-'))
  const proc = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--force-color-profile=srgb', '--lang=zh-CN', 'about:blank'
  ], { stdio: 'ignore' })
  let ws = null
  const close = () => {
    try { ws && ws.close() } catch (e) {}
    try { proc.kill() } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  }
  process.on('exit', close)

  let page = null
  for (let i = 0; i < 150 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page') } catch (e) {}
    if (!page) await sleep(100)
  }
  if (!page) { close(); throw new Error('Chrome 没有起来') }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('连不上 Chrome 调试端口')) })

  let seq = 0
  const pending = new Map()
  // 页面里任何没被接住的异常、console.error 都记下来：测试要求一条都没有
  const errors = []
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      errors.push((d.exception && d.exception.description) || d.text)
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + m.params.args.map(a => a.value !== undefined ? a.value : a.description).join(' '))
    }
  }
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, m => m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  // 在页面里跑一段 async 代码并取回返回值
  const run = async code => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)
    return r.result && r.result.value
  }
  await send('Page.enable')
  await send('Runtime.enable')

  const viewport = (w, h, opt = {}) => Promise.all([
    send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: opt.scale || 1, mobile: !!opt.mobile }),
    send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: opt.dark ? 'dark' : 'light' },
      { name: 'prefers-reduced-motion', value: 'reduce' }
    ] })
  ])
  // 打开页面并等管理端渲染完（有卡片、没有骨架屏）
  const open = async (url, timeout = 10000) => {
    await send('Page.navigate', { url: 'about:blank' })
    await sleep(80)
    await send('Page.navigate', { url })
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      await sleep(80)
      const ok = await run(`return !!document.querySelector('#body .card') && !document.querySelector('#body .sk')`).catch(() => false)
      if (ok) return true
    }
    throw new Error('页面没渲染出来：' + await run(`return (document.getElementById('app') || document.body).innerText.slice(0, 160)`).catch(e => e.message))
  }
  return { send, run, errors, viewport, open, close }
}
