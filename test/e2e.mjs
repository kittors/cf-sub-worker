// 端到端测试：在真实的无头 Chrome 里操作管理端。
//
//   node test/e2e.mjs            （需要本机装有 Chrome，或用 CHROME=... 指定）
//
// run.cjs 只能检查语法和静态结构，抓不住运行时错误 —— 比如函数名被同名局部变量遮蔽，
// 页面一打开就白屏，语法检查照样全绿。这里用当前的 worker.js 现生成一份演示页
// （Worker 跑在页面里，数据是示例），把每个页面、每种弹窗、主要的增删改都真的点一遍，
// 页面里出现任何未捕获的异常或 console.error 都算失败。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launch } from '../scripts/cdp.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfsub-e2e-')), 'demo.html')
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-demo.mjs')], { env: { ...process.env, DEMO_OUT: OUT }, stdio: 'inherit' })
const URL0 = pathToFileURL(OUT).href

let pass = 0, fail = 0
const ok = (c, m, extra) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m + (extra ? '  → ' + extra : ''))) }
const sec = t => console.log('\n── ' + t + ' ──')

// 注入到页面里的小工具：等条件成立、取最上层弹窗、点确定
const KIT = `
  window.__w = ms => new Promise(r => setTimeout(r, ms))
  window.__until = async (f, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = f(); if (v) return v } catch (e) {} await __w(40) } return false }
  window.__top = () => [...document.querySelectorAll('.bd:not(.out) .md')].pop() || null
  window.__ok = async () => { const b = __top(); b.querySelector('[data-ok]').click(); await __until(() => !document.body.contains(b) || b.querySelector('.ferr'), 6000); return b }
  window.__close = async () => { const b = __top(); if (b) { b.querySelector('[data-close]').click(); await __until(() => !__top()) } }
  window.__toast = () => [...document.querySelectorAll('.toast:not(.out) span')].map(e => e.textContent).join(' / ')
  document.head.insertAdjacentHTML('beforeend', '<style>*{animation:none!important;transition:none!important}</style>')
`

const b = await launch()
const run = async code => { try { return await b.run(code) } catch (e) { return { __err: e.message } } }
const step = async (label, code) => {
  const v = await run(code)
  if (v && v.__err) return ok(false, label, v.__err.split('\n')[0])
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, c] of Object.entries(v)) ok(c === true, `${label}：${k}`, c === true ? '' : JSON.stringify(c))
  } else ok(v === true, label, JSON.stringify(v))
}
const page = async (hash, opt = {}) => {
  await b.viewport(opt.w || 1100, opt.h || 900, opt)
  await b.open(`${URL0}#${hash}`)
  await b.run(KIT)
}

