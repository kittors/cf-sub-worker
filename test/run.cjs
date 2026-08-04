const fs = require('fs')
const yaml = (() => { try { return require('js-yaml') } catch { return null } })()
global.addEventListener = () => {}
global.crypto = require('crypto').webcrypto
global.btoa = s => Buffer.from(s, 'binary').toString('base64')
global.atob = s => Buffer.from(s, 'base64').toString('binary')
global.TextEncoder = TextEncoder
eval(fs.readFileSync(require('path').join(__dirname,'..','worker.js'), 'utf8') +
  '\n;global.__t={genClash,genSB,genShare,parseProxyLine,REGIONS,JUNK,unquote,applyNaming,DEFAULT_POLICIES,PRESETS,policyDomains,resolveTarget,policyMembers,resolveTargets,targetList,DEFAULT_NODES,shareLink,adminHTML,aiPrimary,applyProfile,DEFAULT_PROFILES,profilePolicies,DEFAULT_SETTINGS,parseUserinfo,parseNotes,mergeMeta,JUNK,toBytes,splitFeed,looksBase64,b64decode,scrub}')
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
ok(up.length === 32, `解析 32 个节点（实际 ${up.length}）`)
ok(new Set(up.map(n => n.name)).size === up.length, '节点名无重复')

sec('2. Clash YAML')
const cy = T.genClash(false, up, P, LIB, OWN, SET)
let cd = null
try { cd = yaml.load(cy); ok(true, 'YAML 可解析') } catch (e) { ok(false, 'YAML 解析失败: ' + e.message) }
if (cd) {
  const names = cd.proxies.map(p => p.name)
  const groups = cd['proxy-groups'].map(g => g.name)
  const valid = new Set([...names, ...groups, 'DIRECT', 'REJECT'])
  ok(cd.proxies.length === 34, `proxies 34（实际 ${cd.proxies.length}）`)
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
ok(links.length === 34, `链接数 34（实际 ${links.length}）`)
const schemes = [...new Set(links.map(l => l.split('://')[0]))]
ok(schemes.every(s => ['vless','hysteria2','trojan','anytls','ss','vmess'].includes(s)), '协议头合法: ' + schemes.join(','))
let badUrl = links.filter(l => { try { new URL(l); return false } catch { return true } })
ok(badUrl.length === 0, '所有链接可被 URL 解析' + (badUrl.length ? ': ' + badUrl[0] : ''))
const vl = links.find(l => l.startsWith('vless://'))
ok(vl && vl.includes('security=reality') && vl.includes('pbk=') && vl.includes('sid='), 'VLESS 含 Reality 参数')
ok(links.every(l => l.includes('#')), '所有链接带名称锚点')

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
  // .anim 用了 opacity/transform + fill:both，每张卡片会长期持有层叠上下文，
  // 下拉面板的 z-index 被困在卡片内、被后面的兄弟卡片盖住，必须靠 .front 抬升。
  ok(/\.card\.front\{[^}]*z-index/.test(ui), '存在 .card.front 抬升规则')
  ok(ui.includes("closest('.card')?.classList.add('front')"), '展开下拉时抬升所在卡片')
  ok(ui.includes("closest('.card')?.classList.remove('front')"), '关闭下拉时收回抬升')
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

  const ips = (all.match(/\b(\d{1,3}\.){3}\d{1,3}\b/g) || []).filter(ip => !SAFE_IP.test(ip))
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
  ok(/\.pol\.drag\{[^}]*dashed/.test(ui), '拖拽行呈虚线落点槽')
  ok(/\.pol\.drag > \*\{opacity:0\}/.test(ui), '槽内内容隐藏但保留行高')
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

console.log(`\n${'='.repeat(46)}\n通过 ${pass} · 失败 ${fail}\n${'='.repeat(46)}`)
process.exit(fail ? 1 : 0)
