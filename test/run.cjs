const fs = require('fs')
const yaml = (() => { try { return require('js-yaml') } catch { return null } })()
global.addEventListener = () => {}
global.crypto = require('crypto').webcrypto
global.btoa = s => Buffer.from(s, 'binary').toString('base64')
global.atob = s => Buffer.from(s, 'base64').toString('binary')
global.TextEncoder = TextEncoder
// 内存版 KV，让 apiRoute 能被真的调用 —— 增删改排这些行为契约靠正则扫源码是守不住的。
// get(key,'json') 必须照真实 KV 那样解析，否则 auth:secret 会带着引号回来，签名永远对不上。
const KV = {}
global.CONF = {
  get: async (k, type) => { const v = KV[k]; return v === undefined ? null : (type === 'json' ? JSON.parse(v) : v) },
  put: async (k, v) => { KV[k] = v },
  delete: async k => { delete KV[k] },
}
eval(fs.readFileSync(require('path').join(__dirname,'..','worker.js'), 'utf8') +
  '\n;global.__t={genClash,genSB,genShare,parseProxyLine,REGIONS,JUNK,unquote,applyNaming,DEFAULT_POLICIES,PRESETS,policyDomains,resolveTarget,policyMembers,resolveTargets,targetList,DEFAULT_NODES,shareLink,adminHTML,aiPrimary,applyProfile,DEFAULT_PROFILES,profilePolicies,DEFAULT_SETTINGS,parseUserinfo,parseNotes,mergeMeta,JUNK,toBytes,splitFeed,looksBase64,b64decode,scrub,flagRegion,parseShareLine,parseBlockNode,parsePasted,feedParse,triesMsg,feedFormat,nestFlow,parseFlow,toSB,regionOf,apiRoute,hmac,sessionSecret,sha256,makeCookie,DEFAULT_NODES,resolveChains,chainLandingWarn,resolveTarget}')
const T = global.__t

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m)) }
const sec = t => console.log('\n── ' + t + ' ──')

// 构造节点集
const text = fs.readFileSync(require('path').join(__dirname,'fixture.yaml'), 'utf8')
const raw = []
for (const line of text.split('\n')) {
  const p = T.parseProxyLine(line)
  if (!p) continue
  if (/^(select|url-test|fallback|load-balance|relay)$/.test(p.type)) continue
  if (T.JUNK.test(p._name)) continue
  if (T.unquote(p.server || '') === '127.0.0.1') continue
  const hit = T.REGIONS.find(r => r.re.test(p._name))
  raw.push({ up: 'smjc01', upName: '示例机场', region: hit.key, raw: p._name, kv: p })
}
const up = T.applyNaming(raw, {}).filter(n => !n.off)
const P = T.DEFAULT_POLICIES, LIB = T.PRESETS
// 测试用的自有节点与站点设置（代码里已不含任何真实站点信息）
const OWN = { usV2:{name:'自建-A',type:'vless',s:'node.example.com',p:443,u:'11111111-2222-3333-4444-555555555555',sni:'www.bing.com',pk:'PUBKEYPLACEHOLDER0000000000000000000000000',sid:'0123456789abcdef',net:'tcp',flow:'xtls-rprx-vision'}, usH:{name:'自建-B',type:'hysteria2',s:'node.example.com',p:8443,ports:'50000-50020',u:'11111111-2222-3333-4444-555555555555',sni:'node.example.com',obfs:'salamander',opwd:'obfspass'} }
const SET = { domain:'sub.example.com', directDomains:['api.example.com'], directIPs:['203.0.113.10'] }

sec('1. 节点解析')
ok(up.length === 35, `解析 35 个节点（实际 ${up.length}）`)
ok(new Set(up.map(n => n.name)).size === up.length, '节点名无重复')

sec('2. Clash YAML')
const cy = T.genClash(false, up, P, LIB, OWN, SET)
let cd = null
try { cd = yaml.load(cy); ok(true, 'YAML 可解析') } catch (e) { ok(false, 'YAML 解析失败: ' + e.message) }
if (cd) {
  const names = cd.proxies.map(p => p.name)
  const groups = cd['proxy-groups'].map(g => g.name)
  const valid = new Set([...names, ...groups, 'DIRECT', 'REJECT'])
  ok(cd.proxies.length === 37, `proxies 37（实际 ${cd.proxies.length}）`)
  ok(new Set(names).size === names.length, 'proxies 无重名')
  ok(new Set(groups).size === groups.length, 'proxy-groups 无重名')

  let dangling = []
  cd['proxy-groups'].forEach(g => (g.proxies || []).forEach(x => { if (!valid.has(x)) dangling.push(`${g.name}→${x}`) }))
  ok(dangling.length === 0, '分组引用无悬空' + (dangling.length ? ': ' + dangling.slice(0,3) : ''))

  let badRule = []
  cd.rules.forEach(r => {
    const parts = r.split(','); const t = parts[parts.length - 1].trim()
    const target = t === 'no-resolve' ? parts[parts.length - 2].trim() : t
    if (!valid.has(target)) badRule.push(r)
  })
  ok(badRule.length === 0, '规则目标无悬空' + (badRule.length ? ': ' + badRule.slice(0,3) : ''))
  ok(cd.rules[cd.rules.length - 1].startsWith('MATCH,'), '最后一条是 MATCH 兜底')
  ok(cd.sniffer && cd.sniffer.enable === true, 'sniffer 已开启')
  ok(cd.dns['respect-rules'] === true, 'DNS respect-rules 已开启')

  // 规则优先级
  const idx = d => cd.rules.findIndex(r => r.startsWith(`DOMAIN-SUFFIX,${d},`))
  ok(idx('youtubei.googleapis.com') < idx('googleapis.com'), 'youtubei 先于 googleapis')
  ok(idx('youtube.com') < idx('google.com'), 'YouTube 先于 Google')
  ok(idx('ping0.cc') >= 0, 'ping0.cc 存在（出口验证用）')

  // strict 策略
  const ai = cd['proxy-groups'].find(g => g.name === '🤖 AI 服务')
  ok(ai && ai.proxies.length === 1, `AI 组 strict 生效，仅 1 个成员（实际 ${ai ? ai.proxies.length : 'N/A'}）`)
  ok(ai && ai.proxies[0] === OWN.usV2.name, 'AI 组指向自有 VLESS 节点')
  const yt = cd['proxy-groups'].find(g => g.name === '📺 YouTube')
  ok(yt && yt.proxies.length > 1 && yt.proxies[0] === '🇯🇵 日本', 'YouTube 组指向日本且有备选')
  const ap = cd['proxy-groups'].find(g => g.name === '🍎 Apple')
  ok(ap && ap.proxies[0] === 'DIRECT', 'Apple 组指向直连')
}

sec('3. Clash 黑名单模式')
try {
  const bd = yaml.load(T.genClash(true, up, P, LIB, OWN, SET))
  ok(bd.rules[bd.rules.length - 1] === 'MATCH,DIRECT', '黑名单模式兜底为 DIRECT')
} catch (e) { ok(false, '黑名单模式解析失败: ' + e.message) }

sec('4. sing-box JSON')
let sd = null
try { sd = JSON.parse(T.genSB(up, P, LIB, OWN, SET)); ok(true, 'JSON 可解析') } catch (e) { ok(false, 'JSON 失败: ' + e.message) }
if (sd) {
  const tags = new Set(sd.outbounds.map(o => o.tag))
  let miss = []
  sd.outbounds.forEach(o => (o.outbounds || []).forEach(x => { if (!tags.has(x)) miss.push(`${o.tag}→${x}`) }))
  sd.route.rules.forEach(r => { if (r.outbound && !tags.has(r.outbound)) miss.push(`rule→${r.outbound}`) })
  if (sd.route.final && !tags.has(sd.route.final)) miss.push('final→' + sd.route.final)
  ok(miss.length === 0, 'outbound 引用完整' + (miss.length ? ': ' + miss.slice(0,3) : ''))
  ok(tags.has('direct-out') && tags.has('block-out'), 'direct-out / block-out 均已定义')
  const aiSb = sd.outbounds.find(o => o.tag === '🤖 AI 服务')
  ok(aiSb && aiSb.outbounds.length === 1, 'sing-box AI 组同样 strict')
  const apSb = sd.outbounds.find(o => o.tag === '🍎 Apple')
  ok(apSb && apSb.outbounds[0] === 'direct-out', 'Apple 组 DIRECT 已映射为 direct-out')
  const ri = d => sd.route.rules.findIndex(r => (r.domain_suffix || []).includes(d))
  ok(ri('youtubei.googleapis.com') < ri('googleapis.com'), 'sing-box 中 youtubei 先于 googleapis')
  ok(sd.dns.servers.some(s => s.tag === 'dns-remote' && s.detour === OWN.usV2.name), 'DNS 走代理出口')
}

sec('5. 分享链接（v2rayN / base64）')
const b64 = T.genShare(up, OWN)
let links = []
try {
  links = Buffer.from(b64, 'base64').toString('utf8').split('\n').filter(Boolean)
  ok(true, 'base64 可解码')
} catch (e) { ok(false, 'base64 解码失败') }
ok(links.length === 37, `链接数 37（实际 ${links.length}）`)
const schemes = [...new Set(links.map(l => l.split('://')[0]))]
ok(schemes.every(s => ['vless','hysteria2','trojan','anytls','ss','vmess'].includes(s)), '协议头合法: ' + schemes.join(','))
let badUrl = links.filter(l => { try { new URL(l); return false } catch { return true } })
ok(badUrl.length === 0, '所有链接可被 URL 解析' + (badUrl.length ? ': ' + badUrl[0] : ''))
const vl = links.find(l => l.startsWith('vless://'))
ok(vl && vl.includes('security=reality') && vl.includes('pbk=') && vl.includes('sid='), 'VLESS 含 Reality 参数')
// vmess 的名字在 base64 JSON 的 ps 字段里，按规范就没有 # 锚点，不能一刀切要求
const noName = links.filter(l => {
  if (!l.startsWith('vmess://')) return !l.includes('#')
  try { return !JSON.parse(Buffer.from(l.slice(8), 'base64').toString('utf8')).ps } catch (e) { return true }
})
ok(noName.length === 0, '所有链接都带得出名称' + (noName.length ? ': ' + noName[0].slice(0, 40) : ''))
// 上游的 vless / vmess 以前整条导不出来，导出的那些也丢了传输层参数
const upWs = links.find(l => l.startsWith('vless://') && l.includes('type=ws'))
ok(upWs && /[?&]path=/.test(upWs) && /[?&]host=/.test(upWs), '上游 VLESS+ws 带出 path 与 Host')
const upVmess = links.find(l => l.startsWith('vmess://'))
let vmj = null
try { vmj = JSON.parse(Buffer.from(upVmess.slice(8), 'base64').toString('utf8')) } catch (e) {}
ok(vmj && vmj.net === 'ws' && vmj.path === '/vm' && vmj.host === 'example.invalid' && vmj.tls === 'tls',
  'VMess 带出 ws 传输层与 tls' + (vmj ? '' : '（解析失败）'))

sec('6. 目标解析与边界')
ok(T.resolveTarget('direct', [], OWN) === 'DIRECT', 'direct → DIRECT')
ok(T.resolveTarget('reject', [], OWN) === 'REJECT', 'reject → REJECT')
ok(T.resolveTarget('own:usV2', [], OWN) === OWN.usV2.name, 'own:usV2 → 节点名')
ok(T.resolveTarget('region:jp', ['jp'], OWN) === '🇯🇵 日本', 'region:jp（有节点）→ 地区组')
ok(T.resolveTarget('region:jp', [], OWN) === '🚀 节点选择', 'region:jp（无节点）→ 回退，不产生悬空')
ok(T.resolveTarget('own:notexist', [], OWN) === '🚀 节点选择', '不存在的自有节点 → 回退')
ok(T.resolveTarget('garbage', [], OWN) === '🚀 节点选择', '非法 target → 回退')

sec('7. 域名合并与去重')
const merged = T.policyDomains({ presets: ['ai', 'aitest'], domains: ['ai.test', 'AI.TEST', ' ping0.cc '] }, LIB)
ok(new Set(merged).size === merged.length, '合并后无重复')
ok(merged.includes('ai.test') && !merged.includes('AI.TEST'), '大小写归一')
ok(merged.filter(d => d === 'ping0.cc').length === 1, '与预置集重复的域名只保留一次')

sec('8. 空数据边界')
try {
  const e1 = yaml.load(T.genClash(false, [], P, LIB, OWN, SET))
  ok(e1.proxies.length === 2, '无机场节点时仍输出 2 个自有节点')
  const g = e1['proxy-groups'].find(x => x.name === '📺 YouTube')
  ok(g && !g.proxies.includes(undefined), 'YouTube 组在无日本节点时不产生 undefined')
  const valid2 = new Set([...e1.proxies.map(p => p.name), ...e1['proxy-groups'].map(x => x.name), 'DIRECT', 'REJECT'])
  let d2 = []
  e1['proxy-groups'].forEach(x => (x.proxies || []).forEach(y => { if (!valid2.has(y)) d2.push(`${x.name}→${y}`) }))
  ok(d2.length === 0, '空节点场景无悬空引用' + (d2.length ? ': ' + d2.slice(0,3) : ''))
  const s2 = JSON.parse(T.genSB([], P, LIB, OWN, SET))
  const t2 = new Set(s2.outbounds.map(o => o.tag))
  let m2 = []
  s2.outbounds.forEach(o => (o.outbounds || []).forEach(x => { if (!t2.has(x)) m2.push(`${o.tag}→${x}`) }))
  ok(m2.length === 0, 'sing-box 空节点场景无悬空' + (m2.length ? ': ' + m2.slice(0,3) : ''))
  ok(T.genShare([], OWN).length > 0, '空机场时分享链接仍有自有节点')
} catch (e) { ok(false, '空数据场景异常: ' + e.message) }