try {
  sec('节点页')
  await page('node')
  await step('首屏', `return {
    '顶栏统计': /2 个订阅源/.test(document.querySelector('.lede').textContent),
    '两个订阅源': document.querySelectorAll('.uplist.src .up').length === 2,
    '三个自有节点': document.querySelectorAll('.uplist.own .up').length === 3,
    '链式代理一条': document.querySelectorAll('.uplist.chain .up').length === 1,
    '节点列表': document.querySelectorAll('#nodecard .nd').length === 47,
    '用量显示': /GB/.test(document.querySelector('.uplist.src').textContent)
  }`)
  await step('节点搜索', `filterNodes('香港'); const n = document.querySelectorAll('#nodecard .nd:not([hidden])').length; clearNodeQ(); return { '命中 7 个': n === 7, '清空后恢复': document.querySelectorAll('#nodecard .nd:not([hidden])').length === 47 }`)
  await step('节点停用并落库', `const sw = document.querySelector('#nodecard .nd .sw'); const k = sw.closest('.nd').dataset.k
    sw.click(); await __until(() => sw.closest('.nd').classList.contains('off'))
    // 开关是乐观更新：界面先变，请求随后才落库，所以要等服务端真的记下
    let off = false
    for (let i = 0; i < 50 && !off; i++) { const st = await (await fetch('/api/state')).json(); off = st.regions.flatMap(r => r.nodes).find(n => n.key === k).off; if (!off) await __w(40) }
    sw.click(); await __w(200)
    return { '界面变灰': true, '服务端记下': off === true, 'aria 同步': sw.getAttribute('aria-checked') === 'true' }`)
  await step('节点改名', `const nd = document.querySelectorAll('#nodecard .nd')[1]; const k = nd.dataset.k
    nd.querySelector('[aria-label="重命名"]').click(); const inp = nd.querySelector('input.edit'); inp.value = '改过的名字'
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); await __until(() => /已重命名/.test(__toast()))
    const row = [...document.querySelectorAll('#nodecard .nd')].find(x => x.dataset.k === k)
    return { '名字更新': row && /改过的名字/.test(row.textContent), '标记自定义': row && !!row.querySelector('.tag') }`)
  await step('添加订阅源：拉不通就地提示，粘贴后成功', `addUp(); await __until(__top); const m = __top()
    m.querySelector('#uu').value = 'https://blocked.example/sub'; await __ok()
    const err = (m.querySelector('.ferr') || {}).textContent || ''
    const badField = !!m.querySelector('#ut.bad')
    m.querySelector('#ut').value = '  - { name: 测试-日本-1, type: ss, server: 198.51.100.1, port: 443, cipher: aes-128-gcm, password: "p1" }\\n  - { name: 测试-香港-1, type: ss, server: 198.51.100.2, port: 443, cipher: aes-128-gcm, password: "p2" }'
    await __ok(); await __until(() => document.querySelectorAll('.uplist.src .up').length === 3)
    return { '失败原因写在表单里': /拉取失败|粘到下面/.test(err), '定位到粘贴框': badField, '新增一行': document.querySelectorAll('.uplist.src .up').length === 3, '节点数更新': /49/.test(document.querySelector('.lede').textContent) }`)
  await step('删除订阅源', `const id = ST.upstreams[2].id; delUp(id); await __until(__top); await __ok()
    await __until(() => document.querySelectorAll('.uplist.src .up').length === 2); return document.querySelectorAll('.uplist.src .up').length === 2`)
  await step('抓取诊断', `probeUp('a1'); await __until(() => __top() && __top().querySelector('#pbx .uplist'), 6000)
    const t = __top().textContent; await __close(); return { '逐个身份试拉': /逐个身份试拉/.test(t), '解析到节点': /解析到节点/.test(t) }`)
  await step('自有节点：分享链接导入后保存，再删除', `editOwn(null); await __until(__top); const m = __top()
    m.querySelector('#oimp').value = 'vless://11111111-2222-3333-4444-555555555555@v.example.net:443?security=reality&sni=www.example.com&pbk=PUBKEY0000000000000000000000000000000000000&sid=ab12&type=tcp&flow=xtls-rprx-vision#E2E-VLESS'
    m.querySelector('#oimpb').click(); await __until(() => m.querySelector('#on').value === 'E2E-VLESS')
    const filled = m.querySelector('#opk').value.startsWith('PUBKEY') && m.querySelector('#osid').value === 'ab12'
    await __ok(); await __until(() => document.querySelectorAll('.uplist.own .up').length === 4)
    const k = Object.keys(OWN.own).find(x => OWN.own[x].name === 'E2E-VLESS')
    delOwn(k); await __until(__top); await __ok(); await __until(() => document.querySelectorAll('.uplist.own .up').length === 3)
    return { '链接解析填表': filled, '保存后多一行': !!k, '删除后恢复': document.querySelectorAll('.uplist.own .up').length === 3 }`)
  await step('自有节点：WebSocket 传输切换表单字段并能保存', `editOwn(null); await __until(__top); const m = __top()
    m.querySelector('#onet .selb').click(); await __w(50); document.querySelector('.selp.portal .selo[data-v="ws"]').click(); await __w(50)
    const swapped = m.querySelector('#fr').hidden && !m.querySelector('#fw').hidden
    m.querySelector('#on').value = 'E2E-WS'; m.querySelector('#os').value = 'cdn.e2e.example'; m.querySelector('#ou').value = '11111111-2222-3333-4444-555555555555'
    m.querySelector('#osni').value = 'cdn.e2e.example'; m.querySelector('#opath').value = '/ws'
    await __ok(); await __until(() => document.querySelectorAll('.uplist.own .up').length === 4)
    const k = Object.keys(OWN.own).find(x => OWN.own[x].name === 'E2E-WS'); const n = OWN.own[k]
    const label = /VLESS WS/.test(document.querySelector('.uplist.own').textContent)
    delOwn(k); await __until(__top); await __ok(); await __until(() => document.querySelectorAll('.uplist.own .up').length === 3)
    return { '选 WebSocket 后显示路径而不是 Reality 公钥': swapped, '按 ws 保存': n.net === 'ws' && n.path === '/ws' && !n.pk, '列表里显示为 VLESS WS': label }`)
  await step('自有节点表单校验', `editOwn(null); await __until(__top); const m = __top(); m.querySelector('#on').value = 'x'; m.querySelector('#os').value = 'a.example'; m.querySelector('#op').value = '99999'
    await __ok(); const e = (m.querySelector('.ferr') || {}).textContent || ''; await __close(); return /1-65535/.test(e)`)
  await step('链式代理编辑弹窗', `editChain('c1'); await __until(__top); const t = __top().textContent; await __close(); return /中转/.test(t) && /落地/.test(t)`)
  await step('主题切换', `const t = () => document.documentElement.dataset.theme
    cycleTheme(); const l = t() + '/' + localStorage.getItem('theme'); cycleTheme(); const d = t() + '/' + localStorage.getItem('theme'); cycleTheme()
    return { '跟随系统→浅色': l === 'light/light', '浅色→深色': d === 'dark/dark', '深色→跟随系统': localStorage.getItem('theme') === null && t() === 'light' }`)

  sec('订阅页')
  await page('sub')
  await step('三份订阅', `return document.querySelectorAll('.prof').length === 3`)
  await step('手机订阅的严格策略提示', `return /Google/.test((document.querySelectorAll('.prof')[1].querySelector('.seen.warn') || {}).textContent || '')`)
  await step('地区标签不误报', `return !/当前无节点/.test(document.querySelectorAll('.prof')[1].textContent)`)
  await step('切换客户端', `pickClient('singbox'); await __until(() => /fmt=singbox/.test(document.getElementById('su0').textContent)); const u = document.getElementById('su0').textContent; pickClient('clash'); await __w(200); return /^https:\\/\\/sub\\.example\\.com\\/sub\\?token=.+&fmt=singbox$/.test(u)`)
  await step('二维码', `qrSub(0); await __until(() => __top() && __top().querySelector('#qrv svg')); const m = __top()
    const n1 = m.querySelector('#qrv path').getAttribute('d').length; m.querySelectorAll('#qrm button')[1].click(); await __w(100)
    const n2 = m.querySelector('#qrv path').getAttribute('d').length; const u = m.querySelector('#qru').textContent; await __close()
    return { '画出二维码': n1 > 100, '可切到一键导入': n2 !== n1 && /^clash:\\/\\/install-config/.test(u) }`)
  await step('配置预览（四种格式）', `previewSub(0); await __until(() => __top() && /个节点/.test(__top().querySelector('#pvs').textContent)); const m = __top(); const r = {}
    for (const f of ['clash', 'shadowrocket', 'singbox', 'share']) {
      m.querySelector('#pvf button[data-f="' + f + '"]').click(); await __until(() => /个节点/.test(m.querySelector('#pvs').textContent) && m.querySelector('#pvc').textContent.length > 200)
      r[f] = m.querySelector('#pvc').textContent.length > 200
    }
    const sb = m.querySelector('#pvc').textContent; m.querySelector('#pvf button[data-f="singbox"]').click(); await __until(() => m.querySelector('#pvc').textContent.trim().startsWith('{'))
    let json = false; try { JSON.parse(m.querySelector('#pvc').textContent); json = true } catch (e) {}
    await __close(); return { Clash: r.clash, Shadowrocket: r.shadowrocket, 'sing-box 是合法 JSON': json, '通用格式已解码': r.share && /:\\/\\//.test(sb) }`)
  await step('预览切格式不闪：逐帧采样，布局一丝不动、内容从不清空', `previewSub(0)
    await __until(() => __top() && __top().querySelector('#pvc').dataset.f === 'clash', 6000)
    const m = __top(), pre = m.querySelector('#pvc'), st = m.querySelector('#pvs')
    const box = () => [Math.round(m.getBoundingClientRect().height), Math.round(pre.getBoundingClientRect().height), Math.round(st.getBoundingClientRect().height)].join('/')
    const seen = new Set([box()]); let minLen = pre.textContent.length, frames = 0, run = true
    // 每一帧都量：弹窗、代码区、统计行的高度，以及代码区里还剩多少字
    const tick = () => { if (!run) return; frames++; seen.add(box()); minLen = Math.min(minLen, pre.textContent.length); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    // DOM 每变一次也量一次，连帧与帧之间的中间态都不放过
    const mo = new MutationObserver(() => { seen.add(box()); minLen = Math.min(minLen, pre.textContent.length) })
    mo.observe(pre, { childList: true, subtree: true, characterData: true }); mo.observe(st, { childList: true, subtree: true })
    for (const f of ['singbox', 'shadowrocket', 'share', 'clash', 'singbox', 'share', 'clash']) {
      m.querySelector('#pvf button[data-f="' + f + '"]').click()
      seen.add(box()); minLen = Math.min(minLen, pre.textContent.length)      // 点下去的同一刻：响应还没回来
      await __until(() => pre.dataset.f === f, 6000)
      await __w(60)
    }
    // 预取完成后再切：同一帧里就该换好，不经过任何加载态
    await __w(300)
    m.querySelector('#pvf button[data-f="singbox"]').click()
    const instant = pre.dataset.f === 'singbox' && pre.textContent.trim().startsWith('{')
    // 滚动位置按格式记住：在 sing-box 里往下滚，切走再切回来还在原处
    pre.scrollTop = 400; m.querySelector('#pvf button[data-f="clash"]').click(); m.querySelector('#pvf button[data-f="singbox"]').click()
    const kept = Math.abs(pre.scrollTop - 400) <= 2
    run = false; mo.disconnect()
    const colored = !!pre.querySelector('.k')
    await __close()
    return { '弹窗与代码区、统计行的高度始终不变': seen.size === 1 || [...seen].join(' | '), '任何一刻代码区都不是空的': minLen > 500 || minLen,
      '采样到了足够多的帧': frames > 10 || frames, '看过的格式再切回来是瞬间的': instant, '切回来时滚动位置还在': kept, 'sing-box 也有语法着色': colored }`)
  await step('新建订阅并拉一次，出现拉取记录', `editProf(null); await __until(__top); const m = __top(); m.querySelector('#sn').value = 'E2E'; await __ok()
    await __until(() => document.querySelectorAll('.prof').length === 4)
    const i = PRF.profiles.findIndex(x => x.name === 'E2E'); await fetch('/sub?token=' + PRF.profiles[i].token)
    PRF = null; await dash(true); await __until(() => /拉取/.test(document.querySelectorAll('.prof')[i].querySelector('.seen:last-child').textContent))
    showHits(i); await __until(__top); const n = __top().querySelectorAll('.hit').length; await __close()
    delProf(i); await __until(__top); await __ok(); await __until(() => document.querySelectorAll('.prof').length === 3)
    return { '新建成功': true, '拉取记录一条': n === 1, '删除成功': document.querySelectorAll('.prof').length === 3 }`)
  await step('编辑订阅：token 不合法就地报错', `editProf(0); await __until(__top); const m = __top(); m.querySelector('#stk').value = 'short'; await __ok()
    const e = (m.querySelector('.ferr') || {}).textContent || ''; await __close(); return /16-64/.test(e) && !!m.querySelector('#stk.bad')`)
  await step('停用 / 启用订阅', `const sw = document.querySelector('.prof .sw'); sw.click(); await __until(() => document.querySelector('.prof').classList.contains('off'))
    sw.click(); await __until(() => !document.querySelector('.prof').classList.contains('off')); return true`)

  sec('分流策略')
  await page('pol')
  await step('策略列表', `return { '12 条': document.querySelectorAll('#pollist .pol').length === 12, '没有失效误报': !document.querySelector('#body .alert'), '地区目标有名字': /日本/.test(document.querySelector('#pollist .pol .tgts').textContent) }`)
  await step('新建策略：缺规则就地报错，补上后保存', `editPol(null); await __until(__top); const m = __top(); m.querySelector('#pn').value = '🧪 E2E'; await __ok()
    const e = (m.querySelector('.ferr') || {}).textContent || ''; m.querySelector('#pd').value = 'e2e.example'; await __ok()
    await __until(() => document.querySelectorAll('#pollist .pol').length === 13); return { '缺规则提示': /至少要有一条/.test(e), '保存成功': document.querySelectorAll('#pollist .pol').length === 13 }`)
  await step('规则测试', `await runMatch('www.e2e.example'); const a = document.getElementById('mres').textContent
    await runMatch('https://www.youtube.com/watch?v=1'); const y = document.getElementById('mres').textContent
    await runMatch('192.0.2.77'); const ip = document.getElementById('mres').textContent
    return { '命中新策略': /E2E/.test(a), 'YouTube 走日本': /YouTube/.test(y) && /日本/.test(y), 'IP 落到兜底并说明': /兜底/.test(ip) && /IP/.test(ip) }`)
  await step('删除新策略', `const i = POL.policies.findIndex(p => p.name === '🧪 E2E'); delPol(i); await __until(__top); await __ok(); await __until(() => document.querySelectorAll('#pollist .pol').length === 12); return true`)
  await step('切到某份订阅并改为专属、再改回继承', `document.querySelector('#pfsel .selb').click(); await __w(50); document.querySelector('.selp.portal .selo[data-v="phone"]').click()
    await __until(() => PF === 'phone' && POL && document.querySelector('#pollist'))
    detachPol(); await __until(__top); await __ok(); await __until(() => POL && POL.inherit === false)
    inheritPol(); await __until(__top); await __ok(); await __until(() => POL && POL.inherit === true)
    return true`)
  await step('改过的表单按 Esc 不关', `editPol(0); await __until(__top); const m = __top(); m.querySelector('#pn').value += 'x'
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await __w(100); const still = document.body.contains(m); await __close(); return still`)

  sec('域名库')
  await page('lib')
  await step('搜索域名', `filterLib('netflix.com'); return /1 个集合/.test(document.getElementById('lqc').textContent)`)
  await step('改内置集合后恢复', `filterLib(''); editLib('media'); await __until(__top); __top().querySelector('#ld').value += '\\nextra.e2e.example'; await __ok()
    await __until(() => /已修改/.test(document.querySelector('.uplist.lib .up[data-k="media"]').textContent))
    restoreLib('media'); await __until(__top); await __ok(); await __until(() => !/已修改/.test(document.querySelector('.uplist.lib .up[data-k="media"]').textContent))
    return true`)
  await step('被引用的自定义集合删不掉', `editLib(null); await __until(__top); const m = __top(); m.querySelector('#ln').value = 'E2E集'; m.querySelector('#ld').value = 'a.e2e.example'; await __ok()
    const k = Object.keys(POL.lib).find(x => POL.lib[x].name === 'E2E集')
    const r = await (await fetch('/api/policies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policies: [...POL.policies, { name: '引用E2E', target: 'all', presets: [k] }] }) })).json()
    POL = null; await dash(true)
    delLib(k); await __until(__top); const d = __top(); await __ok(); const e = (d.querySelector('.ferr') || {}).textContent || ''; await __close()
    return { '拒绝并点名': /引用E2E/.test(e) }`)

  sec('设置')
  await page('set')
  await step('站点设置：非法 IP 就地报错', `editSettings(); await __until(__top); const m = __top(); m.querySelector('#stip').value = '1.2.3'; await __ok()
    const e = (m.querySelector('.ferr') || {}).textContent || ''; m.querySelector('#stip').value = '203.0.113.10'; await __ok()
    return { '报错': /IPv4/.test(e), '改对后保存': !document.body.contains(m) }`)
  await step('DNS：新增一条域名指派并保存', `editDns(); await __until(__top); const m = __top(); addDnsPol(); m.querySelector('#dpol [data-pi]:last-child .pdm').value = '+.e2e.example'
    await __ok(); return !document.body.contains(m) && /e2e\\.example/.test(document.getElementById('body').textContent)`)
  await step('备份导出与恢复', `const bk = (await (await fetch('/api/backup')).json()).backup
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: 'changed.example' }) })
    const r = await (await fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup: bk }) })).json()
    SET = null; await dash(true); return { '恢复成功': r.ok === true, '配置回来了': /sub\\.example\\.com/.test(document.getElementById('body').textContent) }`)
  await step('让其它设备下线', `revokeOthers(); await __until(__top); await __ok(); return await __until(() => /下线/.test(__toast()))`)

  sec('窄屏（390px）')
  for (const t of ['node', 'sub', 'pol', 'lib', 'set']) {
    await page(t, { w: 390, h: 844, mobile: true })
    await step(`「${t}」页不横向溢出`, `return document.documentElement.scrollWidth <= innerWidth + 1 || document.documentElement.scrollWidth + ' > ' + innerWidth`)
  }
  await step('弹窗在窄屏是底部抽屉', `editSettings(); await __until(__top); const r = __top().getBoundingClientRect(); await __close(); return Math.abs(r.bottom - innerHeight) < 2`)

  sec('暗色')
  await page('node', { dark: true })
  await step('跟随系统进入暗色', `return document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.body).backgroundColor === 'rgb(27, 26, 24)'`)

  sec('页面错误')
  ok(b.errors.length === 0, '整个过程没有未捕获的异常或 console.error', b.errors.slice(0, 3).join(' | '))
} catch (e) {
  ok(false, '测试过程出错', e.message)
} finally {
  b.close()
  fs.rmSync(path.dirname(OUT), { recursive: true, force: true })
}

console.log(`\n${'='.repeat(46)}\n端到端 通过 ${pass} · 失败 ${fail}\n${'='.repeat(46)}`)
process.exit(fail ? 1 : 0)