sec('9. 策略全禁用')
try {
  const off = P.map(p => ({ ...p, enabled: false }))
  const od = yaml.load(T.genClash(false, up, off, LIB, OWN, SET))
  ok(od.rules.length > 0 && od.rules[od.rules.length - 1].startsWith('MATCH'), '全禁用时仍有基础规则与兜底')
  ok(od['proxy-groups'].length >= 2, '全禁用时仍保留节点选择组')
} catch (e) { ok(false, '全禁用场景异常: ' + e.message) }


sec('10. 管理端 UI 静态检查')
{
  const ui = T.adminHTML(true, true)
  // 入场/退场必须是不同的 animation-name，否则浏览器不重启动画，
  // animationend 不触发，弹窗遮罩会永久残留把页面卡死。
  const anim = sel => (ui.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\{[^}]*animation:\\s*([A-Za-z0-9_-]+)')) || [])[1]
  const bdIn = anim('.bd'), bdOut = anim('.bd.out')
  const mdIn = anim('.md'), mdOut = anim('.bd.out .md')
  ok(bdIn && bdOut && bdIn !== bdOut, `遮罩入场/退场动画名不同（${bdIn} vs ${bdOut}）`)
  ok(mdIn && mdOut && mdIn !== mdOut, `面板入场/退场动画名不同（${mdIn} vs ${mdOut}）`)
  ok(!/animation:\s*(\w+)[^;]*reverse/.test(ui), '未使用 reverse 复用同名动画')
  // 关闭路径必须有超时兜底，动画被禁用时也要能移除
  ok(/setTimeout\(done,\s*\d+\)/.test(ui), '弹窗关闭有超时兜底')
  ok(ui.includes('toasts') && /setTimeout\(\(\) => el\.remove\(\),\s*\d+\)/.test(ui), 'toast 移除有超时兜底')
  ok(!/onclick="[^"]*confirm\(/.test(ui) && !ui.includes('window.confirm'), '无原生 confirm')
  // 下拉遮挡曾用 .card.front 抬升卡片层级来解，但那只对付得了兄弟卡片相互遮挡；
  // 弹窗里的 overflow:auto 会直接裁掉面板，抬多高都没用。现改为展开时挪到 body
  // 用 fixed 定位，两种情形一并解决 —— 详见「下拉面板脱离滚动容器」一节。
  ok(ui.includes('document.body.appendChild(pop)'), '下拉展开时脱离原容器')
  // 同一标签写两个 style，后者会被浏览器静默丢弃
  ok(!/<[^>]+style="[^"]*"[^>]*style="/.test(ui), '无重复 style 属性')
  // 拖拽须实时让位而非 drop 时才换位；FLIP 负责位移动画
  ok(ui.includes('list.insertBefore(src, ref)') && ui.includes('ondragover'), '拖拽在 dragover 阶段实时让位')
  ok(/const flip = \(mutate\)/.test(ui) && ui.includes('getBoundingClientRect'), '存在 FLIP 位移动画')
  ok(ui.includes('persistOrder'), '落定后才回写顺序，拖动过程不反复保存')
  ok(ui.includes("grip.addEventListener('mousedown'"), '仅手柄可发起拖动')
  // 开关必须就地更新，重渲染会让整列表重播入场动画造成跳动
  ok(ui.includes('function paintSwitch'), '开关就地更新而非重建列表')
  ok(!/onclick="toggle\('[^']*',[^,)]*\)"/.test(ui), '节点开关调用点已传 this')
  ok(!/\.pol\.over\{/.test(ui), '旧的 .over 边框提示已移除')
  // 「都不选」必须是可达状态，不能在清空时自动跳回「全部」
  ok(!ui.includes("if (!box.querySelector('.chip.on')) allc.classList.add('on')"), '多选不再强制回落到「全部」')
  ok(ui.includes('function paintChips'), '多选有三态状态提示')
  ok(ui.includes('不包含任何'), '「都不选」有明确文案提示')
}


sec('11. 自有节点可配置')
{
  // 自定义单节点：换名换协议，配置应完整透传
  const custom = { myjp: { name:'东京自建', type:'hysteria2', s:'jp.example.com', p:8443, u:'pass123', sni:'jp.example.com', obfs:'salamander', opwd:'ob123', ports:'40000-40010' } }
  const pol2 = [{ id:'ai', name:'🤖 AI', target:'own:myjp', strict:true, enabled:true, presets:['ai'], domains:[], keywords:[], processes:[] }]
  const d = yaml.load(T.genClash(false, up, pol2, LIB, custom, SET))
  const names = d.proxies.map(x => x.name)
  ok(names.includes('东京自建') && !names.includes('美西-AI-Vision'), '自定义节点替换了默认节点')
  const node = d.proxies.find(x => x.name === '东京自建')
  ok(node.type === 'hysteria2' && node.ports === '40000-40010', 'Hysteria2 端口跳跃透传')
  const g = d['proxy-groups'].find(x => x.name === '🤖 AI')
  ok(g && g.proxies.length === 1 && g.proxies[0] === '东京自建', 'strict 策略指向自定义节点')

  const sb = JSON.parse(T.genSB(up, pol2, LIB, custom, SET))
  const tags = new Set(sb.outbounds.map(o => o.tag))
  let m = []
  sb.outbounds.forEach(o => (o.outbounds||[]).forEach(x => { if(!tags.has(x)) m.push(x) }))
  ok(m.length === 0, 'sing-box 自定义节点无悬空引用')
  ok(sb.dns.servers.find(x => x.tag === 'dns-remote').detour === '东京自建', 'DNS detour 跟随自有节点')

  // 自有节点全空：不能生成指向不存在 outbound 的 detour
  ok(T.aiPrimary({}) === '🚀 节点选择', '无自有节点时 aiPrimary 回退')
  const sb0 = JSON.parse(T.genSB(up, P, LIB, {}, SET))
  const t0 = new Set(sb0.outbounds.map(o => o.tag))
  ok(t0.has(sb0.dns.servers.find(x => x.tag === 'dns-remote').detour), '空自有节点时 DNS detour 仍指向存在的 outbound')
  const d0 = yaml.load(T.genClash(false, up, P, LIB, {}, SET))
  const v0 = new Set([...d0.proxies.map(x=>x.name), ...d0['proxy-groups'].map(x=>x.name), 'DIRECT','REJECT'])
  let dg = []
  d0['proxy-groups'].forEach(x => (x.proxies||[]).forEach(y => { if(!v0.has(y)) dg.push(y) }))
  ok(dg.length === 0, '空自有节点时 Clash 无悬空引用')

  // 多节点：分享链接数量随配置变化
  const two = { a:{name:'A',type:'vless',s:'a.com',p:443,u:'u1',sni:'s',pk:'p',sid:'1',net:'tcp',flow:'xtls-rprx-vision'},
                b:{name:'B',type:'hysteria2',s:'b.com',p:8443,u:'u2',sni:'s',obfs:'salamander',opwd:'o'} }
  const links = Buffer.from(T.genShare([], two), 'base64').toString('utf8').split('\n').filter(Boolean)
  ok(links.length === 2, `分享链接数跟随自有节点（${links.length}）`)
  ok(links[0].startsWith('vless://') && links[1].startsWith('hysteria2://'), '两种协议链接均正确生成')
}


sec('12. 多订阅档案')
{
  const own2 = { a:{name:'节点A',type:'vless',s:'a.com',p:443,u:'u',sni:'s',pk:'p',sid:'1',net:'tcp',flow:'xtls-rprx-vision'},
                 b:{name:'节点B',type:'hysteria2',s:'b.com',p:8443,u:'u2',sni:'s',obfs:'salamander',opwd:'o'} }
  const pol2 = [
    { id:'ai',    name:'AI',    target:'own:a', strict:true,  enabled:true, presets:['ai'],   domains:[], keywords:[], processes:[] },
    { id:'media', name:'流媒体', target:'all',   strict:false, enabled:true, presets:['media'],domains:[], keywords:[], processes:[] }
  ]

  // 全量档案
  const full = { own:'all', ups:'all', regions:'all', pols:'all' }
  const rf = T.applyProfile(full, own2, up, pol2)
  ok(Object.keys(rf.own).length === 2 && rf.up.length === up.length && rf.policies.length === 2, 'all 档案不裁剪任何内容')

  // 只保留一个自有节点 + 只保留日本地区 + 只保留一条策略
  const slim = { own:['a'], ups:'all', regions:['jp'], pols:['ai'] }
  const rs = T.applyProfile(slim, own2, up, pol2)
  ok(Object.keys(rs.own).length === 1 && rs.own.a, '自有节点白名单生效')
  ok(rs.up.length > 0 && rs.up.every(n => n.region === 'jp'), `地区白名单生效（保留 ${rs.up.length} 个日本节点）`)
  ok(rs.policies.length === 1 && rs.policies[0].id === 'ai', '策略白名单生效')

  // 裁剪后的配置仍须自洽：流媒体策略被裁掉，不能残留指向它的规则
  const d = yaml.load(T.genClash(false, rs.up, rs.policies, LIB, rs.own, SET))
  const gn = new Set(d['proxy-groups'].map(g => g.name))
  ok(!gn.has('流媒体'), '被裁掉的策略不再生成分组')
  ok(!d.rules.some(r => r.endsWith(',流媒体')), '被裁掉的策略不再生成规则')
  const valid = new Set([...d.proxies.map(x=>x.name), ...gn, 'DIRECT','REJECT'])
  let dang = []
  d['proxy-groups'].forEach(g => (g.proxies||[]).forEach(x => { if(!valid.has(x)) dang.push(x) }))
  d.rules.forEach(r => { const t = r.split(',').pop().trim(); if (t!=='no-resolve' && !valid.has(t)) dang.push(r) })
  ok(dang.length === 0, '裁剪后无悬空引用' + (dang.length ? ': ' + dang.slice(0,2) : ''))
  ok(d.proxies.every(x => x.name !== '节点B'), '未选中的自有节点不出现在 proxies')

  // 机场源白名单：给一个不存在的 id，应过滤掉所有机场节点但仍保留自有节点
  const noUp = T.applyProfile({ own:'all', ups:['nonexist'], regions:'all', pols:'all' }, own2, up, pol2)
  ok(noUp.up.length === 0 && Object.keys(noUp.own).length === 2, '机场白名单不匹配时只剩自有节点')
  const d2 = yaml.load(T.genClash(false, noUp.up, noUp.policies, LIB, noUp.own, SET))
  ok(d2.proxies.length === 2, '仅自有节点时配置仍可生成')
  const v2 = new Set([...d2.proxies.map(x=>x.name), ...d2['proxy-groups'].map(x=>x.name), 'DIRECT','REJECT'])
  let dg2 = []
  d2['proxy-groups'].forEach(g => (g.proxies||[]).forEach(x => { if(!v2.has(x)) dg2.push(x) }))
  ok(dg2.length === 0, '机场全被裁掉时无悬空引用')

  // 默认档案必须沿用现有 token，否则升级后老客户端全部掉线
  ok(T.DEFAULT_PROFILES.length === 1 && T.DEFAULT_PROFILES[0].enabled, '默认档案存在且启用')
  ok(T.DEFAULT_PROFILES[0].token === '', '默认档案 token 由部署时注入，代码里不硬编码')
  ok(T.DEFAULT_PROFILES[0].own === 'all' && T.DEFAULT_PROFILES[0].pols === 'all', '默认档案不裁剪，等价于升级前行为')
}


sec('13. 订阅专属分流策略')
{
  const own3 = { us:{name:'美西',type:'vless',s:'a.com',p:443,u:'u',sni:'s',pk:'p',sid:'1',net:'tcp',flow:'xtls-rprx-vision'} }
  const globalPols = [
    { id:'ai', name:'AI', target:'own:us', strict:true, enabled:true, presets:['ai'], domains:[], keywords:[], processes:[] }
  ]
  // 两份订阅：同名 AI 策略，一个指美西、一个指日本，域名也不同
  const pfA = { own:'all', ups:'all', regions:'all', pols:'all',
    policies:[{ id:'ai', name:'AI', target:'own:us', strict:true, enabled:true, presets:['ai'], domains:['a-only.com'], keywords:[], processes:[] }] }
  const pfB = { own:'all', ups:'all', regions:'all', pols:'all',
    policies:[{ id:'ai', name:'AI', target:'region:jp', strict:false, enabled:true, presets:[], domains:['b-only.com'], keywords:[], processes:[] }] }

  const rA = T.applyProfile(pfA, own3, up, globalPols)
  const rB = T.applyProfile(pfB, own3, up, globalPols)
  ok(rA.policies[0].target === 'own:us' && rB.policies[0].target === 'region:jp', '同名策略在两份订阅指向不同目标')

  const dA = yaml.load(T.genClash(false, rA.up, rA.policies, LIB, rA.own, SET))
  const dB = yaml.load(T.genClash(false, rB.up, rB.policies, LIB, rB.own, SET))
  const gA = dA['proxy-groups'].find(g => g.name === 'AI')
  const gB = dB['proxy-groups'].find(g => g.name === 'AI')
  ok(gA.proxies.length === 1 && gA.proxies[0] === '美西', '订阅A 的 AI 组 strict 指向美西')
  ok(gB.proxies[0] === '🇯🇵 日本' && gB.proxies.length > 1, '订阅B 的 AI 组指向日本且有备选')
  ok(dA.rules.some(r => r === 'DOMAIN-SUFFIX,a-only.com,AI') && !dA.rules.some(r => r.includes('b-only.com')), '订阅A 只含自己的域名')
  ok(dB.rules.some(r => r === 'DOMAIN-SUFFIX,b-only.com,AI') && !dB.rules.some(r => r.includes('a-only.com')), '订阅B 只含自己的域名')
  ok(dA.rules.some(r => r.includes('anthropic.com')) && !dB.rules.some(r => r.includes('anthropic.com')), '预置集引用差异生效（A 引用 ai 集，B 不引用）')

  // 继承模式：不带 policies 时回落全局
  const pfI = { own:'all', ups:'all', regions:'all', pols:'all', policies:'inherit' }
  const rI = T.applyProfile(pfI, own3, up, globalPols)
  ok(rI.policies.length === 1 && rI.policies[0].target === 'own:us', '继承模式回落到全局策略')
  ok(T.profilePolicies(pfI, globalPols) === globalPols, 'profilePolicies 继承时返回全局引用')
  ok(T.profilePolicies(pfA, globalPols)[0].domains[0] === 'a-only.com', 'profilePolicies 专属时返回自己的')

  // 继承 + pols 白名单裁剪仍然有效
  const twoG = [...globalPols, { id:'x', name:'X', target:'all', strict:false, enabled:true, presets:[], domains:['x.com'], keywords:[], processes:[] }]
  const rP = T.applyProfile({ own:'all', ups:'all', regions:'all', pols:['ai'], policies:'inherit' }, own3, up, twoG)
  ok(rP.policies.length === 1 && rP.policies[0].id === 'ai', '继承模式下 pols 白名单仍生效')

  // 专属策略里被停用的条目不应下发
  const pfOff = { own:'all', ups:'all', regions:'all', pols:'all',
    policies:[{ id:'ai', name:'AI', target:'own:us', strict:true, enabled:false, presets:['ai'], domains:[], keywords:[], processes:[] }] }
  ok(T.applyProfile(pfOff, own3, up, globalPols).policies.length === 0, '专属策略中已停用的条目被过滤')

  // 默认档案保持继承，升级后行为不变
  ok(T.DEFAULT_PROFILES[0].policies === 'inherit', '默认档案为继承模式')
}


sec('14. 订阅内容三态筛选')
{
  const own4 = { us:{name:'美西',type:'vless',s:'a.com',p:443,u:'u',sni:'s',pk:'p',sid:'1',net:'tcp',flow:'xtls-rprx-vision'} }
  const pol4 = [{ id:'m', name:'流媒体', target:'all', strict:false, enabled:true, presets:['media'], domains:[], keywords:[], processes:[] }]

  // 空数组 = 一个都不包含（给别人的订阅不带自建节点）
  const noOwn = T.applyProfile({ own:[], ups:'all', regions:'all', pols:'all' }, own4, up, pol4)
  ok(Object.keys(noOwn.own).length === 0, '自有节点空数组 = 一个都不包含')
  ok(noOwn.up.length === up.length, '清空自有节点不影响机场节点')

  const d = yaml.load(T.genClash(false, noOwn.up, noOwn.policies, LIB, noOwn.own, SET))
  ok(!d.proxies.some(x => x.name === '美西'), '自建节点确实未出现在订阅里')
  ok(d.proxies.length === up.length, `订阅只剩机场节点（${d.proxies.length}）`)
  const valid = new Set([...d.proxies.map(x=>x.name), ...d['proxy-groups'].map(x=>x.name), 'DIRECT','REJECT'])
  let dang = []
  d['proxy-groups'].forEach(g => (g.proxies||[]).forEach(x => { if(!valid.has(x)) dang.push(x) }))
  d.rules.forEach(r => { const t=r.split(',').pop().trim(); if(t!=='no-resolve' && !valid.has(t)) dang.push(r) })
  ok(dang.length === 0, '无自有节点时仍无悬空引用' + (dang.length ? ': ' + dang.slice(0,2) : ''))

  // sing-box 的 DNS detour 原本指向第一个自有节点，这里必须回退
  const sb = JSON.parse(T.genSB(noOwn.up, noOwn.policies, LIB, noOwn.own, SET))
  const tags = new Set(sb.outbounds.map(o => o.tag))
  ok(tags.has(sb.dns.servers.find(x => x.tag==='dns-remote').detour), '无自有节点时 DNS detour 仍指向存在的 outbound')

  // 三态互不混淆
  ok(T.applyProfile({own:'all',ups:'all',regions:'all',pols:'all'}, own4, up, pol4).own.us, "'all' 表示全部")
  ok(T.applyProfile({own:['us'],ups:'all',regions:'all',pols:'all'}, own4, up, pol4).own.us, '白名单表示指定')
  ok(!T.applyProfile({own:[],ups:'all',regions:'all',pols:'all'}, own4, up, pol4).own.us, '空数组表示都不选')

  // 只留自有节点、不要任何机场
  const noUp = T.applyProfile({ own:'all', ups:[], regions:'all', pols:'all' }, own4, up, pol4)
  ok(noUp.up.length === 0 && Object.keys(noUp.own).length === 1, '机场源清空后只剩自有节点')
}


sec('15. 加载路径与缓存策略')
{
  const src = fs.readFileSync(require('path').join(__dirname,'..','worker.js'), 'utf8')
  // 管理端的列表类接口一律不得同步触发上游拉取
  const polBlock = src.slice(src.indexOf("if (p === '/api/policies')"), src.indexOf("if (p === '/api/profiles')"))
  const prfBlock = src.slice(src.indexOf("if (p === '/api/profiles')"), src.indexOf("if (p === '/api/own')"))
  ok(!polBlock.includes('activeNodes('), '策略接口不触发上游拉取')
  ok(!prfBlock.includes('activeNodes('), '档案接口不触发上游拉取')
  ok(polBlock.includes('cachedNodes()') && prfBlock.includes('cachedNodes()'), '两者改用缓存读取')
  // 订阅输出与 state 走 SWR，过期时后台刷新而非同步等待
  ok(src.includes('async function swrNodes'), '存在 SWR 取节点函数')
  ok(/swrNodes\(event\)/.test(src), 'SWR 已被使用')
  ok(src.includes('event.waitUntil(loadNodes(true, event)'), '过期时在后台刷新')
  const handleBlock = src.slice(src.indexOf('async function handle(req, event)'), src.indexOf('// ---------- 管理端路由'))
  ok(!handleBlock.includes('activeNodes(false'), '订阅输出不再同步等待全量拉取')

  const ui = T.adminHTML(true, true)
  // 每个 tab 只拉自己需要的数据，且并行
  ok(ui.includes("if (TAB === 'sub' && !PRF)") && ui.includes("if ((TAB === 'pol' || TAB === 'lib') && !POL)"), '各 tab 精确加载')
  ok(!ui.includes("if (TAB !== 'node' && !POL)"), '订阅页不再连带加载策略数据')
  ok(ui.includes('await Promise.all(jobs)'), '多个接口并行请求')
  ok(ui.includes('function tabSkeleton'), '切 tab 有骨架反馈')
  ok(ui.includes("if (t === TAB) return"), '重复点击当前 tab 不重复渲染')
  // 只改 overrides 的操作不应清空整份 state
  ok(/const r = await api\('\/api\/node', \{key, name: v\}\)/.test(ui), '重命名本地同步而非整页重拉')
  ok(ui.includes('n.auto'), 'state 携带 auto 名称以便本地恢复自动命名')
  // 顶栏必须常驻做增量更新；整页 innerHTML 会让入场动画每次重播，表现为切 tab 时上方闪烁
  ok(ui.includes('function paintHeader'), '顶栏独立渲染')
  ok(ui.includes("document.getElementById('body').innerHTML ="), '只重建内容区')
  ok(ui.includes("hdr.querySelector('.lede').innerHTML"), '顶栏走增量更新而非重建')
  ok(!/app\.innerHTML = h\b/.test(ui), '不再整页 innerHTML 重建')
  ok(ui.includes("if (body) { body.innerHTML = cards; return }"), '骨架屏同样只换内容区')
  ok(!/<div class="top anim"/.test(ui), '顶栏不再挂入场动画类')
  // 列宽须由父容器统一决定，每行独立 grid 时行与行不会对齐
  ok(/\.up\{[^}]*grid-template-columns:subgrid/.test(ui), '行使用 subgrid 继承父列轨道')
  ok(/\.uplist\.src\{grid-template-columns:/.test(ui) && /\.uplist\.own\{grid-template-columns:/.test(ui), '父容器定义了列轨道')
  ok(!/\.up\{[^}]*margin-bottom/.test(ui), '行间距交给父容器 gap，避免与 subgrid 冲突')
  // 用量三元素必须是平级列，缺项占位以保证列数恒定
  ok(ui.includes("const blank = '<span></span>'") && ui.includes('return bar + traffic + exp'), '用量拆为独立列并占位')
  // 只针对订阅源用量：策略行也有个叫 meta 的说明文字，与此无关
  ok(!/\.up \.meta\{display:flex/.test(ui), '订阅源用量不再用 flex 包裹')
  ok(!/return .*<span class="meta">/.test(ui.slice(ui.indexOf('function upMeta'), ui.indexOf('function tgtLabel'))), 'upMeta 返回平级元素')
  // 折叠
  ok(ui.includes("localStorage.setItem('rgcoll'"), '折叠状态持久化')
  ok(ui.includes('grid-template-rows:0fr'), '折叠用 grid-template-rows 动画')
  ok(ui.includes('window.foldAll'), '支持一键展开/收起')
  ok(ui.includes('class="src"') || ui.includes("class=\"src\""), '地区标题显示机场来源')
}


sec('16. 机场元信息解析（多家格式兼容）')
{
  const GB = 1073741824, TB = 1099511627776
  const day = 86400

  // —— 标准 Subscription-Userinfo 头 ——
  const h1 = T.parseUserinfo('upload=98135617755; download=321529098078; total=1288490188800; expire=1786369501')
  ok(h1 && h1.total === 1288490188800 && h1.expire === 1786369501, '标准头解析（标准 Subscription-Userinfo）')
  ok(T.parseUserinfo('upload=1; download=2; total=3; expire=1786369501000').expire === 1786369501, '毫秒时间戳自动归一')
  ok(T.parseUserinfo('total=100,expire=200').total === 100, '逗号分隔的头也认')
  ok(T.parseUserinfo('') === null && T.parseUserinfo(null) === null, '空头返回 null')
  ok(T.parseUserinfo('garbage') === null, '无法解析的头返回 null')

  // —— 单位换算 ——
  ok(T.toBytes(1, 'GB') === GB && T.toBytes(1, 'TB') === TB, 'GB/TB 换算')
  ok(T.toBytes(1, 'G') === GB && T.toBytes(1, 'GiB') === GB, '简写与 GiB 均按二进制处理')

  // —— 公告文本兜底：日期格式 ——
  ok(T.parseNotes(['套餐到期：2026-08-10']).expire > 0, '日期 2026-08-10')
  ok(T.parseNotes(['到期时间: 2026/08/10']).expire > 0, '日期 2026/08/10')
  ok(T.parseNotes(['有效期至 2026年8月10日']).expire > 0, '日期 2026年8月10日')
  const e1 = T.parseNotes(['套餐到期：2026-08-10']).expire
  const e2 = T.parseNotes(['到期时间: 2026/08/10']).expire
  ok(e1 === e2, '不同写法解析出同一时刻')

  // —— 公告文本兜底：流量写法 ——
  ok(T.parseNotes(['剩余流量：809.16 GB']).left === T.toBytes(809.16,'GB'), '剩余流量：N GB')
  ok(T.parseNotes(['剩余: 100GB']).left === 100*GB, '剩余: NGB（无空格）')
  ok(T.parseNotes(['Remaining: 50 GB']).left === 50*GB, '英文 Remaining')
  ok(T.parseNotes(['总量：1.2 TB']).total === T.toBytes(1.2,'TB'), '总量 TB')
  ok(T.parseNotes(['已用 390.8GB']).used === T.toBytes(390.8,'GB'), '已用')
  const combo = T.parseNotes(['流量：390.8GB/1200GB'])
  ok(combo.used === T.toBytes(390.8,'GB') && combo.total === 1200*GB, '组合写法 已用/总量')

  // —— 公告文本兜底：天数 ——
  ok(T.parseNotes(['距离下次重置剩余：7 天']).reset === 7, '重置天数')
  ok(!T.parseNotes(['距离下次重置剩余：7 天']).expire, '重置天数不被误当作到期')
  const d30 = T.parseNotes(['剩余 30 天'])
  ok(d30.expire > Date.now()/1000 + 29*day && d30.expire < Date.now()/1000 + 31*day, '「剩余 N 天」换算为到期时间戳')

  // —— 合并策略：头优先、公告补缺 ——
  const m1 = T.mergeMeta({up:1,down:2,total:100,expire:500}, {total:999,expire:888})
  ok(m1.total === 100 && m1.expire === 500, '头有值时不被公告覆盖')
  const m2 = T.mergeMeta({up:0,down:0,total:1000*GB,expire:0}, {expire:12345, left:400*GB})
  ok(m2.expire === 12345, '头缺到期时用公告补')
  ok(m2.down === 600*GB, '头缺用量时由「总量-剩余」反推')
  const m3 = T.mergeMeta(null, {used: 10*GB, total: 100*GB, expire: 777})
  ok(m3 && m3.total === 100*GB && m3.down === 10*GB && m3.expire === 777, '完全没有头时纯靠公告')
  const m4 = T.mergeMeta(null, {left: 50*GB})
  ok(m4 && m4.total === 50*GB && m4.down === 0, '只知剩余时按剩余展示')
  ok(T.mergeMeta(null, {}) === null && T.mergeMeta(null, null) === null, '什么都解析不到返回 null，不瞎猜')

  // —— 公告识别：该抓的抓到，正常节点名不能误杀 ——
  const notices = ['剩余流量：809.16 GB','距离下次重置剩余：7 天','套餐到期：2026-08-10',
                   '如果很少节点可用，去官网更新软件','建议每天更新一次订阅','到期时间: 2026/08/10',
                   'Expire: 2026-08-10','Traffic: 100GB','官网更新地址','续费请联系客服']
  const reals = ['香港原生IP-1|勿跑大流量','台湾1|5x倍率|勿跑大流量','2x专线-日本-1',
                 '美国洛杉矶|高速下载','新加坡1|高速下载|移动优化','🇯🇵 日本 01','韩国|移动优化','美西-AI-Vision']
  const missed = notices.filter(x => !T.JUNK.test(x))
  const killed = reals.filter(x => T.JUNK.test(x))
  ok(missed.length === 0, '公告条目全部识别' + (missed.length ? ': ' + missed : ''))
  ok(killed.length === 0, '正常节点名零误杀' + (killed.length ? ': ' + killed : ''))

  // —— 真实样本回归：同一份订阅的头与公告应互相印证 ——
  const real = T.mergeMeta(
    T.parseUserinfo('upload=98135617755; download=321529098078; total=1288490188800; expire=1786369501'),
    T.parseNotes(['剩余流量：809.16 GB','距离下次重置剩余：7 天','套餐到期：2026-08-10']))
  const leftGB = (real.total - real.up - real.down) / GB
  ok(Math.abs(leftGB - 809.16) < 1, `实际剩余算出 ${leftGB.toFixed(2)} GB，与公告 809.16 GB 吻合`)
  ok(new Date(real.expire*1000).toISOString().slice(0,10) === '2026-08-10', '到期日与公告一致')
}


sec('17. 管理端 JS 可执行性')
{
  // worker.js 本身语法正确，不代表它拼出来的 HTML 里的 JS 也正确。
  // 模板字符串里写 '\n' 会被解析成真实换行，生成断行的字符串字面量，
  // 整个 script 直接崩溃 —— 表现就是管理端白屏。这一关必须单独把。
  const { execFileSync } = require('child_process')
  const os = require('os'), path = require('path')
  for (const [authed, inited, label] of [[true, true, '已登录'], [false, false, '首次初始化'], [false, true, '登录页']]) {
    const html = T.adminHTML(authed, inited)
    const m = html.match(/<script>([\s\S]*?)<\/script>/)
    ok(!!m, `${label}：能提取到 script`)
    if (!m) continue
    const f = path.join(os.tmpdir(), `admin_${authed}_${inited}.js`)
    fs.writeFileSync(f, m[1])
    let err = ''
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) }
    catch (e) { err = String(e.stderr || e.message).split('\n').slice(0, 3).join(' ') }
    ok(!err, `${label}：JS 语法正确` + (err ? ` → ${err}` : ''))
    fs.unlinkSync(f)
  }
  // 模板里的换行转义必须是 \\n，写成 \n 会被提前解析掉
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8')
  const uiStart = src.indexOf('function adminHTML')
  const uiSrc = src.slice(uiStart)
  const bad = src.slice(uiStart).split('\n').filter(l => /\.(split|join)\('\\n'\)/.test(l) && !/\\\\n/.test(l))
  // 目标失效必须在界面上告警，不能任由 resolveTarget 静默降级
  ok(uiSrc.includes('const broken = ps.filter'), '检出指向失效节点的策略')
  ok(uiSrc.includes('指向的节点已不存在'), '失效目标有醒目告警')
  ok(/\.tgt\.gone\{/.test(uiSrc), '失效目标在行内有视觉标记')

  ok(bad.length === 0, '模板内换行转义正确' + (bad.length ? `：${bad[0].trim().slice(0, 60)}` : ''))
}

sec('18. 源码不含站点信息（开源前置检查）')
{
  const src = fs.readFileSync(require('path').join(__dirname,'..','worker.js'), 'utf8')
  const dep = fs.readFileSync(require('path').join(__dirname,'..','deploy.sh'), 'utf8')
  const fx  = fs.readFileSync(require('path').join(__dirname,'fixture.yaml'), 'utf8')
  const all = src + dep + fx

  // 具体值一旦写进代码，仓库公开就等于泄露。
  // 白名单：保留网段、公共 DNS、文档示例段，以及各段字符全同的明显占位符。
  const SAFE_IP = /^(0\.|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|198\.1[89]\.|203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|1\.1\.1\.1|8\.8\.8\.8|223\.5\.5\.5|119\.29\.29\.29|240\.0\.0\.0)/
  const placeholderUUID = u => u.split('-').every(seg => /^(.)\1*$/.test(seg))

  const hex32 = (all.match(/\b[0-9a-f]{32}\b/g) || [])
  ok(hex32.length === 0, '无 32 位 token/ID' + (hex32.length ? '：' + hex32[0] : ''))

  const uuids = (all.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []).filter(u => !placeholderUUID(u))
  ok(uuids.length === 0, '无真实 UUID' + (uuids.length ? '：' + uuids[0] : ''))

  ok(!/\bcf[a-z]{2}_[A-Za-z0-9]{20,}/.test(all), '无 Cloudflare API token')

  // 浏览器 UA 里的版本号（Chrome/126.0.0.0）长得和 IP 一样，先摘掉再查。
  // 只剥「产品名/版本号」这一种形状，`http://1.2.3.4` 那样的真泄露照样抓得到。
  const ipScan = all.replace(/\b[A-Za-z][\w.]*\/\d+(?:\.\d+)+/g, '')
  const ips = (ipScan.match(/\b(\d{1,3}\.){3}\d{1,3}\b/g) || []).filter(ip => !SAFE_IP.test(ip))
  ok(ips.length === 0, '无真实公网 IP' + (ips.length ? '：' + ips[0] : ''))

  // 域名同理：只允许保留给文档用的示例域名
  const doms = (all.match(/\b[a-z0-9-]+\.(xyz|top|com|net|org|cc|io|me|cn)\b/gi) || [])
    .filter(d => !/(example\.(com|invalid|org|net)|\.example\.invalid|apple\.com|google\.com|microsoft\.com|cloudflare\.com|gstatic\.com|doh\.pub|bing\.com|dns\.google|github\.(com|io)|npmjs\.com|youtube\.com|netflix\.com|openai\.com|anthropic\.com|claude\.ai)/i.test(d))
  ok(doms.length < 400, '域名均为公开服务或示例（' + doms.length + ' 项非白名单，均属分流规则库）')
  // 站点配置必须来自 KV，不能是代码常量
  ok(/const DEFAULT_NODES = \{\}/.test(src), '自有节点默认为空')
  ok(src.includes('async function loadSettings'), '站点设置从 KV 读取')
  ok(/domain: '',/.test(src), '默认域名为空')
  ok(!/OWN_DOMAIN\s*=\s*'[^']+'/.test(src), '不存在硬编码域名常量')
  ok(src.includes("typeof SETUP_TOKEN !== 'undefined'"), '初始化令牌由 Worker secret 注入')
  // 部署脚本不得内嵌账号信息
  ok(!/ACCOUNT="[0-9a-f]{32}"/.test(dep), '部署脚本无硬编码 Account ID')
  ok(!/\$HOME|~\/[.\w]/.test(dep), '部署脚本不引用本机私有路径')
}


sec('19. 分流目标多选')
{
  const own5 = { a:{name:'节点A',type:'vless',s:'a.example.com',p:443,u:'11111111-2222-3333-4444-555555555555',sni:'s',pk:'PK',sid:'01',net:'tcp',flow:'xtls-rprx-vision'},
                 b:{name:'节点B',type:'hysteria2',s:'b.example.com',p:8443,u:'11111111-2222-3333-4444-555555555555',sni:'s',obfs:'salamander',opwd:'o'} }
  const live = ['jp','hk']

  // 新旧数据格式都要认
  ok(JSON.stringify(T.targetList({target:'own:a'})) === '["own:a"]', '字符串目标兼容为单元素数组')
  ok(JSON.stringify(T.targetList({target:['own:a','region:jp']})) === '["own:a","region:jp"]', '数组目标原样保留')
  ok(JSON.stringify(T.targetList({})) === '["all"]', '缺省目标回落到 all')

  const multi = T.resolveTargets({target:['own:a','region:jp','own:b']}, live, own5)
  ok(JSON.stringify(multi) === '["节点A","🇯🇵 日本","节点B"]', '多目标按选择顺序解析')
  const dup = T.resolveTargets({target:['own:a','own:a','region:xx']}, live, own5)
  ok(dup.length === 2 && dup[0] === '节点A' && dup[1] === '🚀 节点选择', '重复与失效目标去重合并')
  ok(JSON.stringify(T.resolveTargets({target:[]}, live, own5)) === '["🚀 节点选择"]', '空目标不产生空组')

  // strict 只放选定目标，非 strict 追加兜底
  const st = T.policyMembers({strict:true}, ['节点A','🇯🇵 日本'], ['节点A','节点B'], ['🇯🇵 日本'])
  ok(JSON.stringify(st) === '["节点A","🇯🇵 日本"]', 'strict 模式只含选定目标')
  const loose = T.policyMembers({strict:false}, ['节点A'], ['节点A','节点B'], ['🇯🇵 日本'])
  ok(loose[0] === '节点A' && loose.includes('🚀 节点选择') && loose.includes('DIRECT'), '非 strict 追加兜底且目标居首')

  // 生成端：多目标策略要产出多成员的组，且无悬空
  const pol5 = [{ id:'ai', name:'AI', target:['own:a','own:b'], strict:true, enabled:true, presets:['ai'], domains:[], keywords:[], processes:[] }]
  const d = yaml.load(T.genClash(false, up, pol5, LIB, own5, SET))
  const g = d['proxy-groups'].find(x => x.name === 'AI')
  ok(g && JSON.stringify(g.proxies) === '["节点A","节点B"]', 'Clash 组内含全部选定目标')
  const valid = new Set([...d.proxies.map(x=>x.name), ...d['proxy-groups'].map(x=>x.name), 'DIRECT','REJECT'])
  let dang = []
  d['proxy-groups'].forEach(x => (x.proxies||[]).forEach(y => { if(!valid.has(y)) dang.push(y) }))
  ok(dang.length === 0, '多目标不产生悬空引用')

  const sb = JSON.parse(T.genSB(up, pol5, LIB, own5, SET))
  const gs = sb.outbounds.find(o => o.tag === 'AI')
  ok(gs && gs.outbounds.length === 2, 'sing-box 组内同样含全部目标')
  const tags = new Set(sb.outbounds.map(o => o.tag))
  ok(gs.outbounds.every(t => tags.has(t)), 'sing-box 多目标引用完整')

  // UI
  const ui = T.adminHTML(true, true)
  ok(ui.includes('function selValue'), '存在多选取值函数')
  ok(/multi\s*\?\s*picked\.join/.test(ui) || ui.includes("multi ? picked.join('|')"), '多选值序列化')
  ok(ui.includes('return          // 多选时保持展开'), '多选时面板不自动收起')
  ok(ui.includes("if (!pop.querySelector('.selo.on')) o.classList.add('on')"), '至少保留一个选中项')
  ok(ui.includes('class="tgts"'), '策略行支持展示多个目标')
  // 浏览器会另外渲染跟随鼠标的元素快照，原行若留着淡内容就成重影。
  // 正确做法是原行退成虚线落点槽：内容 opacity:0（保留行高），边框虚线。
  ok(!/\.pol\.drag \*\{visibility:hidden\}/.test(ui), '不用 visibility:hidden（会连同布局一起塌）')
  // 选择器可能与订阅源行合写成 `.pol.drag,.up.drag{…}`，别按精确字面量匹配
  ok(/\.pol\.drag[^{]*\{[^}]*dashed/.test(ui), '策略拖拽行呈虚线落点槽')
  ok(/\.pol\.drag > \*[^{]*\{[^}]*opacity:0/.test(ui), '槽内内容隐藏但保留行高')
  ok(/\.up\.drag[^{]*\{[^}]*dashed/.test(ui), '订阅源拖拽行同样是虚线落点槽')
  ok(!/\.pol\.drag\{[^}]*opacity:\s*\.\d/.test(ui), '整行不再半透明，避免与拖拽预览重叠')
  // 多选必须一眼可辨，否则只选一项时外观与单选毫无区别
  ok(/\.sel\.multi \.selo::before\{/.test(ui), '多选项有常驻复选框')
  ok(ui.includes('可多选'), '标签写明可多选')
  ok(ui.includes("'（已选 1 项）'") || ui.includes('（已选 1 项）'), '单选中项也标出已选数量')
}

sec('20. 订阅源抓取：公告位置与编码兼容')
{
  // 机场把用量写在哪儿全凭心情。以前只扫「被识别成节点的行」的名字，
  // 写在 YAML 注释里的一律看不见 —— 表现就是用量栏一片空白。
  const yaml = [
    '# 剩余流量：809.16 GB',
    '# 套餐到期：2026-09-15',
    'proxies:',
    '  - {name: "香港01", type: ss, server: 1.2.3.4, port: 443, cipher: aes-128-gcm, password: x}',
    '  - {name: "日本01", type: ss, server: 1.2.3.5, port: 443, cipher: aes-128-gcm, password: x}',
  ].join('\n')
  const a = T.splitFeed(yaml)
  ok(a.nodes.length === 2, '注释不影响节点解析')
  ok(a.notes.length === 2, '# 注释行被当作公告采集')
  const m = T.mergeMeta(null, T.parseNotes(a.notes))
  ok(!!m, '仅凭注释也能合成出用量信息')
  ok(m && m.total === Math.round(809.16 * 1073741824), '注释里的剩余流量已识别')
  ok(m && new Date(m.expire * 1000).toISOString().slice(0, 10) === '2026-09-15', '注释里的到期日已识别')

  const semi = [
    '; Traffic: 已用 390.8GB / 1200GB',
    '  - {name: "US01", type: ss, server: 1.2.3.4, port: 443, cipher: aes-128-gcm, password: x}',
  ].join('\n')
  const b = T.splitFeed(semi)
  const mb = T.mergeMeta(null, T.parseNotes(b.notes))
  ok(mb && mb.total === Math.round(1200 * 1073741824), '; 注释与英文写法同样认')

  // 含「流量」二字的正常节点名不能被误吞成公告
  const c = T.splitFeed('  - {name: "香港原生IP-1|勿跑大流量", type: ss, server: 1.2.3.4, port: 443, cipher: aes-128-gcm, password: x}')
  ok(c.nodes.length === 1 && c.notes.length === 0, '正常节点名不被误判为公告')
  // 超长行多半是整段配置，不是公告
  ok(T.splitFeed('# ' + '剩余流量：100GB '.repeat(20)).notes.length === 0, '超长行不当公告')

  // 有的机场无视 clash UA 直接吐 base64
  const inner = '  - {name: "SG01", type: ss, server: 1.2.3.4, port: 443, cipher: aes-128-gcm, password: x}'
  const b64 = Buffer.from(inner, 'utf8').toString('base64')
  ok(T.looksBase64(b64), 'base64 订阅可识别')
  ok(T.b64decode(b64) === inner, 'base64 解码正确')
  ok(!T.looksBase64('proxies:\n  - {name: a}'), '明文 YAML 不被误判为 base64')

  // 诊断样本要回显给人看，密钥必须先抹掉
  ok(!T.scrub('vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443').includes('11111111-2222'), '分享链接 UUID 已脱敏')
  ok(T.scrub('- {name: a, password: SuperSecret123}').includes('***'), 'password 字段已脱敏')
  ok(!T.scrub('https://a.com/sub?token=abcdef123456').includes('abcdef123456'), 'URL 里的 token 已脱敏')
}

sec('21. 订阅源增删的交互契约')
{
  const ui = T.adminHTML(true, true)
  // 死链接静默收下会让人以为加成功了，实际每次聚合都白等它超时
  ok(/canForce/.test(ui), '拉取失败时提供「仍然添加」的选择')
  ok(ui.includes('先试拉一次'), '添加前会试拉并告知用户')
  // 整页 dash() 会换骨架屏 + 重放入场动画，视觉上就是「闪一下」
  ok(ui.includes('async function syncUp'), '存在局部刷新函数')
  ok(/syncUp\(r\.up\)/.test(ui), '添加后走局部刷新而非整页重建')
  ok(!/toast\('已添加订阅源'\); ST = null; dash\(\)/.test(ui), '添加后不再整页 dash()')
  ok(ui.includes('function nodeCardInner'), '节点卡片可单独重绘')
  ok(ui.includes("id=\"nodecard\""), '节点卡片有独立锚点')
  // 用量拿不到时要说明白，而不是留一片空白
  ok(ui.includes('用量未知'), '无用量信息时给出明确占位')
  ok(ui.includes('window.probeUp'), '存在抓取诊断入口')
  ok(/\.up\.src \.tgt\.mute/.test(ui), '占位有独立样式')
  // 订阅链接大多自带 ?name=，没填名称时不该退回「未命名机场」
  const wsrc = fs.readFileSync(require('path').join(__dirname,'..','worker.js'), 'utf8')
  ok(wsrc.includes('name|remarks|title|flag'), '未填名称时从链接参数取名')
}

// loadNodes 要碰 KV 和网络，单独造一份带假 CONF / 假 fetch 的 worker 实例来跑
function sandbox(){
  const KV = new Map(), st = { ok: true, calls: [] }
  const CONF = {
    get: async (k, t) => { if (!KV.has(k)) return null; const v = KV.get(k); return t === 'json' ? JSON.parse(v) : v },
    put: async (k, v) => { KV.set(k, v) },
    delete: async k => { KV.delete(k) },
  }
  const fk = async (u) => {
    st.calls.push(u)
    if (!st.ok) return { ok: false, status: 403, headers: { get: () => null }, text: async () => '403' }
    return { ok: true, status: 200,
      headers: { get: k => k.toLowerCase() === 'subscription-userinfo'
        ? 'upload=0; download=1073741824; total=10737418240; expire=1790000000' : null },
      text: async () => [
        '  - {name: "日本-1", type: ss, server: 1.2.3.4, port: 443, cipher: aes-128-gcm, password: x}',
        '  - {name: "日本-2", type: ss, server: 1.2.3.5, port: 443, cipher: aes-128-gcm, password: x}',
      ].join('\n') }
  }
  const wsrc = fs.readFileSync(require('path').join(__dirname, '..', 'worker.js'), 'utf8')
  const mk = new Function('CONF','fetch','addEventListener','crypto','btoa','atob','TextEncoder','TextDecoder',
    wsrc + '\n;return {loadNodes, saveSnap, fetchUpstream, kvPut}')
  const api = mk(CONF, fk, () => {}, require('crypto').webcrypto,
    x => Buffer.from(x, 'binary').toString('base64'), x => Buffer.from(x, 'base64').toString('binary'),
    TextEncoder, TextDecoder)
  return { api, KV, st }
}

;(async () => {

sec('22. 一次性订阅链接：快照机制')
{
  // 有的机场发的是几分钟就失效的一次性链接。按「链接长期有效」的前提
  // 每小时去拉，除了第一次全是 403 —— 节点会整批消失。
  const UP = { id:'m1', name:'一次性', url:'https://ex.example.com/get?token=abc', enabled:true }

  const A = sandbox()
  await A.api.kvPut('upstreams', [UP])
  const probe = await A.api.fetchUpstream(UP)
  ok(probe.nodes.length === 2, '链接有效时正常抓到节点')
  await A.api.saveSnap('m1', probe, null)
  ok(A.KV.has('snap:m1'), '成功拉取后写入快照')

  // 链接失效但没关自动更新：不能让已经在用的节点凭空消失
  A.st.ok = false; A.KV.delete('cache:nodes'); A.st.calls = []
  let d = await A.api.loadNodes(true, null)
  ok(d.nodes.length === 2, '拉取失败时沿用快照，节点不清零')
  ok(d.errors.length === 1 && /沿用快照/.test(d.errors[0].msg), '错误信息注明已沿用快照')
  ok(!!d.snaps['m1'], 'snaps 标出哪些源用的是快照')

  // 关掉自动更新：一次性链接平时根本不该被请求
  const B = sandbox()
  await B.api.kvPut('upstreams', [{ ...UP, auto:false }])
  const p2 = await B.api.fetchUpstream(UP)
  await B.api.saveSnap('m1', p2, null)
  B.KV.delete('cache:nodes'); B.st.calls = []; B.st.ok = false
  d = await B.api.loadNodes(true, null)
  ok(B.st.calls.length === 0, 'auto=false 时完全不发请求')
  ok(d.nodes.length === 2, '节点全部由快照供给')
  ok(d.errors.length === 0, '不再产生 403 错误噪音')
  ok(!!d.meta['m1'], '用量信息也从快照恢复')

  // 但没有快照时不能干等着，否则这个源永远是空的
  const C = sandbox()
  await C.api.kvPut('upstreams', [{ ...UP, auto:false }])
  C.st.calls = []
  d = await C.api.loadNodes(true, null)
  ok(C.st.calls.length === 1, '没有快照时仍会拉一次')
  ok(d.nodes.length === 2 && C.KV.has('snap:m1'), '首拉成功并补上快照')
}

sec('23. 订阅源可编辑')
{
  const ui = T.adminHTML(true, true)
  ok(ui.includes('window.editUp'), '存在编辑入口')
  ok(ui.includes('更新方式'), '编辑弹窗可选自动/手动')
  ok(ui.includes('一次性链接'), '手动模式说明写清适用场景')
  ok(ui.includes("act:'edit'") || ui.includes('act: \'edit\''), '走 edit 接口')
  ok(ui.includes('快照 '), '行内显示快照时间')
  ok(ui.includes('function ago'), '存在相对时间函数')
  ok(/\.tag\.manual/.test(ui), '手动标记有独立样式')
  // 加了编辑按钮和拖拽手柄，网格列数必须跟着加，否则整行错位
  const cols = (ui.match(/\.uplist\.src\{grid-template-columns:([^}]+)\}/) || [])[1] || ''
  ok(cols.trim().split(/\s+/).length === 10, `订阅源行 10 列（实际 ${cols.trim().split(/\s+/).length}）`)
  const wsrc2 = fs.readFileSync(require('path').join(__dirname,'..','worker.js'), 'utf8')
  ok(wsrc2.includes("CONF.delete('snap:'"), '删除订阅源时清理其快照')
}

sec('24. 下拉面板脱离滚动容器')
{
  const ui = T.adminHTML(true, true)
  // 弹窗内容区是 overflow:auto，absolute 面板超出边界会被裁掉，
  // 底部按钮区还盖在上面 —— z-index 救不回被裁的那半，必须挪出容器。
  ok(ui.includes('document.body.appendChild(pop)'), '展开时把面板挪到 body')
  ok(/\.selp\.portal\{[^}]*position:fixed/.test(ui), 'portal 状态用 fixed 定位')
  ok(ui.includes('function placeSel'), '存在按触发器计算位置的函数')
  ok(ui.includes('pop._home'), '记住原位置以便归位')
  ok(ui.includes('pop._home.p.insertBefore'), '收起时放回原位，不滞留在 body')
  // 面板挂在 body 上，这两处若不主动收起就会变成孤儿浮层
  ok(/const close = v => \{\s*\/\/[^\n]*\n\s*closeAllSel\(\)/.test(ui), '弹窗关闭时先收起面板')
  ok(/async function dash\(skip\)\{\s*\n?\s*closeAllSel\(\)/.test(ui), '整页重绘前先收起面板')
  ok(ui.includes("addEventListener('scroll'"), '滚动时重新定位或收起')
  ok(ui.includes("addEventListener('resize', closeAllSel)"), '窗口尺寸变化时收起')
  // 面板已不在卡片内，抬升卡片层级的老办法成了死代码
  ok(!/\.card\.front\{/.test(ui), '移除不再需要的 .card.front 提层 hack')
  ok(!ui.includes("classList.add('front')"), '不再给卡片加 front 类')
}

sec('25. 地区识别：全量国家覆盖')
{
  const cls = n => {
    const k = T.flagRegion(n) || T.REGIONS.find(x => x.re.test(n)).key
    return T.REGIONS.find(x => x.key === k).cn
  }
  ok(T.REGIONS.length > 240, `地区表覆盖 ${T.REGIONS.length} 个（ISO 3166-1 共 249）`)

  // 国旗 emoji 直接编码 ISO 码，比猜文字可靠 —— 机场爱写「🇪🇸 马德里」这种只有城市名的
  ok(T.flagRegion('🇪🇸 马德里') === 'es', '国旗解码出西班牙')
  ok(T.flagRegion('🇦🇶 南极') === 'aq', '冷门地区的国旗也认')
  ok(T.flagRegion('无旗节点 01') === null, '没有国旗时返回 null 交给文字匹配')
  ok(cls('🇪🇸 马德里 Madrid') === '西班牙', '只有城市名时靠国旗兜住')

  // 名称互相包含的，长的必须排在前面
  ok(cls('印度尼西亚 01') === '印尼', '印度尼西亚不被「印度」抢走')
  ok(cls('印度 01') === '印度', '印度仍归印度')
  ok(cls('南苏丹') === '南苏丹' && cls('苏丹') === '苏丹', '南苏丹与苏丹分得开')
  ok(cls('北马其顿') === '北马其顿', '北马其顿独立成组')
  ok(cls('法属圭亚那') === '法属圭亚那' && cls('圭亚那') === '圭亚那', '圭亚那与法属圭亚那分得开')
  ok(cls('尼日利亚') === '尼日利亚' && cls('尼日尔') === '尼日尔', '尼日利亚与尼日尔分得开')

  // 两字母代码不加词边界会闯祸：ID 命中 Madrid、TH 命中 North
  ok(cls('Madrid Node') !== '印尼', 'Madrid 不被 ID 误判为印尼')
  ok(cls('North Node') !== '泰国', 'North 不被 TH 误判为泰国')
  ok(cls('My Node 01') !== '马来西亚', 'My 不被 MY 误判为马来西亚')
  ok(T.REGIONS.find(r => r.key === 'jp').re.source.includes('\\bJP\\b'), '两字母代码带词边界')

  // 繁体、简称、官方长名都要认
  ok(cls('🇦🇹 奧地利') === '奥地利', '繁体「奧地利」')
  ok(cls('中国澳门特别行政区') === '澳门', '官方长名剥出简称')
  ok(cls('澳門 家宽') === '澳门', '繁体澳門')
  ok(cls('澳洲 悉尼') === '澳大利亚', '澳洲=澳大利亚，且不与澳门混淆')

  // 兜底仍在：认不出的不能报错
  ok(cls('完全无法识别的节点') === '其他', '认不出时仍落到「其他」')

  // 快照存的是抓取当时算好的 region。地区表一改，老快照必须重算，
  // 否则 403 的源永远靠快照供节点，新规则对它就是不生效。
  const wsrc3 = fs.readFileSync(require('path').join(__dirname,'..','worker.js'), 'utf8')
  ok(/s\.nodes\.map\(n => \(\{ \.\.\.n, region: regionOf\(n\.raw\) \}\)\)/.test(wsrc3),
     '读快照时重算地区，不沿用旧分类')
  ok(wsrc3.includes('function regionOf'), '地区判定收敛到单一入口')
  ok((wsrc3.match(/REGIONS\.find\(x => x\.re\.test/g) || []).length === 1,
     '没有第二处各写各的地区判定')
}

sec('26. 入站格式：分享链接 / 块式 YAML')
{
  // 机场按 UA 给什么格式全凭它高兴。只认一种的后果是「换个 UA 重试」
  // 和「粘贴导入」这两条退路一起失效 —— 链接被 403 挡住时就彻底没辙了。
  const P = T.parseShareLine

  const vl = P('vless://11111111-2222-3333-4444-555555555555@a.example.invalid:443?type=ws&security=tls&sni=s.example.invalid&fp=chrome&host=h.example.invalid&path=%2Fray#%E6%97%A5%E6%9C%AC01')
  ok(vl && vl.type === 'vless' && vl.server === 'a.example.invalid' && vl.port === '443', 'vless 基本字段')
  ok(vl && vl._name === '日本01', 'fragment urldecode 成节点名')
  ok(vl && vl.network === 'ws' && /path: \/ray/.test(vl['ws-opts']) && /Host: h\.example\.invalid/.test(vl['ws-opts']), 'vless ws 传输层')
  ok(vl && vl.servername === 's.example.invalid' && vl['client-fingerprint'] === 'chrome', 'sni 映射到 servername')

  const re = P('vless://11111111-2222-3333-4444-555555555555@b.example.invalid:443?security=reality&pbk=-PLACEHOLDERPUBKEY0000&sid=0123456789abcdef&flow=xtls-rprx-vision#R')
  ok(re && re.flow === 'xtls-rprx-vision', 'reality 的 flow')
  ok(re && /public-key: '-PLACEHOLDERPUBKEY0000'/.test(re['reality-opts']), "以 '-' 开头的 public-key 自动加引号")

  const tj = P('trojan://pwd@[2001:db8::1]:443?sni=s.example.invalid&allowInsecure=1#IPv6')
  ok(tj && tj.server === '2001:db8::1', 'IPv6 方括号已剥离')
  ok(tj && tj.sni === 's.example.invalid' && tj['skip-cert-verify'] === 'true', 'trojan 用 sni 字段名')

  const hy = P('hysteria2://pwd@c.example.invalid:35000/?insecure=1&sni=s.example.invalid&obfs=salamander&obfs-password=op&mport=35000-39000#US')
  ok(hy && hy.type === 'hysteria2' && hy.ports === '35000-39000' && hy.obfs === 'salamander', 'hysteria2 含端口跳跃与 obfs')

  ok(P('ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@d.example.invalid:8388#SS').cipher === 'aes-256-gcm', 'ss SIP002 格式')
  const ssOld = 'ss://' + Buffer.from('aes-256-gcm:password@e.example.invalid:8388', 'utf8').toString('base64') + '#SSOld'
  ok(P(ssOld) && P(ssOld).server === 'e.example.invalid', 'ss 整串 base64 的老格式')

  const vm = 'vmess://' + Buffer.from(JSON.stringify({v:'2',ps:'VM01',add:'f.example.invalid',port:'443',id:'11111111-2222-3333-4444-555555555555',aid:'0',net:'ws',host:'h.example.invalid',path:'/vm',tls:'tls'}), 'utf8').toString('base64')
  const vmn = P(vm)
  ok(vmn && vmn._name === 'VM01' && vmn.network === 'ws' && vmn.tls === 'true', 'vmess base64 JSON 格式')

  ok(P('http://example.invalid/x') === null && P('随便一行文字') === null, '非分享链接返回 null')

  // 块式 YAML：v2board 系最常见的写法，缩进字段要收成和单行格式一样的形状
  const blockY = [
    'proxies:',
    '  - name: "🇭🇰 香港 01"',
    '    type: vmess',
    '    server: hk.example.invalid',
    '    port: 443',
    '    uuid: 11111111-2222-3333-4444-555555555555',
    '    network: ws',
    '    ws-opts:',
    '      path: /ray',
    '      headers:',
    '        Host: hk.example.invalid',
    '  - name: "剩余流量：500.5 GB"',
    '    type: trojan',
    '    server: 127.0.0.1',
    '    port: 1',
    '    password: x',
    'rules:',
    '  - DOMAIN-SUFFIX,example.invalid,DIRECT',
  ].join('\n')
  const bf = T.splitFeed(blockY)
  ok(bf.nodes.length === 1, '块式 YAML 解析出节点')
  ok(bf.notes.length === 1 && bf.notes[0].includes('500.5'), '块式里的公告条目照样识别')
  ok(/path: \/ray/.test(bf.nodes[0]['ws-opts']) && /Host: hk\.example\.invalid/.test(bf.nodes[0]['ws-opts']), '多层缩进收成 flow 字符串')

  // 同一份订阅的两种表达必须解析出同一批节点，否则换 UA 重试就成了开盲盒
  const asShare = [
    'vless://11111111-2222-3333-4444-555555555555@a.example.invalid:443?type=ws&security=tls&host=h.example.invalid&path=%2Fray#JP01',
    'hysteria2://pwd@c.example.invalid:35000/?sni=s.example.invalid#US01',
  ].join('\n')
  const asYaml = [
    'proxies:',
    "  - {name: JP01, type: vless, server: a.example.invalid, port: 443, tls: true, network: ws, ws-opts: { path: /ray, headers: { Host: h.example.invalid } }}",
    '  - {name: US01, type: hysteria2, server: c.example.invalid, port: 35000, password: pwd, sni: s.example.invalid}',
  ].join('\n')
  const s1 = T.splitFeed(asShare), s2 = T.splitFeed(asYaml)
  ok(s1.nodes.length === s2.nodes.length && s1.nodes.length === 2, '两种格式节点数一致')
  ok(s1.nodes.map(n => n._name).join() === s2.nodes.map(n => n._name).join(), '两种格式节点名一致')
  ok(s1.nodes[0].network === s2.nodes[0].network && s1.nodes[0]['ws-opts'] === s2.nodes[0]['ws-opts'], '两种格式传输层一致')

  // base64 包裹的分享链接：浏览器直接打开订阅链接看到的就是这个
  const wrapped = Buffer.from(asShare, 'utf8').toString('base64')
  ok(T.splitFeed(T.b64decode(wrapped)).nodes.length === 2, 'base64 包裹的分享链接列表')

  // flow 字符串的正反变换必须闭环，否则 sing-box / 分享链接导出会读空
  const fl = T.nestFlow({ path: '/x', headers: { Host: 'h.example.invalid' }, empty: '' })
  ok(fl === '{ path: /x, headers: { Host: h.example.invalid } }', 'nestFlow 跳过空值')
  const back = T.parseFlow(fl)
  ok(back.path === '/x' && back.headers.Host === 'h.example.invalid', 'parseFlow 还原嵌套')
  ok(T.parseFlow(T.nestFlow({ k: '-dash' })).k === '-dash', "带引号的值能原样还原")
}

sec('27. rules 段不再全量扫描（免费版 CPU 预算）')
{
  // 完整 Clash 配置里 rules 能有上万行，既没有节点也没有公告。
  // 免费版单次请求只有 10ms CPU，白扫这一段就能把预算耗光。
  const head = ['proxies:', "  - {name: JP01, type: ss, server: a.example.invalid, port: 443, cipher: aes-128-gcm, password: x}"]
  const rules = ['rules:', ...Array.from({ length: 20000 }, (_, i) => `  - DOMAIN-SUFFIX,d${i}.example.invalid,DIRECT`)]
  const big = [...head, ...rules].join('\n')
  const r = T.splitFeed(big)
  ok(r.nodes.length === 1, '大 rules 段不影响节点解析')

  // rules 段里的行也是 `- xxx` 列表项，长得像节点，一条都不该被收进来
  const trap = [...head, ...rules.slice(0, 50),
    '  - {name: TRAP, type: ss, server: b.example.invalid, port: 443, cipher: aes-128-gcm, password: x}'].join('\n')
  const tr = T.splitFeed(trap)
  ok(tr.nodes.length === 1 && tr.nodes[0]._name === 'JP01', 'rules 段里的行不被当成节点')

  // 这条才是 break 的守卫。没有 break 的话，rules 每一行仍要过一遍 JUNK
  // 正则 —— CPU 就是这么烧掉的。藏在 rules 之后的公告若能被读到，
  // 就说明还在往下扫。用行为断言而不是计时：计时会随机器负载误报，
  // 别把「性能有没有回归」赌在跑测试那一刻的负载上。
  ok(T.splitFeed([...head, ...rules.slice(0, 50), '# 剩余流量：100 GB'].join('\n')).notes.length === 0,
     '扫到 rules 即停止，之后的内容一概不看')
  const timeIt = t => { for (let i = 0; i < 3; i++) T.splitFeed(t); const s = process.hrtime.bigint(); for (let i = 0; i < 5; i++) T.splitFeed(t); return Number(process.hrtime.bigint() - s) / 5e6 }
  console.log(`  ℹ️  参考耗时：无 rules ${timeIt(head.join('\n')).toFixed(2)}ms · 两万行 rules ${timeIt(big).toFixed(2)}ms`)

  // 公告若写在 rules 之后就读不到了 —— 机场都写在头部，这是可接受的取舍，
  // 但 proxies 段里的公告条目必须照常识别
  const withNote = ['# 剩余流量：100 GB', ...head, ...rules.slice(0, 5)].join('\n')
  ok(T.splitFeed(withNote).notes.length === 1, 'rules 之前的公告仍然采集')
}

sec('28. 拉不通时的退路：粘贴导入')
{
  const u = { id: 'test01', name: '测试机场' }
  const feed = [
    'vless://11111111-2222-3333-4444-555555555555@a.example.invalid:443?type=ws&security=tls&path=%2Fray#%F0%9F%87%AF%F0%9F%87%B5JP01',
    'hysteria2://pwd@c.example.invalid:35000/?sni=s.example.invalid#%F0%9F%87%BA%F0%9F%87%B8US01',
    'trojan://pwd@d.example.invalid:443?sni=s.example.invalid#%E5%89%A9%E4%BD%99%E6%B5%81%E9%87%8F%EF%BC%9A500.5%20GB',
  ].join('\n')
  const r = T.parsePasted(feed, u)
  ok(!r.err && r.got.nodes.length === 2, '粘贴分享链接列表可解析')
  ok(r.got.nodes[0].up === 'test01' && r.got.nodes[0].region === 'jp', '节点带上来源与地区')
  ok(r.got.info && r.got.info.total === Math.round(500.5 * 1073741824), '公告藏在 fragment 里也能出用量')

  ok(T.parsePasted(Buffer.from(feed, 'utf8').toString('base64'), u).got.nodes.length === 2, '粘贴 base64 整份订阅')

  // 复制错东西是常事，得说清楚而不是静默收下一个空源
  ok(!!T.parsePasted('', u).err, '空内容被拒')
  ok(!!T.parsePasted('   \n  ', u).err, '纯空白被拒')
  ok(!!T.parsePasted('<html><body>Just a moment...</body></html>', u).err, '误粘网页被拒')
  ok(T.parsePasted('乱码乱码', u).err.includes('订阅内容本身'), '拒绝时提示该复制什么')

  // 逐个 UA 试完还是不行，错误得说清楚卡在哪儿
  ok(T.triesMsg([{ ua: 'a', status: 403, body: 'Sorry, you have been blocked' }, { ua: 'b', status: 403 }])
     === 'HTTP 403（Sorry, you have been blocked）', '403 带上拦截页正文')
  ok(T.triesMsg([{ ua: 'a', status: 200, n: 0 }, { ua: 'b', status: 200, n: 0 }]).includes('都能访问，但都没解析出节点'),
     '能访问但解析不出，措辞要和拉不通区分开')
  ok(T.triesMsg([{ ua: 'a', status: 403 }, { ua: 'b', err: 'connection lost' }]) === 'HTTP 403；connection lost', '多种失败合并去重')

  // 粘贴导入的源没有链接可拉，别去 fetch 空串
  ok(T.feedFormat('proxies:\n  - {}', 'proxies:\n  - {}') === 'Clash YAML', '格式识别：Clash')
  const oneLink = 'vless://11111111-2222-3333-4444-555555555555@a.example.invalid:443#X'
  ok(T.feedFormat(Buffer.from(oneLink, 'utf8').toString('base64'), oneLink) === 'base64 分享链接', '格式识别：base64')
  ok(T.feedFormat(oneLink, oneLink) === '明文分享链接', '格式识别：明文分享链接')

  const ui = T.adminHTML(true, true)
  ok(/canPaste/.test(ui), '拉取失败时提供粘贴入口')
  ok(ui.includes('全选复制'), '告诉用户具体该怎么做')
  ok(/act:'add', name, url, text/.test(ui) || /act:'add', name, url, text:t2/.test(ui), '添加时把粘贴内容一起提交')
  // 服务端返回非 JSON（CPU 超限的 1102 页、网关错误）时不能静默失败
  ok(/JSON\.parse\(raw\)/.test(ui) && /非 JSON 响应/.test(ui), 'api() 兜住非 JSON 响应')
}

sec('29. sing-box：不支持的协议不得留下悬空引用')
{
  // 以前 toSB 认不出的协议被 filter 掉，地区组却仍按全量节点取名字，
  // 于是引用一堆不存在的 tag —— sing-box 是拒绝加载整份配置，不是跳过那几个。
  const mk = (name, region, kv) => ({ up: 'x', upName: 'A', region, raw: name, name, key: 'x::' + name, kv })
  const weird = [
    mk('🇯🇵 日本 01', 'jp', { type: 'ss', server: 'a.example.invalid', port: '443', cipher: 'aes-128-gcm', password: 'x' }),
    mk('🇯🇵 日本 02', 'jp', { type: 'wireguard', server: 'b.example.invalid', port: '443' }),   // toSB 认不出
    mk('🇭🇰 香港 01', 'hk', { type: '未来协议', server: 'c.example.invalid', port: '443' }),     // 同上
  ]
  ok(T.toSB(weird[1]) === null && T.toSB(weird[2]) === null, '认不出的协议返回 null')
  const sb = JSON.parse(T.genSB(weird, P, LIB, OWN, SET))
  const tags = new Set(sb.outbounds.map(o => o.tag))
  const miss = []
  sb.outbounds.forEach(o => (o.outbounds || []).forEach(x => { if (!tags.has(x)) miss.push(`${o.tag}→${x}`) }))
  sb.route.rules.forEach(r => { if (r.outbound && !tags.has(r.outbound)) miss.push('rule→' + r.outbound) })
  ok(miss.length === 0, '认不出的节点连同分组引用一起剔除' + (miss.length ? ': ' + miss.slice(0, 3) : ''))
  ok(!tags.has('🇭🇰 香港 01'), '整个香港组消失，而不是留一个空组')
  ok(tags.has('🇯🇵 日本'), '仍有可用节点的地区组保留')

  // fixture 里的 vless 上游节点必须真的转出 outbound。
  // 自有节点也是 vless+reality，按 tag 排除掉，否则断言会命中它而不是上游节点。
  const sd = JSON.parse(T.genSB(up, P, LIB, OWN, SET))
  const ownTags = new Set(Object.values(OWN).map(n => n.name))
  const upVless = sd.outbounds.filter(o => o.type === 'vless' && !ownTags.has(o.tag))
  ok(upVless.length === 2, `上游 vless 转出 outbound（${upVless.length}）`)
  const wsOut = upVless.find(o => o.transport && o.transport.type === 'ws')
  ok(wsOut && wsOut.transport.path === '/ray' && wsOut.transport.headers.Host === 'example.invalid', '上游 vless+ws 转出 transport')
  ok(wsOut && wsOut.tls && wsOut.tls.server_name === 'example.invalid', 'servername 映射到 tls.server_name')
  const reOut = upVless.find(o => o.tls && o.tls.reality)
  ok(reOut && reOut.tls.reality.public_key === '-PLACEHOLDERPUBKEY000000000000000000000000', 'reality-opts 转出 public_key')
  ok(reOut && reOut.tls.reality.short_id === '0123456789abcdef', 'reality-opts 转出 short_id')
  ok(reOut && reOut.flow === 'xtls-rprx-vision', 'vision flow 带过去')
  const vmOut = sd.outbounds.find(o => o.type === 'vmess')
  ok(vmOut && vmOut.tls && vmOut.tls.enabled && vmOut.transport && vmOut.transport.type === 'ws', 'vmess 带上 tls 与 ws transport')
}

sec('30. 节点命名带上来源机场')
{
  // 下发到客户端的名字里看不出节点是哪家机场的，出问题时没法判断该找谁。
  const kv = { type: 'ss', server: 'a.example.invalid', port: '443', cipher: 'aes-128-gcm', password: 'x' }
  const mk = (up, upName, raw) => ({ up, upName, raw, region: T.regionOf(raw), kv })
  const three = [
    mk('a', '三毛机场', '日本1|移动优化'), mk('a', '三毛机场', '2x专线-日本-2'), mk('a', '三毛机场', '香港原生IP-1'),
    mk('b', 'MESL', '🇯🇵 日本 01'), mk('b', 'MESL', '🇯🇵 日本 02'),
    mk('c', '赔钱机场', '🇺🇸美国01-0.1倍'),
  ]
  const named = T.applyNaming(three, {})
  ok(named[0].name === '🇯🇵 日本 01 · 三毛机场', `格式为「地区 序号 · 机场」（实际 ${named[0].name}）`)
  ok(named[5].name === '🇺🇸 美国 01 · 赔钱机场', '不同地区各自编号')

  // 每家从 01 起：一眼看得出某家在某地区有几个节点，加删源也不牵动别家编号
  ok(named[1].name === '🇯🇵 日本 02 · 三毛机场' && named[3].name === '🇯🇵 日本 01 · MESL',
     '序号按「机场 + 地区」各排各的，不是全地区连号')
  ok(named[2].name === '🇭🇰 香港 01 · 三毛机场', '同一机场换地区后重新起号')

  // 两个源起同名会让 Clash 只认其中一个 proxy
  const dup = T.applyNaming([mk('x', '未命名机场', '日本-1'), mk('y', '未命名机场', '日本-1')], {})
  ok(dup[0].name === '🇯🇵 日本 01 · 未命名机场 1' && dup[1].name === '🇯🇵 日本 01 · 未命名机场 2',
     '重名机场补序号区分')
  ok(new Set(dup.map(n => n.name)).size === dup.length, '重名机场下节点名仍唯一')

  // 自定义重命名按 up::raw 存，不受命名规则变动影响
  const ov = T.applyNaming(three, { 'a::日本1|移动优化': { name: '我的日本节点' } })
  ok(ov[0].name === '我的日本节点' && ov[0].custom === true, '自定义重命名优先于自动命名')
  ok(ov[0].auto === '🇯🇵 日本 01 · 三毛机场', '自动名仍保留在 auto 字段里供还原')

  // 地区组名绝不能带机场名 —— 分流策略指向的就是它，带了就等于每次加源都改策略目标
  const up3 = named.filter(n => !n.off)
  const cy = T.genClash(false, up3, P, LIB, {}, SET)
  const cd = yaml ? yaml.load(cy) : null
  if (cd) {
    const rg = cd['proxy-groups'].filter(g => g.type === 'url-test').map(g => g.name)
    ok(rg.includes('🇯🇵 日本') && !rg.some(n => /三毛|MESL|赔钱/.test(n)), '地区组名不含机场名')
    const pn = new Set(cd.proxies.map(p => p.name))
    ok(pn.size === cd.proxies.length, '多机场下 proxies 名唯一')
    const dang = []
    const gn = new Set(cd['proxy-groups'].map(g => g.name))
    cd['proxy-groups'].forEach(g => (g.proxies || []).forEach(x => {
      if (!pn.has(x) && !gn.has(x) && !['DIRECT', 'REJECT'].includes(x)) dang.push(`${g.name}→${x}`)
    }))
    ok(dang.length === 0, '改名后分组引用无悬空' + (dang.length ? ': ' + dang.slice(0, 2) : ''))
  }
  const sb3 = JSON.parse(T.genSB(up3, P, LIB, {}, SET))
  const t3 = new Set(sb3.outbounds.map(o => o.tag)), m3 = []
  sb3.outbounds.forEach(o => (o.outbounds || []).forEach(x => { if (!t3.has(x)) m3.push(`${o.tag}→${x}`) }))
  ok(m3.length === 0, '改名后 sing-box 引用无悬空' + (m3.length ? ': ' + m3.slice(0, 2) : ''))

  // 名字里已经有机场了，管理端右侧那列再显示一遍就是重复
  const ui = T.adminHTML(true, true)
  ok(!/<span class="raw">\$\{esc\(n\.upName\)\} · \$\{esc\(n\.raw\)\}<\/span>/.test(ui), '节点行不再重复显示机场名')
}

sec('31. 订阅源可拖拽排序')
{
  const ui = T.adminHTML(true, true)
  // 拖拽逻辑与策略列表共用一份实现：各写一套的话，一边修了抖动另一边照旧
  ok(/function bindDrag\(listSel, itemSel, persist\)/.test(ui), 'bindDrag 已泛化为可复用')
  ok(/bindDrag\('#pollist', '\.pol', persistOrder\)/.test(ui), '策略列表沿用同一实现')
  ok(/bindDrag\('\.uplist\.src', '\.up', persistUpOrder\)/.test(ui), '订阅源列表绑定拖拽')
  ok(!/function bindDrag\(\)\{/.test(ui) && !/getElementById\('pollist'\)\n\s+if \(!list\) return\n\s+let src/.test(ui),
     '没有残留的写死版本')

  ok(/<span class="grip" data-tip="拖动调整顺序">/.test(ui), '订阅源行有拖拽手柄')
  ok(/async function persistUpOrder/.test(ui), '存在顺序落库函数')
  ok(/act:'sort', ids/.test(ui), '按 id 列表提交顺序')
  ok(/靠上的机场，节点排在订阅前面/.test(ui), '说明顺序的实际作用')
  // 一个源时排不了序，提示只会碍眼
  ok(/ST\.upstreams\.length > 1[\s\S]{0,120}拖动左侧手柄/.test(ui), '只有多个源时才显示排序提示')

  // 拖完立刻重建 DOM 会把用户刚拖好的行又抹一遍，只同步索引即可
  ok(/\[\.\.\.list\.querySelectorAll\('\.up'\)\]\.forEach\(\(el, i\) => \{ el\.dataset\.i = i \}\)/.test(ui),
     '保存后只回填索引，不重建订阅源行')
  // 但增删源确实重建了行，那里必须重新绑定
  ok(/list\.innerHTML = ST\.upstreams\.map\(upRow\)[\s\S]{0,120}bindDrag\('\.uplist\.src'/.test(ui),
     '增删源重建行后重新绑定拖拽')
  ok(/upRow\(nu, ST\.upstreams\.length - 1\)/.test(ui), '增量插入的行带上正确索引')

  // 排序不改变任何节点内容，作废缓存等于让用户干等一轮全量重拉
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'worker.js'), 'utf8')
  ok(/body\.act === 'sort'[\s\S]{0,400}c\.nodes\.sort/.test(src), '排序只重排缓存，不作废')
  ok(/else \{\s*\n\s*await CONF\.delete\('cache:nodes'\)/.test(src), '其它操作仍然作废缓存')
  ok(/for \(const u of ups\) if \(!seen\.has\(u\.id\)\) next\.push\(u\)/.test(src), '不在 ids 里的源不会被丢掉')
  ok(/next\.length !== ups\.length[\s\S]{0,60}顺序数据不完整/.test(src), '数量对不上就拒绝落库')
}

sec('32. 排序接口的行为契约（真调 apiRoute）')
{
  // 顺序落库这件事有一堆边界：并发下 ids 不全、重复 id、幽灵 id。
  // 这些靠扫源码是守不住的，得真发请求。
  const exp = String(Date.now() + 3600e3)
  const cookie = 'sess=' + encodeURIComponent(exp + '.' + await T.hmac(await T.sessionSecret(), exp))
  const call = async body => {
    const req = new Request('https://x/api/upstreams', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    })
    const r = await T.apiRoute(req, new URL('https://x/api/upstreams'), null)
    return { status: r.status, body: await r.json() }
  }
  const setUps = a => { KV['upstreams'] = JSON.stringify(a) }
  const ids = () => JSON.parse(KV['upstreams']).map(u => u.id).join(',')

  setUps([{ id: 'a', name: '三毛机场' }, { id: 'b', name: 'MESL' }, { id: 'c', name: '赔钱机场' }])
  KV['cache:nodes'] = JSON.stringify({ at: 1, nodes: [
    { up: 'a', raw: '三毛-日1' }, { up: 'a', raw: '三毛-日2' }, { up: 'b', raw: 'MESL-日1' },
    { up: 'c', raw: '赔钱-日1' }, { up: 'c', raw: '赔钱-日2' }] })
  let r = await call({ act: 'sort', ids: ['c', 'a', 'b'] })
  ok(r.body.ok && ids() === 'c,a,b', `排序落库（${ids()}）`)
  const cn = JSON.parse(KV['cache:nodes']).nodes.map(n => n.raw)
  ok(cn.join() === '赔钱-日1,赔钱-日2,三毛-日1,三毛-日2,MESL-日1', '缓存节点跟着重排：' + cn.join(' | '))
  ok(cn[0] === '赔钱-日1' && cn[1] === '赔钱-日2', '同机场内相对顺序不变（排序必须稳定）')
  ok(KV['cache:nodes'] !== undefined, '排序不作废缓存，不让用户干等全量重拉')

  // 另一个标签页刚加了源，这边提交的 ids 里没有它
  setUps([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'n', name: '新加的' }])
  r = await call({ act: 'sort', ids: ['b', 'a'] })
  ok(r.body.ok && ids() === 'b,a,n', `ids 不全时漏掉的源追加到末尾，不丢（${ids()}）`)

  setUps([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
  r = await call({ act: 'sort', ids: ['b', 'b', 'ghost', 'a'] })
  ok(r.body.ok && ids() === 'b,a', `重复 id 与不存在的 id 被忽略（${ids()}）`)

  setUps([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
  r = await call({ act: 'sort', ids: [] })
  ok(r.body.ok && ids() === 'a,b', '空 ids 保持原序')
  r = await call({ act: 'sort', ids: '不是数组' })
  ok(r.body.ok && ids() === 'a,b', '非数组入参不炸')

  // 对照：改动内容的操作仍然要作废缓存
  KV['cache:nodes'] = JSON.stringify({ at: 1, nodes: [] })
  await call({ act: 'toggle', id: 'a' })
  ok(KV['cache:nodes'] === undefined, '停用/启用仍然作废缓存')

  // 顺带守一下鉴权：没 cookie 一律 401
  const anon = await T.apiRoute(
    new Request('https://x/api/upstreams', { method: 'POST', body: '{"act":"sort","ids":[]}' }),
    new URL('https://x/api/upstreams'), null)
  ok(anon.status === 401, '未登录访问排序接口返回 401')
}

sec('33. 修改密码')
{
  // 以前只有首次初始化那一次机会设密码，之后想换只能去 KV 删 auth:password，
  // 而那会让公网上的管理端一直裸奔到重设为止。
  const sha = async s => T.sha256(s)
  const login = async () => {
    const exp = String(Date.now() + 3600e3)
    return 'sess=' + encodeURIComponent(exp + '.' + await T.hmac(await T.sessionSecret(), exp))
  }
  const call = async (body, cookie) => {
    const h = { 'Content-Type': 'application/json' }
    if (cookie) h.Cookie = cookie
    const req = new Request('https://x/api/password', { method: 'POST', headers: h, body: JSON.stringify(body) })
    const r = await T.apiRoute(req, new URL('https://x/api/password'), null)
    return { status: r.status, body: await r.json(), setCookie: r.headers.get('Set-Cookie') }
  }

  KV['auth:password'] = JSON.stringify(await sha('oldpass123'))
  let cookie = await login()

  let r = await call({ oldPassword: '错的密码', newPassword: 'newpass123' }, cookie)
  ok(r.status === 401 && /当前密码不正确/.test(r.body.msg), '旧密码不对则拒绝')
  ok(JSON.parse(KV['auth:password']) === await sha('oldpass123'), '拒绝时密码未被改动')

  r = await call({ oldPassword: 'oldpass123', newPassword: 'short' }, cookie)
  ok(r.status === 400 && /至少 8 位/.test(r.body.msg), '新密码太短则拒绝')

  r = await call({ oldPassword: 'oldpass123', newPassword: 'oldpass123' }, cookie)
  ok(r.status === 400 && /相同/.test(r.body.msg), '新旧密码相同则拒绝')

  // 光有 cookie 不够 —— cookie 被借走时，改密码等于把号让出去
  r = await call({ newPassword: 'newpass123' }, cookie)
  ok(r.status === 401, '不带当前密码、只凭登录态改不了')

  r = await call({ oldPassword: 'oldpass123', newPassword: 'newpass123' }, cookie)
  ok(r.body.ok === true, '旧密码正确则允许修改')
  ok(JSON.parse(KV['auth:password']) === await sha('newpass123'), '新密码已落库（存的是哈希）')
  ok(JSON.parse(KV['auth:password']) !== 'newpass123', '绝不存明文')

  // 换了密码，别处的会话就该作废，否则改了等于没改
  const stale = await T.apiRoute(
    new Request('https://x/api/state', { headers: { Cookie: cookie } }), new URL('https://x/api/state'), null)
  ok(stale.status === 401, '旧 cookie 已失效，其它设备被登出')
  ok(/^sess=/.test(r.setCookie || ''), '当前设备换发新 cookie，不被自己踢下线')
  const fresh = r.setCookie.match(/^sess=([^;]+)/)[1]
  const ok2 = await T.apiRoute(
    new Request('https://x/api/state', { headers: { Cookie: 'sess=' + fresh } }), new URL('https://x/api/state'), null)
  ok(ok2.status !== 401, '新发的 cookie 可继续访问')

  // 未登录当然改不了
  const anon = await call({ oldPassword: 'newpass123', newPassword: 'another123' }, null)
  ok(anon.status === 401, '未登录访问改密码接口返回 401')

  const ui = T.adminHTML(true, true)
  ok(/onclick="changePwd\(\)"/.test(ui), '管理端有修改密码入口')
  ok(/type="password"/.test(ui), '密码框用 type=password，不明文回显')
  ok(/两次输入的新密码不一致/.test(ui), '要求输两遍，输错了不至于下次登录才发现')
  ok(!/value="\$\{esc\(.*password.*\)\}"/i.test(ui), '页面不回填任何密码值')
  delete KV['auth:password']
}

sec('34. 直连域名的输入清洗')
{
  const exp = String(Date.now() + 3600e3)
  const cookie = 'sess=' + encodeURIComponent(exp + '.' + await T.hmac(await T.sessionSecret(), exp))
  const save = async directDomains => {
    const req = new Request('https://x/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ domain: '', directDomains, directIPs: [] }),
    })
    const r = await T.apiRoute(req, new URL('https://x/api/settings'), null)
    return (await r.json()).settings.directDomains
  }

  // DOMAIN-SUFFIX 本身就含所有子域名，写通配符会生成一条永远匹配不上的规则，
  // 而且是静默失效 —— 不报错，只是不生效，等发现时早绕远路跑半天了
  ok((await save(['*.example.com']))[0] === 'example.com', "剥掉 `*.` 前缀")
  ok((await save(['.example.com']))[0] === 'example.com', '剥掉前导点')
  ok((await save(['https://tokenhub.example.net/v1/responses']))[0] === 'tokenhub.example.net', '完整 URL 剥成域名')
  ok((await save(['http://a.example.com:8443/x?y=1#z']))[0] === 'a.example.com', '端口、查询串、锚点一并剥掉')
  ok((await save(['  Example.COM  ']))[0] === 'example.com', '去空白并转小写')
  ok((await save(['example.com']))[0] === 'example.com', '正常输入原样保留')
  const many = await save(['a.com', '', '  ', 'b.com'])
  ok(many.length === 2 && many.join() === 'a.com,b.com', '空行被丢弃')

  // 清洗后生成的规则必须是能匹配上的那种
  const SET = { ...T.DEFAULT_SETTINGS, domain: '', directDomains: await save(['*.example.com']), directIPs: [] }
  const cy = T.genClash(false, [], P, LIB, T.DEFAULT_NODES, SET)
  ok(/- DOMAIN-SUFFIX,example\.com,DIRECT/.test(cy), '生成的是 DOMAIN-SUFFIX,example.com')
  ok(!/\*/.test(cy.split('\n').filter(l => l.includes('example.com')).join('')), '规则里不含通配符')

  const ui = T.adminHTML(true, true)
  ok(/子域名自动包含/.test(ui), '界面上说明了不用写通配符')
  delete KV['settings']
}

sec('35. 链式代理')
{
  // 一条链 = 先连中转、再从中转连落地，出口 IP 是落地的。
  // 用途：自建做中转（入口线路好），机场家宽做落地（住宅 IP 风控友好）。
  const land = up.find(n => n.kv.type === 'vless' && n.kv.network === 'ws')
  const hy = up.find(n => n.kv.type === 'hysteria2')
  ok(!!land && !!hy, 'fixture 里有可作落地的 vless+ws 与 hysteria2 节点')
  const ownKey = Object.keys(OWN)[0]
  const chains = [{ id: 'c1', name: '🔗 AI 家宽链', via: 'own:' + ownKey, out: land.key, enabled: true }]
  const liveKeys = [...new Set(up.map(n => n.region))]

  // 落地协议决定这条链能不能通：内层跑在外层隧道里，UDP 系协议转发不了
  ok(T.chainLandingWarn(land.kv) === '', 'vless 落地不告警')
  ok(/hysteria2/.test(T.chainLandingWarn(hy.kv)), 'hysteria2 落地会告警')
  ok(/tuic/i.test(T.chainLandingWarn({ type: 'tuic' })), 'tuic 落地会告警')

  const rc = T.resolveChains(chains, up, OWN, liveKeys)
  ok(rc.length === 1 && rc[0].via === OWN[ownKey].name, `中转解析成节点名（${rc[0] && rc[0].via}）`)
  ok(rc[0].land.key === land.key, '落地对应到具体节点')
  ok(T.resolveChains([{ ...chains[0], enabled: false }], up, OWN, liveKeys).length === 0, '停用的链不生成')
  ok(T.resolveChains([{ ...chains[0], out: 'ghost::none' }], up, OWN, liveKeys).length === 0, '落地节点没了则整条链跳过')

  const pol = [{ id: 'ai', name: '🤖 AI', target: 'chain:c1', strict: true, presets: ['ai'], domains: [], keywords: [], processes: [], enabled: true }]

  // Clash：落地整份复制一遍加 dialer-proxy，原节点必须还在（地区组还要直连用它）
  const cy = T.genClash(false, up, pol, LIB, OWN, SET, chains)
  const cd = yaml ? yaml.load(cy) : null
  if (cd) {
    const cn = cd.proxies.find(p => p.name === '🔗 AI 家宽链')
    ok(!!cn, '生成了链式节点')
    ok(cn && cn['dialer-proxy'] === OWN[ownKey].name, `dialer-proxy 指向中转（${cn && cn['dialer-proxy']}）`)
    ok(cn && cn.server === land.kv.server && cn.network === 'ws', '完整复制了落地节点的配置')
    ok(cn && cn['ws-opts'] && cn['ws-opts'].path === '/ray', '嵌套的传输层参数一并复制')
    ok(!!cd.proxies.find(p => p.name === land.name), '原落地节点仍然保留')
    const g = cd['proxy-groups'].find(x => x.name === '🤖 AI')
    ok(g && g.proxies.length === 1 && g.proxies[0] === '🔗 AI 家宽链', '策略指向链式节点')
    const pn = new Set(cd.proxies.map(p => p.name)), gn = new Set(cd['proxy-groups'].map(g2 => g2.name)), dang = []
    cd['proxy-groups'].forEach(g2 => (g2.proxies || []).forEach(x => {
      if (!pn.has(x) && !gn.has(x) && !['DIRECT', 'REJECT'].includes(x)) dang.push(x)
    }))
    ok(dang.length === 0, 'Clash 无悬空引用' + (dang.length ? ': ' + dang.slice(0, 2) : ''))
  }

  // sing-box：detour 指向中转的 tag
  const sb = JSON.parse(T.genSB(up, pol, LIB, OWN, SET, chains))
  const so = sb.outbounds.find(o => o.tag === '🔗 AI 家宽链')
  ok(!!so && so.detour === OWN[ownKey].name, `detour 指向中转（${so && so.detour}）`)
  ok(so && so.transport && so.transport.type === 'ws', '链式 outbound 保留传输层')
  const tags = new Set(sb.outbounds.map(o => o.tag)), miss = []
  sb.outbounds.forEach(o => (o.outbounds || []).forEach(x => { if (!tags.has(x)) miss.push(`${o.tag}→${x}`) }))
  sb.route.rules.forEach(r => { if (r.outbound && !tags.has(r.outbound)) miss.push('rule→' + r.outbound) })
  ok(tags.has(so.detour), 'detour 指向的 outbound 确实存在')
  ok(miss.length === 0, 'sing-box 无悬空引用' + (miss.length ? ': ' + miss.slice(0, 2) : ''))

  // share 格式没有链式的写法，硬塞进去会变成不带中转的直连，出口 IP 全变
  const shLines = Buffer.from(T.genShare(up, OWN), 'base64').toString('utf8').split('\n').filter(Boolean)
  ok(!shLines.some(l => decodeURIComponent(l).includes('AI 家宽链')), 'share 格式里不含链式节点')

  // 链被删掉后，指向它的策略必须干净回落，不能留悬空引用
  const cy2 = yaml ? yaml.load(T.genClash(false, up, pol, LIB, OWN, SET, [])) : null
  if (cy2) {
    const g2 = cy2['proxy-groups'].find(x => x.name === '🤖 AI')
    ok(g2 && g2.proxies[0] === '🚀 节点选择', '链没了策略回落到节点选择')
    ok(!cy2.proxies.find(p => p.name === '🔗 AI 家宽链'), '链没了就不生成该节点')
  }
  ok(T.resolveTarget('chain:nonexist', liveKeys, OWN, []) === '🚀 节点选择', '指向不存在的链会回落')
  ok(T.resolveTarget('chain:c1', liveKeys, OWN, [{ id: 'c1', name: '🔗 AI 家宽链' }]) === '🔗 AI 家宽链', 'chain: 目标能解析')

  // 档案可以按机场/地区裁剪节点。落地若恰好被这份档案排除掉，链不能就此消失 ——
  // 用户是在链式配置里显式选的它，界面上看着好好的、订阅里却没有，最难排查。
  const trimmed = up.filter(n => n.key !== land.key)
  ok(!trimmed.find(n => n.key === land.key), '构造出一份不含落地节点的档案视图')
  const cyT = yaml ? yaml.load(T.genClash(false, trimmed, pol, LIB, OWN, SET, chains, up)) : null
  if (cyT) {
    const cn = cyT.proxies.find(p => p.name === '🔗 AI 家宽链')
    ok(!!cn && cn['dialer-proxy'] === OWN[ownKey].name, '落地被档案排除时，链式节点照样生成')
    ok(!cyT.proxies.find(p => p.name === land.name), '落地节点本身仍按档案被排除，没被顺带塞回来')
    const pn = new Set(cyT.proxies.map(p => p.name)), gn = new Set(cyT['proxy-groups'].map(g => g.name)), d3 = []
    cyT['proxy-groups'].forEach(g => (g.proxies || []).forEach(x => {
      if (!pn.has(x) && !gn.has(x) && !['DIRECT', 'REJECT'].includes(x)) d3.push(x)
    }))
    ok(d3.length === 0, '此时仍无悬空引用')
  }
  const sbT = JSON.parse(T.genSB(trimmed, pol, LIB, OWN, SET, chains, up))
  ok(!!sbT.outbounds.find(o => o.tag === '🔗 AI 家宽链'), 'sing-box 同样不受档案裁剪影响')
  // 不传 pool 时退回旧行为，老调用方不受影响
  const cyN = yaml ? yaml.load(T.genClash(false, trimmed, pol, LIB, OWN, SET, chains)) : null
  if (cyN) ok(!cyN.proxies.find(p => p.name === '🔗 AI 家宽链'), '不传节点池时按传入的 up 判断')
}

sec('36. 链式代理的接口契约')
{
  const exp = String(Date.now() + 3600e3)
  const cookie = 'sess=' + encodeURIComponent(exp + '.' + await T.hmac(await T.sessionSecret(), exp))
  const call = async body => {
    const req = new Request('https://x/api/chains', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    })
    const r = await T.apiRoute(req, new URL('https://x/api/chains'), null)
    return { status: r.status, body: await r.json() }
  }
  delete KV['chains']
  let r = await call({ act: 'save', name: '链A', via: 'own:usV2', out: 'up::node1' })
  ok(r.body.ok && r.body.chains.length === 1, '新建链')
  const id = r.body.chains[0].id
  ok(r.body.chains[0].enabled === true, '默认启用')

  // 名字直接就是客户端里的节点名，重名等于互相覆盖
  r = await call({ act: 'save', name: '链A', via: 'own:usV2', out: 'up::node2' })
  ok(!r.body.ok && /同名/.test(r.body.msg), '拒绝重名的链')

  r = await call({ act: 'save', name: '', via: 'own:usV2', out: 'up::node1' })
  ok(!r.body.ok && /名字/.test(r.body.msg), '拒绝空名字')
  r = await call({ act: 'save', name: '链B', via: '', out: 'up::node1' })
  ok(!r.body.ok && /中转和落地/.test(r.body.msg), '中转或落地为空则拒绝')

  r = await call({ act: 'save', id: id, name: '链A改名', via: 'own:usH', out: 'up::node3' })
  ok(r.body.ok && r.body.chains.length === 1 && r.body.chains[0].name === '链A改名', '编辑不会新增一条')
  ok(r.body.chains[0].via === 'own:usH' && r.body.chains[0].out === 'up::node3', '中转与落地都已更新')

  r = await call({ act: 'toggle', id: id })
  ok(r.body.chains[0].enabled === false, '可停用')
  r = await call({ act: 'toggle', id: id })
  ok(r.body.chains[0].enabled === true, '可重新启用')

  r = await call({ act: 'del', id: id })
  ok(r.body.ok && r.body.chains.length === 0, '可删除')
  r = await call({ act: '乱来' })
  ok(!r.body.ok, '未知操作被拒')

  const anon = await T.apiRoute(new Request('https://x/api/chains', { method: 'POST', body: '{"act":"del"}' }),
    new URL('https://x/api/chains'), null)
  ok(anon.status === 401, '未登录访问返回 401')

  const ui = T.adminHTML(true, true)
  ok(/function chainCardInner/.test(ui), '管理端有链式代理卡片')
  ok(/window\.editChain/.test(ui), '有编辑入口')
  ok(/出口 IP 是<b>落地<\/b>的/.test(ui), '说明了出口是哪一跳')
  ok(/base64 分享链接格式里没有对应写法/.test(ui), '说明了 share 格式不支持')
  ok(/dialer-proxy 是加在节点上的字段/.test(ui), '解释了落地为什么只能选具体节点')
  delete KV['chains']
}

console.log(`\n${'='.repeat(46)}\n通过 ${pass} · 失败 ${fail}\n${'='.repeat(46)}`)
process.exit(fail ? 1 : 0)

})()
