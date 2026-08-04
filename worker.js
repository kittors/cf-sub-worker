addEventListener('fetch', event => {
  event.respondWith(handle(event.request, event))
})

// KV 绑定名：CONF。未绑定时订阅仍可用（只出自有节点），管理端会提示。
const hasKV = typeof CONF !== 'undefined'

// 首次初始化用的 token，由 deploy.sh 生成后作为 Worker secret 注入。
// 仅用于「首次设置管理密码」这一步；之后每份订阅的 token 都在管理端管理。
const INIT_TOKEN = typeof SETUP_TOKEN !== 'undefined' ? SETUP_TOKEN : ''

// === 站点设置 ===
// 全部存 KV，部署后在管理端「设置」里填，代码里不留任何实际站点信息。
const DEFAULT_SETTINGS = {
  domain: '',        // 本站域名，用于 DNS 策略与直连规则
  directDomains: [], // 额外直连域名
  directIPs: []      // 额外直连 IP（如自建节点所在服务器，避免按 IP 连接时被兜底送进代理）
}
async function loadSettings() {
  const v = await kvGet('settings', null)
  return { ...DEFAULT_SETTINGS, ...(v && typeof v === 'object' ? v : {}) }
}

// 自有节点默认为空，在管理端「节点」页添加。
const DEFAULT_NODES = {}

// DNS 查询走哪个出口：取第一个自有节点。自有节点全被删空时回退到节点选择组，
// 避免生成一个指向不存在 outbound 的 detour 让 sing-box 拒绝启动。
function aiPrimary(own) {
  const first = Object.values(own || {})[0]
  return first ? first.name : '🚀 节点选择'
}

async function loadOwn() {
  const n = await kvGet('nodes', null)
  return (n && typeof n === 'object' && Object.keys(n).length) ? n : DEFAULT_NODES
}

const UPSTREAM_UA = 'clash-verge/v2.0.0'
const FRESH_TTL = 3600      // 1h 内直接用缓存
const STALE_TTL = 604800    // 缓存保留 7d，上游挂了拿它兜底

// 地区分类：顺序敏感，先匹配先归类
const REGIONS = [
  { key: 'jp', flag: '🇯🇵', cn: '日本', re: /日本|JP\b|Japan|东京|大阪|川日|穗日|沪日/i },
  { key: 'hk', flag: '🇭🇰', cn: '香港', re: /香港|HK\b|Hong ?Kong|港/i },
  { key: 'tw', flag: '🇹🇼', cn: '台湾', re: /台湾|台北|TW\b|Taiwan|台/i },
  { key: 'sg', flag: '🇸🇬', cn: '新加坡', re: /新加坡|狮城|SG\b|Singapore/i },
  { key: 'kr', flag: '🇰🇷', cn: '韩国', re: /韩国|首尔|KR\b|Korea/i },
  { key: 'us', flag: '🇺🇸', cn: '美国', re: /美国|美西|美东|洛杉矶|堪萨斯|硅谷|圣何塞|US\b|United States/i },
  { key: 'uk', flag: '🇬🇧', cn: '英国', re: /英国|伦敦|UK\b|GB\b|Britain/i },
  { key: 'de', flag: '🇩🇪', cn: '德国', re: /德国|法兰克福|DE\b|Germany/i },
  { key: 'fr', flag: '🇫🇷', cn: '法国', re: /法国|巴黎|FR\b|France/i },
  { key: 'ca', flag: '🇨🇦', cn: '加拿大', re: /加拿大|CA\b|Canada/i },
  { key: 'other', flag: '🌐', cn: '其他', re: /.*/ }
]

// 机场塞在 proxies 里的流量/到期公告，不是真节点
// 公告条目识别。只匹配明确的公告措辞，不能光凭"流量"二字——
// 机场里有「香港原生IP-1|勿跑大流量」这类正常节点名。
const JUNK = new RegExp([
  '剩余流量','剩馀流量','可用流量','总流量','已用流量','套餐流量',
  '距离下次重置','重置剩余','流量重置','下次重置',
  '套餐到期','到期时间','过期时间','有效期至','到期日',
  '去官网','官网更新','建议每天','更新订阅','订阅链接','购买续费','续费',
  '当前状态','公告','通知','客服','群组','频道',
  'Expire[sd]?\\s*[:：]','Traffic\\s*[:：]','Reset\\s*[:：]','Used\\s*[:：]','Total\\s*[:：]'
].join('|'), 'i')

// ---------- 预置域名库 ----------
// 管理端可增删改；改动存 KV，之后以 KV 为准，这里只是首次初始化的种子。
const PRESETS = {
  openai: { name: 'OpenAI', hint: 'ChatGPT 全链路，含认证/支付/风控依赖', domains: [
    'chatgpt.com','openai.com','oaistatic.com','oaiusercontent.com',
    'chat.openai.com','desktop.chat.openai.com','ios.chat.openai.com','android.chat.openai.com',
    'auth.openai.com','auth0.openai.com','setup.auth.openai.com',
    'cdn.workos.com','setup.workos.com','forwarder.workos.com','images.workoscdn.com','workos.imgix.net',
    'ct.sendgrid.net','js.stripe.com','stripe.com',
    'statsig.com','statsigapi.net','events.statsigapi.net',
    'featuregates.org','featureassets.org','prodregistryv2.org',
    'intercom.io','intercomcdn.com','js.intercomcdn.com',
    'rum.browser-intake-datadoghq.com','browser-intake-datadoghq.com',
    'o207216.ingest.sentry.io','o33249.ingest.sentry.io','sentry.io',
    'chatgpt.livekit.cloud','host.livekit.cloud','turn.livekit.cloud',
    'challenges.cloudflare.com','client-api.arkoselabs.com','openai-api.arkoselabs.com',
    'static.cloudflareinsights.com','algolia.net','auth0.com','launchdarkly.com','segment.io',
    'openaiapi-site.azureedge.net','production-openaicom-storage.azureedge.net',
    'openaicomproductionae4b.blob.core.windows.net','openaicom-api-bdcpf8c6d2e9atf6.z01.azurefd.net'
  ]},
  ai: { name: 'AI 服务', hint: 'Claude / Gemini / DeepSeek / Copilot 等', domains: [
    'anthropic.com','claude.ai','api.anthropic.com',
    'googleapis.com','gemini.google.com','generativelanguage.googleapis.com',
    'bard.google.com','deepmind.google','aistudio.google.com',
    'cohere.ai','api.cohere.ai','mistral.ai','api.mistral.ai',
    'perplexity.ai','perplexity.com','githubcopilot.com','copilot.microsoft.com',
    'huggingface.co','together.xyz','fireworks.ai','groq.com','api.groq.com',
    'deepseek.com','api.deepseek.com','x.ai','grok.com','moonshot.cn','bigmodel.cn'
  ]},
  aitest: { name: 'IP 检测', hint: '验证出口用，务必与服务端 ai-proxy 表保持一致', domains: [
    'ping0.cc','ip.net.coffee'
  ]},
  google: { name: 'Google', hint: '账号基础设施；不整族同出口会被判定异地', domains: [
    'google.com','gstatic.com','googleusercontent.com','google.cn',
    'googlesource.com','googletagmanager.com','google-analytics.com',
    'dns.google','withgoogle.com','goo.gl','ggpht.com'
  ]},
  media: { name: '流媒体', hint: 'Netflix / Disney+ / Spotify / Twitch 等', domains: [
    'netflix.com','nflxvideo.net','nflximg.net','nflxext.com','nflxso.net',
    'spotify.com','scdn.co','spotifycdn.com',
    'disneyplus.com','dssott.com','bamgrid.com','disney-plus.net',
    'hulu.com','hbomax.com','max.com','primevideo.com','aiv-cdn.net',
    'twitch.tv','ttvnw.net','jtvnw.net','crunchyroll.com','abema.tv',
    'nicovideo.jp','bilibili.tv','iq.com','viu.com'
  ]},
  youtube: { name: 'YouTube', hint: '含 API 与 CDN；须排在 Google 规则之前', domains: [
    'youtube.com','youtu.be','googlevideo.com','ytimg.com',
    'youtube-nocookie.com','youtubei.googleapis.com','yt3.ggpht.com'
  ]},
  social: { name: '社交媒体', hint: 'X / Meta 系 / TikTok / Reddit 等', domains: [
    'twitter.com','x.com','t.co','twimg.com','twitterinc.com',
    'instagram.com','cdninstagram.com','facebook.com','fbcdn.net',
    'messenger.com','threads.net','whatsapp.com',
    'tiktok.com','tiktokv.com','tiktokcdn.com','tiktokcdn-us.com',
    'byteoversea.com','ibytedtos.com','muscdn.com','musical.ly',
    'reddit.com','redditmedia.com','redd.it','redditstatic.com',
    'discord.com','discord.gg','discordapp.com','discordapp.net',
    'pinterest.com','tumblr.com','pixiv.net','pximg.net','medium.com','quora.com'
  ]},
  telegram: { name: 'Telegram', hint: '含 DC 网段，建议配合 IP-CIDR', domains: [
    'telegram.org','t.me','telegram.me','telesco.pe','tdesktop.com','telegra.ph'
  ]},
  apple: { name: 'Apple', hint: '默认直连更快；跨区账号才需走代理', domains: [
    'apple.com','icloud.com','icloud-content.com','mzstatic.com',
    'apple-cloudkit.com','cdn-apple.com','apple.news','applemusic.com',
    'itunes.com','me.com','aaplimg.com'
  ]},
  microsoft: { name: 'Microsoft', hint: 'Office / OneDrive / Teams / Xbox', domains: [
    'microsoft.com','microsoftonline.com','office.com','office365.com',
    'live.com','windows.net','windowsupdate.com','msftconnecttest.com',
    'sharepoint.com','onedrive.com','skype.com','teams.microsoft.com',
    'xbox.com','xboxlive.com','msn.com','bing.com'
  ]},
  dev: { name: '开发者', hint: 'GitHub / npm / Docker / StackOverflow', domains: [
    'github.com','github.io','githubusercontent.com','githubassets.com',
    'gitlab.com','bitbucket.org','npmjs.com','npmjs.org','yarnpkg.com',
    'docker.com','docker.io','pypi.org','pythonhosted.org',
    'rubygems.org','crates.io','golang.org','go.dev',
    'stackoverflow.com','stackexchange.com','sourceforge.net','jsdelivr.net','unpkg.com'
  ]},
  crypto: { name: '加密货币', hint: '交易所与行情站', domains: [
    'binance.com','binance.us','okx.com','bybit.com','coinbase.com',
    'kraken.com','huobi.com','gate.io','kucoin.com','bitfinex.com',
    'coinmarketcap.com','coingecko.com','tradingview.com'
  ]},
  misc: { name: '常用境外站', hint: 'Wikipedia / 归档 / 视频等', domains: [
    'wikipedia.org','wikimedia.org','archive.org','vimeo.com','dailymotion.com',
    'imgur.com','patreon.com','producthunt.com','notion.so','figma.com',
    'dropbox.com','slack.com','zoom.us','steamcommunity.com','steampowered.com'
  ]}
}

// 分流目标可选值：
//   own:<自有节点 key>  自有节点     region:<REGIONS key>  机场地区组
//   all              全部节点     direct / reject       直连 / 拒绝
// strict=true 时策略组内只放目标本身，节点不可用即失败，不会静默回落到别处。
const DEFAULT_POLICIES = [
  { id:'youtube', name:'📺 YouTube',  target:'region:jp',  strict:false, presets:['youtube'], domains:[], keywords:[], processes:[], enabled:true },
  { id:'media',   name:'🎬 流媒体',    target:'region:jp',  strict:false, presets:['media'],   domains:[], keywords:[], processes:[], enabled:true },
  { id:'social',  name:'💬 社交媒体',  target:'region:jp',  strict:false, presets:['social'],  domains:[], keywords:[], processes:[], enabled:true },
  { id:'openai',  name:'🤖 OpenAI',   target:'own:usV2',   strict:true,  presets:['openai'],  domains:[], keywords:[], processes:['ChatGPT'], enabled:true },
  { id:'ai',      name:'🤖 AI 服务',   target:'own:usV2',   strict:true,  presets:['ai','aitest','google'], domains:[], keywords:[], processes:[], enabled:true },
  { id:'crypto',  name:'💰 加密货币',  target:'own:usV2',   strict:false, presets:['crypto'],  domains:[], keywords:['binance'], processes:[], enabled:true },
  { id:'tg',      name:'✈️ Telegram', target:'all',        strict:false, presets:['telegram'],domains:[], keywords:[], processes:[], enabled:true },
  { id:'dev',     name:'⚙️ 开发者',    target:'all',        strict:false, presets:['dev'],     domains:[], keywords:[], processes:[], enabled:true },
  { id:'apple',   name:'🍎 Apple',    target:'direct',     strict:false, presets:['apple'],   domains:[], keywords:[], processes:[], enabled:true },
  { id:'ms',      name:'🪟 Microsoft', target:'direct',    strict:false, presets:['microsoft'],domains:[],keywords:[], processes:[], enabled:true },
  { id:'misc',    name:'🌐 常用境外',  target:'all',        strict:false, presets:['misc'],    domains:[], keywords:[], processes:[], enabled:true }
]

// 合并策略自身的域名与它引用的预置集，去重后保持顺序
function policyDomains(p, lib) {
  const out = [], seen = new Set()
  const push = d => { d = String(d).trim().toLowerCase(); if (d && !seen.has(d)) { seen.add(d); out.push(d) } }
  ;(p.presets || []).forEach(k => (lib[k]?.domains || []).forEach(push))
  ;(p.domains || []).forEach(push)
  return out
}

async function loadPolicies() {
  const ps = await kvGet('policies', null)
  return Array.isArray(ps) && ps.length ? ps : DEFAULT_POLICIES
}

async function loadLib() {
  const lib = await kvGet('lib', null)
  return lib && typeof lib === 'object' ? { ...PRESETS, ...lib } : PRESETS
}

// ---------- 订阅档案 ----------
// 一个 token 对应一份"配置视图"：可挑选包含哪些自有节点 / 机场源 / 地区 / 策略。
// 'all' 表示不筛选；数组表示白名单。
// policies:
//   'inherit'  用全局策略（可再用 pols 白名单裁剪）
//   [...]      该订阅专属的完整策略数组，与全局互不影响
const DEFAULT_PROFILES = [{
  id: 'main', name: '主订阅', token: INIT_TOKEN, enabled: true,
  own: 'all', ups: 'all', regions: 'all', pols: 'all',
  policies: 'inherit', mode: 'whitelist', note: ''
}]

async function loadProfiles() {
  const ps = await kvGet('profiles', null)
  return Array.isArray(ps) && ps.length ? ps : DEFAULT_PROFILES
}

// 按档案裁剪出这份订阅该看到的内容。
// 档案带专属策略时直接用它，否则回落到全局策略并按 pols 白名单裁剪。
function applyProfile(prof, own, up, globalPolicies) {
  const inList = (v, x) => v === 'all' || (Array.isArray(v) && v.includes(x))
  const fOwn = {}
  for (const [k, n] of Object.entries(own)) if (inList(prof.own, k)) fOwn[k] = n
  const fUp = up.filter(n => inList(prof.ups, n.up) && inList(prof.regions, n.region))
  const fPol = Array.isArray(prof.policies)
    ? prof.policies.filter(p => p.enabled !== false)
    : globalPolicies.filter(p => inList(prof.pols, p.id))
  return { own: fOwn, up: fUp, policies: fPol }
}

// 档案实际生效的策略（管理端预览与保存都走它）
function profilePolicies(prof, globalPolicies) {
  return Array.isArray(prof.policies) ? prof.policies : globalPolicies
}



// ---------- KV 封装 ----------

async function kvGet(key, def) {
  if (!hasKV) return def
  try {
    const v = await CONF.get(key, 'json')
    return v === null || v === undefined ? def : v
  } catch (e) { return def }
}

async function kvPut(key, val) {
  if (!hasKV) throw new Error('KV 未绑定')
  await CONF.put(key, JSON.stringify(val))
}

// ---------- 认证 ----------

const enc = new TextEncoder()

function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256(s) {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)))
}

async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))
}

function randHex(n) {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('')
}

// 会话密钥：首次访问时生成并落 KV
async function sessionSecret() {
  let s = await kvGet('auth:secret', null)
  if (!s) { s = randHex(32); await kvPut('auth:secret', s) }
  return s
}

async function makeCookie() {
  const exp = Date.now() + 7 * 86400 * 1000
  const payload = String(exp)
  const sig = await hmac(await sessionSecret(), payload)
  return `${payload}.${sig}`
}

async function checkCookie(req) {
  if (!hasKV) return false          // 无 KV 时拿不到会话密钥，一律未登录
  const raw = req.headers.get('Cookie') || ''
  const m = raw.match(/(?:^|;\s*)sess=([^;]+)/)
  if (!m) return false
  const [payload, sig] = decodeURIComponent(m[1]).split('.')
  if (!payload || !sig) return false
  if (Number(payload) < Date.now()) return false
  try {
    return sig === await hmac(await sessionSecret(), payload)
  } catch (e) { return false }
}

// ---------- 上游订阅解析 ----------

// 按顶层逗号切分，跳过引号内和括号内的逗号
function splitTop(s) {
  const out = []
  let buf = '', depth = 0, q = ''
  for (const ch of s) {
    if (q) {
      buf += ch
      if (ch === q) q = ''
      continue
    }
    if (ch === '"' || ch === "'") { q = ch; buf += ch; continue }
    if (ch === '[' || ch === '{') depth++
    if (ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf.trim()) out.push(buf)
  return out
}

function unquote(v) {
  v = String(v).trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1)
  return v
}

// 解析 `- { name: x, type: y, ... }` 单行节点
function parseProxyLine(line) {
  const m = line.match(/^\s*-\s*\{(.+)\}\s*$/)
  if (!m) return null
  const obj = {}
  for (const pair of splitTop(m[1])) {
    const i = pair.indexOf(':')
    if (i < 0) continue
    const k = pair.slice(0, i).trim()
    if (k) obj[k] = pair.slice(i + 1).trim()
  }
  if (!obj.name || !obj.type) return null
  obj._name = unquote(obj.name)
  return obj
}

// ---------- 机场元信息解析（流量 / 到期）----------
// 各家机场给法不一：多数走 Subscription-Userinfo 头，也有只把信息塞进节点名当公告的，
// 还有两者都给但单位、日期格式各异。这里三路都认，头优先、公告兜底。

const SZ = { b:1, kb:1024, mb:1048576, gb:1073741824, tb:1099511627776, pb:1125899906842624 }
function toBytes(n, unit) {
  const u = String(unit || 'gb').toLowerCase().replace(/i?b?$/, '') + 'b'
  return Math.round(Number(n) * (SZ[u] || SZ.gb))
}

// 标准头：upload=..; download=..; total=..; expire=..（expire 有秒也有毫秒）
function parseUserinfo(h) {
  if (!h) return null
  const o = {}
  String(h).split(/[;,]/).forEach(seg => {
    const i = seg.indexOf('=')
    if (i < 0) return
    const k = seg.slice(0, i).trim().toLowerCase()
    const v = Number(seg.slice(i + 1).trim())
    if (k && Number.isFinite(v)) o[k] = v
  })
  if (!Object.keys(o).length) return null
  let expire = o.expire || 0
  if (expire > 1e12) expire = Math.floor(expire / 1000)   // 毫秒时间戳
  return { up: o.upload || 0, down: o.download || 0, total: o.total || 0, expire }
}

// 公告文本兜底。覆盖常见中英文写法与单位，解析不到就留空，绝不猜。
function parseNotes(notes) {
  const o = {}
  const U = '(TB|GB|MB|KB|T|G|M|K)'
  for (const raw of notes) {
    const t = String(raw)
    // 到期：2026-08-10 / 2026/08/10 / 2026年8月10日
    let m = t.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/)
    if (m && !o.expire) {
      const d = Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59)
      if (Number.isFinite(d)) o.expire = Math.floor(d / 1000)
    }
    // 组合写法：已用 390.8GB / 总量 1200GB
    m = t.match(new RegExp('([\\d.]+)\\s*' + U + '\\s*/\\s*([\\d.]+)\\s*' + U, 'i'))
    if (m) {
      if (o.used === undefined) o.used = toBytes(m[1], m[2])
      if (!o.total) o.total = toBytes(m[3], m[4])
      continue
    }
    // 剩余流量：809.16 GB
    m = t.match(new RegExp('(?:剩余|剩馀|可用|Remain(?:ing)?|Left)\\s*(?:流量|Traffic)?\\s*[:：]?\\s*([\\d.]+)\\s*' + U, 'i'))
    if (m && o.left === undefined) { o.left = toBytes(m[1], m[2]); continue }
    // 总量 / 套餐流量
    m = t.match(new RegExp('(?:总量|总流量|套餐流量|Total)\\s*[:：]?\\s*([\\d.]+)\\s*' + U, 'i'))
    if (m && !o.total) { o.total = toBytes(m[1], m[2]); continue }
    // 已用
    m = t.match(new RegExp('(?:已用|已使用|Used)\\s*(?:流量)?\\s*[:：]?\\s*([\\d.]+)\\s*' + U, 'i'))
    if (m && o.used === undefined) { o.used = toBytes(m[1], m[2]); continue }
    // 距离下次重置剩余：7 天
    m = t.match(/重置[^0-9]{0,8}(\d+)\s*天/)
    if (m && !o.reset) { o.reset = +m[1]; continue }
    // 剩余 30 天（到期倒数，需排除"重置"语境）
    m = t.match(/(?:剩余|还有|有效期)[^0-9]{0,6}(\d+)\s*天/)
    if (m && !o.expire && !/重置/.test(t)) {
      o.expire = Math.floor(Date.now() / 1000) + (+m[1]) * 86400
    }
  }
  return o
}

// 头与公告合并：头有的字段优先，缺的用公告补
function mergeMeta(head, note) {
  const m = { up: 0, down: 0, total: 0, expire: 0 }
  if (head) Object.assign(m, head)
  if (note) {
    if (!m.total && note.total) m.total = note.total
    if (!m.expire && note.expire) m.expire = note.expire
    // 头没给用量时，用公告的已用或"总量-剩余"反推
    if (!m.up && !m.down) {
      if (note.used !== undefined) m.down = note.used
      else if (note.left !== undefined && m.total) m.down = Math.max(0, m.total - note.left)
    }
    // 只有剩余、没有总量时，把剩余当作可展示的总量下限
    if (!m.total && note.left !== undefined) { m.total = note.left; m.down = 0 }
    if (note.reset) m.reset = note.reset
  }
  return (m.total || m.expire) ? m : null
}

// 拉一个机场，返回原始节点（未重命名）与订阅元信息
async function fetchUpstream(u) {
  const r = await fetch(u.url, { headers: { 'User-Agent': UPSTREAM_UA }, cf: { cacheTtl: 0 } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const head = parseUserinfo(r.headers.get('subscription-userinfo'))
  const text = await r.text()
  const notes = []

  const out = []
  for (const line of text.split('\n')) {
    const p = parseProxyLine(line)
    if (!p) continue
    if (/^(select|url-test|fallback|load-balance|relay)$/.test(p.type)) continue   // proxy-group
    // 公告条目不是节点，但流量/到期常藏在里面，先留作兜底解析
    if (JUNK.test(p._name)) { notes.push(p._name); continue }
    if (unquote(p.server || '') === '127.0.0.1') { notes.push(p._name); continue }
    const hit = REGIONS.find(r => r.re.test(p._name))
    out.push({ up: u.id, upName: u.name, region: hit.key, raw: p._name, kv: p })
  }
  return { nodes: out, info: mergeMeta(head, parseNotes(notes)) }
}

// 拉全部启用的机场，写缓存；失败退回 stale
async function loadNodes(force, event) {
  const cached = await kvGet('cache:nodes', null)
  if (!force && cached && Date.now() - cached.at < FRESH_TTL * 1000) return cached

  const ups = (await kvGet('upstreams', [])).filter(u => u.enabled !== false)
  if (!ups.length) return { at: Date.now(), nodes: [], errors: [] }

  const nodes = [], errors = [], meta = {}
  for (const u of ups) {
    try {
      const r = await fetchUpstream(u)
      if (!r.nodes.length) errors.push({ up: u.name, msg: '解析结果为空' })
      nodes.push(...r.nodes)
      if (r.info) meta[u.id] = r.info
    } catch (e) {
      errors.push({ up: u.name, msg: String(e.message || e) })
    }
  }

  // 全部失败且有旧缓存时，宁可用旧的也不下发空订阅
  if (!nodes.length && cached && cached.nodes.length) {
    return { ...cached, errors, stale: true }
  }

  const data = { at: Date.now(), nodes, errors, meta }
  if (hasKV) {
    const put = CONF.put('cache:nodes', JSON.stringify(data), { expirationTtl: STALE_TTL })
    if (event && event.waitUntil) event.waitUntil(put); else await put
  }
  return data
}

// ---------- 命名引擎 ----------
// 规则：国旗 + 地区 + 两位序号，序号按地区内出现顺序统一排。
// overrides[key].name 优先；overrides[key].off 为 true 则不下发。

function nodeKey(n) { return `${n.up}::${n.raw}` }

function applyNaming(nodes, overrides) {
  const seq = {}
  return nodes.map(n => {
    const k = nodeKey(n)
    const ov = overrides[k] || {}
    const r = REGIONS.find(x => x.key === n.region) || REGIONS[REGIONS.length - 1]
    seq[n.region] = (seq[n.region] || 0) + 1
    const auto = `${r.flag} ${r.cn} ${String(seq[n.region]).padStart(2, '0')}`
    return { ...n, key: k, name: ov.name || auto, auto, custom: !!ov.name, off: !!ov.off }
  })
}

// 只从缓存取节点，绝不触发上游拉取。
// 管理端切 tab 只是要一份地区/机场清单，不该因为缓存恰好过期就卡在网络请求上。
async function cachedNodes() {
  const c = await kvGet('cache:nodes', null)
  if (!c || !Array.isArray(c.nodes)) return []
  const ov = await kvGet('overrides', {})
  return applyNaming(c.nodes, ov).filter(n => !n.off)
}

// stale-while-revalidate：有缓存就立刻返回，过期时交给 waitUntil 在后台刷新。
// 缓存一过期就同步等全量拉取，是管理端点哪都要转圈、订阅端偶发超时的根因。
async function swrNodes(event) {
  const c = await kvGet('cache:nodes', null)
  if (c && Array.isArray(c.nodes) && c.nodes.length) {
    if (Date.now() - c.at >= FRESH_TTL * 1000 && event && event.waitUntil) {
      event.waitUntil(loadNodes(true, event).catch(() => {}))
    }
    const ov = await kvGet('overrides', {})
    return { at: c.at, nodes: c.nodes, errors: c.errors || [], meta: c.meta || {}, stale: !!c.stale, all: applyNaming(c.nodes, ov) }
  }
  return activeNodes(false, event)
}

async function activeNodes(force, event) {
  const d = await loadNodes(force, event)
  const ov = await kvGet('overrides', {})
  return { ...d, meta: d.meta || {}, all: applyNaming(d.nodes, ov) }
}

// ---------- 请求入口 ----------

async function handle(req, event) {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/admin' || path.startsWith('/admin/')) return adminRoute(req, url)
  if (path.startsWith('/api/')) return apiRoute(req, url, event)

  // 订阅输出：token 决定用哪份档案
  const profiles = await loadProfiles()
  const prof = profiles.find(p => p.enabled !== false && p.token === url.searchParams.get('token'))
  if (!prof) return new Response('x', { status: 403 })

  // 格式判定：显式 fmt 优先，否则按 UA 猜。
  // Shadowrocket 与 v2rayN 都能吃 Clash YAML，故并入 clash 分支；
  // 只有明确要 base64 节点列表时才走 share（v2rayN 的 v2ray/Xray 内核场景）。
  const ua = (req.headers.get('User-Agent') || '').toLowerCase()
  let fmt = (url.searchParams.get('fmt') || '').toLowerCase()
  if (fmt === 'sr' || fmt === 'shadowrocket' || fmt === 'v2rayn') fmt = 'clash'
  if (fmt === 'base64' || fmt === 'v2ray' || fmt === 'link') fmt = 'share'
  if (!fmt) fmt = /singbox|sing-box/.test(ua) ? 'singbox' : 'clash'

  // ?upstream=0 应急开关：只下发自有节点
  const useUp = url.searchParams.get('upstream') !== '0'
  const d = useUp ? await swrNodes(event) : { all: [] }
  const up = (d.all || []).filter(n => !n.off)

  const h = {
    'Profile-Update-Interval': '12',
    'Cache-Control': 'no-cache',
    'Subscription-Userinfo': 'upload=0; download=0; total=1073741824000; expire=0'
  }

  const [rawOwn, rawPol, lib, set] = await Promise.all([loadOwn(), loadPolicies(), loadLib(), loadSettings()])
  const f = applyProfile(prof, rawOwn, up, rawPol.filter(p => p.enabled !== false))

  if (fmt === 'share') return new Response(genShare(f.up, f.own), { headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8' } })
  // URL 上的 mode 优先，其次用档案自己的设定
  const mode = url.searchParams.get('mode') || prof.mode || 'whitelist'
  if (fmt === 'singbox') return new Response(genSB(f.up, f.policies, lib, f.own, set), { headers: { ...h, 'Content-Type': 'application/json; charset=utf-8' } })
  return new Response(genClash(mode === 'blacklist', f.up, f.policies, lib, f.own, set), { headers: { ...h, 'Content-Type': 'text/yaml; charset=utf-8' } })
}

// ---------- 管理端路由 ----------

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}

async function adminRoute(req, url) {
  if (url.pathname === '/admin/login' && req.method === 'POST') {
    if (!hasKV) return json({ ok: false, msg: 'KV 未绑定' }, 500)
    const { password, initToken } = await req.json().catch(() => ({}))
    const stored = await kvGet('auth:password', null)

    // 首次初始化：必须同时出示订阅 token，避免管理端在设密码前裸奔
    if (!stored) {
      // 未注入 SETUP_TOKEN 时（例如手动部署）允许直接设密码，否则必须出示它
      if (INIT_TOKEN && initToken !== INIT_TOKEN) return json({ ok: false, msg: '初始化令牌不正确' }, 403)
      if (!password || password.length < 8) return json({ ok: false, msg: '密码至少 8 位' }, 400)
      await kvPut('auth:password', await sha256(password))
    } else if (await sha256(password || '') !== stored) {
      return json({ ok: false, msg: '密码错误' }, 401)
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `sess=${await makeCookie()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
      }
    })
  }

  if (url.pathname === '/admin/logout') {
    return new Response('', { status: 302, headers: { Location: '/admin', 'Set-Cookie': 'sess=; Path=/; Max-Age=0' } })
  }

  const authed = await checkCookie(req)
  const inited = !!(await kvGet('auth:password', null))
  return new Response(adminHTML(authed, inited), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

async function apiRoute(req, url, event) {
  if (!hasKV) return json({ ok: false, msg: 'KV 未绑定，无法读写配置' }, 500)
  if (!await checkCookie(req)) return json({ ok: false, msg: '未登录' }, 401)
  const p = url.pathname

  if (p === '/api/state') {
    const d = await swrNodes(event)
    const ups = await kvGet('upstreams', [])
    const byRegion = {}
    for (const n of d.all) {
      (byRegion[n.region] = byRegion[n.region] || []).push(n)
    }
    // 每个地区里各机场各有多少节点，前端折叠标题上要显示来源
    const bySrc = {}
    for (const n of d.all) {
      (bySrc[n.region] = bySrc[n.region] || {})[n.upName] = ((bySrc[n.region] || {})[n.upName] || 0) + 1
    }
    return json({
      ok: true, upstreams: ups, at: d.at, stale: !!d.stale, errors: d.errors || [],
      meta: d.meta || {}, bySrc,
      regions: REGIONS.filter(r => byRegion[r.key]).map(r => ({
        key: r.key, flag: r.flag, cn: r.cn,
        nodes: byRegion[r.key].map(n => ({ key: n.key, name: n.name, auto: n.auto, raw: n.raw, upName: n.upName, custom: n.custom, off: n.off }))
      })),
      subUrl: `https://${url.hostname}/sub?token=${((await loadProfiles()).find(x => x.enabled !== false) || { token: '' }).token}`
    })
  }

  if (p === '/api/upstreams' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const ups = await kvGet('upstreams', [])
    if (body.act === 'add') {
      if (!/^https?:\/\//.test(body.url || '')) return json({ ok: false, msg: '链接需以 http(s):// 开头' }, 400)
      ups.push({ id: randHex(6), name: body.name || '未命名机场', url: body.url, enabled: true })
    } else if (body.act === 'del') {
      const i = ups.findIndex(u => u.id === body.id)
      if (i >= 0) ups.splice(i, 1)
    } else if (body.act === 'toggle') {
      const u = ups.find(u => u.id === body.id)
      if (u) u.enabled = !u.enabled
    } else return json({ ok: false, msg: '未知操作' }, 400)

    await kvPut('upstreams', ups)
    await CONF.delete('cache:nodes')     // 配置变了，缓存立即作废
    return json({ ok: true })
  }

  if (p === '/api/node' && req.method === 'POST') {
    const { key, name, off } = await req.json().catch(() => ({}))
    if (!key) return json({ ok: false, msg: '缺少 key' }, 400)
    const ov = await kvGet('overrides', {})
    ov[key] = ov[key] || {}
    if (name !== undefined) {
      if (name === '') delete ov[key].name          // 空串 = 恢复自动命名
      else ov[key].name = String(name).slice(0, 40)
    }
    if (off !== undefined) ov[key].off = !!off
    if (!ov[key].name && !ov[key].off) delete ov[key]
    await kvPut('overrides', ov)
    return json({ ok: true })
  }

  if (p === '/api/refresh' && req.method === 'POST') {
    const d = await activeNodes(true, event)
    return json({ ok: true, count: d.all.length, errors: d.errors || [] })
  }

  // 分流策略：读取时附带可选目标（自有节点 + 当前真有节点的地区），
  // 避免前端把策略指向一个不存在的地区、生成悬空引用。
  // 策略读写。带 pf=<档案id> 时操作该订阅的专属策略，不带则操作全局。
  if (p === '/api/policies') {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}))
      const pf = b.pf ? String(b.pf) : ''

      // 切换继承 / 专属
      if (b.act === 'detach' || b.act === 'inherit') {
        if (!pf) return json({ ok: false, msg: '缺少订阅标识' }, 400)
        const profs = await loadProfiles()
        const t = profs.find(x => x.id === pf)
        if (!t) return json({ ok: false, msg: '订阅不存在' }, 400)
        // detach 把当前生效的策略固化成副本，用户从"和全局一样"开始改，不必从零配
        t.policies = b.act === 'detach' ? JSON.parse(JSON.stringify(await loadPolicies())) : 'inherit'
        await kvPut('profiles', profs)
        return json({ ok: true, own: false, policies: profilePolicies(t, await loadPolicies()), inherit: t.policies === 'inherit' })
      }

      if (b.act === 'reset') {
        if (pf) {
          const profs = await loadProfiles()
          const t = profs.find(x => x.id === pf)
          if (!t) return json({ ok: false, msg: '订阅不存在' }, 400)
          t.policies = JSON.parse(JSON.stringify(DEFAULT_POLICIES))
          await kvPut('profiles', profs)
          return json({ ok: true, policies: t.policies, inherit: false })
        }
        await CONF.delete('policies')
        return json({ ok: true, policies: DEFAULT_POLICIES, inherit: true })
      }

      if (!Array.isArray(b.policies)) return json({ ok: false, msg: '数据格式错误' }, 400)
      const clean = b.policies.map(x => ({
        id: String(x.id || randHex(4)).slice(0, 24),
        name: String(x.name || '未命名').slice(0, 24),
        target: Array.isArray(x.target)
          ? [...new Set(x.target.map(String).filter(Boolean))].slice(0, 20)
          : String(x.target || 'all'),
        strict: !!x.strict,
        enabled: x.enabled !== false,
        presets: (x.presets || []).filter(k => typeof k === 'string').slice(0, 40),
        domains: (x.domains || []).map(d => String(d).trim().toLowerCase()).filter(Boolean).slice(0, 2000),
        keywords: (x.keywords || []).map(String).filter(Boolean).slice(0, 100),
        processes: (x.processes || []).map(String).filter(Boolean).slice(0, 100)
      }))
      const names = clean.map(x => x.name)
      if (new Set(names).size !== names.length) return json({ ok: false, msg: '策略名称重复，客户端会拒绝加载' }, 400)

      if (pf) {
        const profs = await loadProfiles()
        const t = profs.find(x => x.id === pf)
        if (!t) return json({ ok: false, msg: '订阅不存在' }, 400)
        t.policies = clean
        await kvPut('profiles', profs)
        return json({ ok: true, policies: clean, inherit: false })
      }
      await kvPut('policies', clean)
      return json({ ok: true, policies: clean, inherit: true })
    }

    const pfId = url.searchParams.get('pf') || ''
    const globals = await loadPolicies()
    const profs = await loadProfiles()
    const cur = pfId ? profs.find(x => x.id === pfId) : null
    const live = [...new Set((await cachedNodes()).map(n => n.region))]
    return json({
      ok: true,
      policies: cur ? profilePolicies(cur, globals) : globals,
      inherit: cur ? !Array.isArray(cur.policies) : true,
      profiles: profs.map(x => ({ id: x.id, name: x.name, own: Array.isArray(x.policies) })),
      pf: pfId,
      lib: await loadLib(),
      targets: [
        { v: 'all', label: '🚀 节点选择（全部）' },
        ...Object.entries(await loadOwn()).map(([k, n]) => ({ v: 'own:' + k, label: n.name + '（自有）' })),
        ...REGIONS.filter(r => live.includes(r.key)).map(r => ({ v: 'region:' + r.key, label: `${r.flag} ${r.cn}（机场）` })),
        { v: 'direct', label: '直连' },
        { v: 'reject', label: '拒绝' }
      ]
    })
  }

  // 订阅档案：一个 token 一份配置视图
  if (p === '/api/profiles') {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}))
      if (b.act === 'reset') { await CONF.delete('profiles'); return json({ ok: true, profiles: DEFAULT_PROFILES }) }
      if (!Array.isArray(b.profiles)) return json({ ok: false, msg: '数据格式错误' }, 400)

      const norm = v => v === 'all' ? 'all' : (Array.isArray(v) ? v.map(String) : 'all')
      const clean = b.profiles.map(x => ({
        id: String(x.id || randHex(4)).slice(0, 24),
        name: String(x.name || '未命名').trim().slice(0, 24),
        token: String(x.token || '').trim(),
        enabled: x.enabled !== false,
        own: norm(x.own), ups: norm(x.ups), regions: norm(x.regions), pols: norm(x.pols),
        policies: Array.isArray(x.policies) ? x.policies : 'inherit',
        mode: x.mode === 'blacklist' ? 'blacklist' : 'whitelist',
        note: String(x.note || '').slice(0, 60)
      }))

      for (const x of clean) {
        if (!x.name) return json({ ok: false, msg: '订阅名称不能为空' }, 400)
        // token 就是唯一凭据，短了容易被猜；同时禁止出现 URL 里需要转义的字符
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(x.token)) return json({ ok: false, msg: `「${x.name}」的 token 需为 16-64 位字母数字（可含 _ -）` }, 400)
        // 允许单独清空自有节点或机场源，但两边都空（或机场源虽在、地区被清光）
        // 会生成一份没有任何节点的订阅，客户端拿到只会一脸茫然，直接挡掉
        const ownEmpty = Array.isArray(x.own) && !x.own.length
        const upsEmpty = Array.isArray(x.ups) && !x.ups.length
        const regEmpty = Array.isArray(x.regions) && !x.regions.length
        if (ownEmpty && (upsEmpty || regEmpty))
          return json({ ok: false, msg: `「${x.name}」筛选后一个节点都不剩，会下发空订阅` }, 400)
      }
      const toks = clean.map(x => x.token)
      if (new Set(toks).size !== toks.length) return json({ ok: false, msg: 'token 重复，无法区分是哪份订阅' }, 400)
      if (!clean.some(x => x.enabled)) return json({ ok: false, msg: '至少保留一份启用的订阅，否则所有客户端都会掉线' }, 400)

      await kvPut('profiles', clean)
      return json({ ok: true, profiles: clean })
    }

    // 返回可选项供前端做筛选，避免前端猜有哪些 id
    const liveRegions = [...new Set((await cachedNodes()).map(n => n.region))]
    return json({
      ok: true,
      profiles: await loadProfiles(),
      newToken: randHex(16),
      opts: {
        own: Object.entries(await loadOwn()).map(([k, n]) => ({ v: k, label: n.name })),
        ups: (await kvGet('upstreams', [])).map(u => ({ v: u.id, label: u.name })),
        regions: REGIONS.filter(r => liveRegions.includes(r.key)).map(r => ({ v: r.key, label: `${r.flag} ${r.cn}` })),
        pols: (await loadPolicies()).filter(x => x.enabled !== false).map(x => ({ v: x.id, label: x.name }))
      }
    })
  }
  // 站点设置：本站域名与额外直连规则，代码里不硬编码任何站点信息
  if (p === '/api/settings') {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}))
      const host = x => String(x).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[\/:].*$/, '')
      const clean = {
        domain: host(b.domain || ''),
        directDomains: (b.directDomains || []).map(host).filter(Boolean).slice(0, 200),
        directIPs: (b.directIPs || []).map(x => String(x).trim())
          .filter(x => /^(\d{1,3}\.){3}\d{1,3}$/.test(x)).slice(0, 100)
      }
      await kvPut('settings', clean)
      return json({ ok: true, settings: clean })
    }
    return json({ ok: true, settings: await loadSettings() })
  }

  // 自有节点：BWG 上自建的节点，与机场订阅无关，独立存 KV
  if (p === '/api/own') {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}))
      if (b.act === 'reset') { await CONF.delete('nodes'); return json({ ok: true, own: DEFAULT_NODES }) }
      if (!b.own || typeof b.own !== 'object') return json({ ok: false, msg: '数据格式错误' }, 400)

      const clean = {}
      for (const [k, v] of Object.entries(b.own)) {
        const key = String(k).replace(/[^\w-]/g, '').slice(0, 24)
        if (!key) return json({ ok: false, msg: '节点标识只能是字母数字和连字符' }, 400)
        const name = String(v.name || '').trim().slice(0, 32)
        const type = v.type === 'hysteria2' ? 'hysteria2' : 'vless'
        if (!name) return json({ ok: false, msg: '节点名称不能为空' }, 400)
        if (!v.s || !v.p || !v.u) return json({ ok: false, msg: `「${name}」缺少服务器/端口/密钥` }, 400)
        // Reality 缺公钥会让客户端握手失败，报错信息又极难定位，提前挡住
        if (type === 'vless' && (!v.pk || !v.sid)) return json({ ok: false, msg: `「${name}」是 VLESS Reality，必须填公钥与 ShortId` }, 400)

        const n = { name, type, s: String(v.s).trim(), p: parseInt(v.p, 10) || 443, u: String(v.u).trim(), sni: String(v.sni || '').trim() }
        if (type === 'vless') {
          n.pk = String(v.pk).trim(); n.sid = String(v.sid).trim()
          n.net = v.net === 'xhttp' ? 'xhttp' : 'tcp'
          n.flow = n.net === 'tcp' ? (v.flow || 'xtls-rprx-vision') : ''
        } else {
          if (v.ports) n.ports = String(v.ports).trim()
          n.obfs = String(v.obfs || 'salamander').trim()
          n.opwd = String(v.opwd || '').trim()
        }
        clean[key] = n
      }
      if (!Object.keys(clean).length) return json({ ok: false, msg: '至少保留一个自有节点' }, 400)
      const names = Object.values(clean).map(n => n.name)
      if (new Set(names).size !== names.length) return json({ ok: false, msg: '节点名称重复，客户端会拒绝加载' }, 400)

      // 被删掉的节点若仍被策略指向会产生悬空引用，挡在保存前
      const pols = await loadPolicies()
      const orphan = pols.filter(x => String(x.target).startsWith('own:') && !clean[String(x.target).slice(4)])
      if (orphan.length) return json({ ok: false, msg: `策略「${orphan[0].name}」正指向将被删除的节点，请先改它的分流目标` }, 400)

      await kvPut('nodes', clean)
      return json({ ok: true, own: clean })
    }
    return json({ ok: true, own: await loadOwn() })
  }
  // 域名库：保存单个集合，域名去重后小写存储
  if (p === '/api/lib' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}))
    if (!b.key) return json({ ok: false, msg: '缺少 key' }, 400)
    const lib = await kvGet('lib', {})
    if (b.act === 'del') delete lib[b.key]
    else {
      const doms = [...new Set((b.domains || []).map(d => String(d).trim().toLowerCase()).filter(Boolean))]
      lib[b.key] = { name: String(b.name || b.key).slice(0, 24), hint: String(b.hint || '').slice(0, 60), domains: doms.slice(0, 3000) }
    }
    await kvPut('lib', lib)
    return json({ ok: true, lib: { ...PRESETS, ...lib } })
  }

  return json({ ok: false, msg: '404' }, 404)
}

// ---------- 订阅生成 ----------

function pick(up, key, fb) {
  const n = up.filter(x => x.region === key).map(x => x.name)
  return n.length ? n : fb
}

function q(a) { return a.map(n => '"' + n + '"').join(', ') }

// 把策略的 target 解析成客户端里真实存在的组名 / 节点名。
// 指向的地区若当前没有节点，退回 🚀 节点选择，避免产生悬空引用让客户端拒绝整份配置。
function resolveTarget(t, liveKeys, own) {
  if (t === 'direct') return 'DIRECT'
  if (t === 'reject') return 'REJECT'
  if (t === 'all') return '🚀 节点选择'
  if (String(t).startsWith('own:')) {
    const n = (own || {})[String(t).slice(4)]
    return n ? n.name : '🚀 节点选择'
  }
  if (String(t).startsWith('region:')) {
    const k = String(t).slice(7)
    const r = REGIONS.find(x => x.key === k)
    return (r && liveKeys.includes(k)) ? `${r.flag} ${r.cn}` : '🚀 节点选择'
  }
  return '🚀 节点选择'
}

// 策略的分流目标可以是一个或多个。历史数据是字符串，新数据是数组，两种都认。
function targetList(p) {
  const t = p.target
  if (Array.isArray(t)) return t.filter(Boolean)
  return t ? [t] : ['all']
}

// 解析成客户端里真实存在的名字，去重后保持选择顺序
function resolveTargets(p, liveKeys, own) {
  const out = []
  for (const t of targetList(p)) {
    const r = resolveTarget(t, liveKeys, own)
    if (r && !out.includes(r)) out.push(r)
  }
  return out.length ? out : ['🚀 节点选择']
}

// 策略组内的候选项。strict 只放选定的目标：目标全挂就断，不静默回落到别的地区。
function policyMembers(p, targets, allN, regionNames) {
  const out = []
  const add = x => { if (x && !out.includes(x)) out.push(x) }
  ;(Array.isArray(targets) ? targets : [targets]).forEach(add)
  if (p.strict) return out
  add('🚀 节点选择'); add('DIRECT')
  regionNames.forEach(add); allN.forEach(add)
  return out
}

function genClash(blacklist, up, policies, lib, own, st) {
  const SET = { ...DEFAULT_SETTINGS, ...(st || {}) }
  const ownN = Object.values(own).map(n => n.name)
  const upN = up.map(n => n.name)
  const allN = [...ownN, ...upN]
  const liveR = REGIONS.filter(r => up.some(n => n.region === r.key))
  const liveKeys = liveR.map(r => r.key)
  const regionNames = liveR.map(r => `${r.flag} ${r.cn}`)
  const act = (policies || []).filter(p => p.enabled !== false)

  let pl = ''
  Object.values(own).forEach(n => {
    if (n.type === 'vless') {
      pl += [
        `  - name: "${n.name}"`,
        `    type: vless`,
        `    server: ${n.s}`,
        `    port: ${n.p}`,
        `    uuid: ${n.u}`,
        `    tls: true`,
        `    servername: ${n.sni}`,
        `    reality-opts:`,
        `      public-key: ${n.pk}`,
        `      short-id: ${n.sid}`,
        `    client-fingerprint: chrome`,
        ...(n.net === 'tcp'
          ? [`    flow: ${n.flow}`, `    network: tcp`]
          : [`    network: xhttp`, `    xhttp-opts:`, `      path: /`, `      mode: auto`]),
        `    udp: true`,
        `\n`
      ].join('\n')
    } else {
      pl += [
        `  - name: "${n.name}"`,
        `    type: hysteria2`,
        `    server: ${n.s}`,
        `    port: ${n.p}`,
        ...(n.ports ? [`    ports: ${n.ports}`] : []),
        `    password: ${n.u}`,
        `    sni: ${n.sni}`,
        `    skip-cert-verify: true`,
        `    udp: true`,
        `    obfs: ${n.obfs}`,
        `    obfs-password: "${n.opwd}"`,
        `\n`
      ].join('\n')
    }
  })

  // 机场节点：原样透传上游字段，只把 name 换成我们生成的
  up.forEach(n => {
    const lines = [`  - name: "${n.name}"`]
    for (const k of Object.keys(n.kv)) {
      if (k === 'name' || k.startsWith('_')) continue
      lines.push(`    ${k}: ${n.kv[k]}`)
    }
    pl += lines.join('\n') + '\n\n'
  })

  // 策略组 —— 每条启用的策略一个 select 组
  const polGroups = act.map(p => {
    const t = resolveTargets(p, liveKeys, own)
    return [
      `  - name: "${p.name}"`,
      `    type: select`,
      `    proxies: [${q(policyMembers(p, t, allN, regionNames))}]`
    ].join('\n')
  }).join('\n')

  const regionGroups = liveR.map(r => [
    `  - name: "${r.flag} ${r.cn}"`,
    `    type: url-test`,
    `    proxies: [${q(up.filter(n => n.region === r.key).map(n => n.name))}]`,
    `    url: http://www.gstatic.com/generate_204`,
    `    interval: 300`,
    `    tolerance: 50`
  ].join('\n')).join('\n')

  // 策略规则 —— 数组顺序即匹配优先级，管理端拖拽排序改的就是它
  const polRules = act.map(p => {
    const rs = []
    policyDomains(p, lib).forEach(d => rs.push(`  - DOMAIN-SUFFIX,${d},${p.name}`))
    ;(p.keywords || []).forEach(k => rs.push(`  - DOMAIN-KEYWORD,${k},${p.name}`))
    ;(p.processes || []).forEach(x => rs.push(`  - PROCESS-NAME,${x},${p.name}`))
    return rs.join('\n')
  }).filter(Boolean).join('\n')

  const tail = blacklist
    ? [`  - GEOSITE,cn,DIRECT`, `  - GEOIP,CN,DIRECT`, `  - MATCH,DIRECT`]
    : [`  - GEOSITE,cn,DIRECT`, `  - GEOIP,CN,DIRECT`, `  - MATCH,🚀 节点选择`]

  return [
    `# 订阅由 Cloudflare Worker 生成（${blacklist ? '黑名单模式' : '白名单模式'}）`,
    `# 自有 ${ownN.length} 节点 / 机场 ${upN.length} 节点 / ${act.length} 条分流策略`,
    `port: 7890`,
    `socks-port: 7890`,
    `mixed-port: 7891`,
    `ipv6: true`,
    `mode: rule`,
    `log-level: warning`,
    `allow-lan: true`,
    `find-process-mode: strict`,
    ``,
    // TUN 模式必须开 sniffer：
    // 客户端若用自带 DoH（Chrome Secure DNS 等）绕过 dns-hijack，Clash 在 TUN 层只能看到目标 IP，
    // 所有 DOMAIN-SUFFIX 规则会静默失效、全部落到 MATCH 兜底。
    // 开启后从 TLS SNI / HTTP Host 还原域名，override-destination 用还原结果重新匹配规则。
    `sniffer:`,
    `  enable: true`,
    `  force-dns-mapping: true`,
    `  parse-pure-ip: true`,
    `  override-destination: true`,
    `  sniff:`,
    `    HTTP:`,
    `      ports: [80, 8080-8880]`,
    `      override-destination: true`,
    `    TLS:`,
    `      ports: [443, 8443]`,
    `    QUIC:`,
    `      ports: [443, 8443]`,
    `  skip-domain:`,
    `    - "+.push.apple.com"`,
    `    - "+.apple.com"`,
    `    - "Mijia Cloud"`,
    ``,
    // DNS 防泄漏要点：
    //   respect-rules  代理域名的 DNS 查询跟随规则走代理出口，不在本地明文发出
    //   proxy-server-nameserver  解析节点域名，必须直连，否则与 respect-rules 循环依赖
    //   default-nameserver  仅用于解析上面那些 DoH 服务器自身的域名
    `dns:`,
    `  enable: true`,
    `  ipv6: true`,
    `  enhanced-mode: fake-ip`,
    `  fake-ip-range: 198.18.0.1/16`,
    `  fake-ip-filter:`,
    `    - "*.lan"`,
    `    - "*.local"`,
    `    - "*.localdomain"`,
    `    - "+.msftconnecttest.com"`,
    `    - "+.msftncsi.com"`,
    `    - localhost.ptlogin2.qq.com`,
    `    - "+.srv.nintendo.net"`,
    `    - "+.stun.playstation.net"`,
    `    - "+.xboxlive.com"`,
    `    - "time.*.com"`,
    `    - "ntp.*.com"`,
    `    - "+.pool.ntp.org"`,
    `  default-nameserver:`,
    `    - 223.5.5.5`,
    `    - 119.29.29.29`,
    `  proxy-server-nameserver:`,
    `    - https://223.5.5.5/dns-query`,
    `    - https://doh.pub/dns-query`,
    `  direct-nameserver:`,
    `    - https://223.5.5.5/dns-query`,
    `    - https://doh.pub/dns-query`,
    `  nameserver:`,
    `    - https://dns.cloudflare.com/dns-query`,
    `    - https://dns.google/dns-query`,
    `  respect-rules: true`,
    `  nameserver-policy:`,
    ...(SET.domain ? [`    "${SET.domain}": [223.5.5.5, 119.29.29.29]`] : []),
    `    "+.cn": [223.5.5.5, 119.29.29.29]`,
    ``,
    `proxies:`,
    pl,
    `proxy-groups:`,
    `  - name: "🚀 节点选择"`,
    `    type: select`,
    `    proxies: [${q([...allN, ...regionNames, 'DIRECT'])}]`,
    `  - name: "♻️ 自动选择"`,
    `    type: url-test`,
    `    proxies: [${q(allN)}]`,
    `    url: http://www.gstatic.com/generate_204`,
    `    interval: 300`,
    `    tolerance: 50`,
    polGroups,
    regionGroups,
    ``,
    `rules:`,
    `  - IP-CIDR,127.0.0.1/32,DIRECT,no-resolve`,
    `  - IP-CIDR,::1/128,DIRECT,no-resolve`,
    // 节点服务器 IP 必须直连：程序若直接用 IP 连接（SSH、节点探测）匹配不到下面的域名规则，
    // 会被 MATCH 兜底送进代理绕一圈回来，既慢又可能触发 Reality 握手失败。
    ...SET.directIPs.map(ip => `  - IP-CIDR,${ip}/32,DIRECT,no-resolve`),
    ...(SET.domain ? [`  - DOMAIN-SUFFIX,${SET.domain},DIRECT`] : []),
    ...SET.directDomains.map(d => `  - DOMAIN-SUFFIX,${d},DIRECT`),
    polRules,
    tail.join('\n')
  ].filter(x => x !== '').join('\n')
}

// Clash 节点 → sing-box outbound
function toSB(n) {
  const v = k => n.kv[k] === undefined ? undefined : unquote(n.kv[k])
  const tls = { enabled: true, insecure: v('skip-cert-verify') === 'true' }
  if (v('sni')) tls.server_name = v('sni')
  if (v('client-fingerprint')) tls.utls = { enabled: true, fingerprint: v('client-fingerprint') }

  const base = { tag: n.name, server: v('server'), server_port: parseInt(v('port'), 10) }
  const t = v('type')
  if (t === 'anytls') return { type: 'anytls', ...base, password: v('password'), tls }
  if (t === 'trojan') return { type: 'trojan', ...base, password: v('password'), tls }
  if (t === 'hysteria2') return { type: 'hysteria2', ...base, password: v('password'), tls }
  if (t === 'vmess') return { type: 'vmess', ...base, uuid: v('uuid'), security: v('cipher') || 'auto', alter_id: parseInt(v('alterId') || '0', 10) }
  if (t === 'ss') return { type: 'shadowsocks', ...base, method: v('cipher'), password: v('password') }
  return null
}

function genSB(up, policies, lib, own, st) {
  const SET = { ...DEFAULT_SETTINGS, ...(st || {}) }
  const upOut = up.map(toSB).filter(Boolean)
  const ownN = Object.values(own).map(n => n.name)
  const allN = [...ownN, ...upOut.map(o => o.tag)]
  const liveR = REGIONS.filter(r => up.some(n => n.region === r.key))
  const liveKeys = liveR.map(r => r.key)
  const regionNames = liveR.map(r => `${r.flag} ${r.cn}`)
  const act = (policies || []).filter(p => p.enabled !== false)

  // Clash 里的 DIRECT / REJECT 在 sing-box 中是具名 outbound
  const mapTag = t => t === 'DIRECT' ? 'direct-out' : t === 'REJECT' ? 'block-out' : t

  const outbounds = [
    { type: 'direct', tag: 'direct-out' },
    { type: 'block', tag: 'block-out' },
    ...Object.values(own).map(n => {
      if (n.type === 'vless') {
        if (n.net === 'tcp') {
          return { type: 'vless', tag: n.name, server: n.s, server_port: n.p, uuid: n.u, flow: n.flow, packet_encoding: 'xudp', tls: { enabled: true, server_name: n.sni, utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: n.pk, short_id: n.sid } }, transport: { type: 'tcp' } }
        }
        return { type: 'vless', tag: n.name, server: n.s, server_port: n.p, uuid: n.u, flow: '', packet_encoding: 'xudp', tls: { enabled: true, server_name: n.sni, utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: n.pk, short_id: n.sid } }, transport: { type: 'xhttp', path: '/', mode: 'auto' } }
      }
      return { type: 'hysteria2', tag: n.name, server: n.s, server_port: n.p, password: n.u, obfs: { type: n.obfs, password: n.opwd }, tls: { enabled: true, server_name: n.sni, insecure: true } }
    }),
    ...upOut
  ]

  // 地区 url-test 组
  liveR.forEach(r => outbounds.push({
    type: 'urltest', tag: `${r.flag} ${r.cn}`,
    outbounds: up.filter(n => n.region === r.key).map(n => n.name),
    url: 'http://www.gstatic.com/generate_204', interval: '5m'
  }))
  // 全局选择组
  outbounds.push({ type: 'selector', tag: '🚀 节点选择', outbounds: [...allN, ...regionNames, 'direct-out'] })

  // 策略组
  act.forEach(p => {
    const t = resolveTargets(p, liveKeys, own)
    outbounds.push({
      type: 'selector', tag: p.name,
      outbounds: policyMembers(p, t, allN, regionNames).map(mapTag)
    })
  })

  const direct = [...(SET.domain ? [SET.domain] : []), ...SET.directDomains]
  const rules = []
  if (direct.length) rules.push({ domain_suffix: direct, outbound: 'direct-out' })
  if (SET.directIPs.length) rules.push({ ip_cidr: SET.directIPs.map(x => x + '/32'), outbound: 'direct-out' })
  act.forEach(p => {
    const doms = policyDomains(p, lib)
    if (doms.length) rules.push({ domain_suffix: doms, outbound: p.name })
    if ((p.keywords || []).length) rules.push({ domain_keyword: p.keywords, outbound: p.name })
    if ((p.processes || []).length) rules.push({ process_name: p.processes, outbound: p.name })
  })
  rules.push({ geoip: ['cn'], outbound: 'direct-out' })

  return JSON.stringify({
    log: { level: 'warn' },
    // DNS 防泄漏：dns-remote 经代理出口查询；dns-resolver 仅直连解析节点域名，
    // 其余交给 fakeip，真实解析在代理节点侧完成。
    dns: {
      servers: [
        { tag: 'dns-remote', address: 'https://1.1.1.1/dns-query', address_resolver: 'dns-resolver', strategy: 'prefer_ipv4', detour: aiPrimary(own) },
        { tag: 'dns-direct', address: 'https://223.5.5.5/dns-query', address_resolver: 'dns-resolver', strategy: 'prefer_ipv4', detour: 'direct-out' },
        { tag: 'dns-resolver', address: '223.5.5.5', detour: 'direct-out' },
        { tag: 'dns-fake', address: 'fakeip' }
      ],
      rules: [
        { outbound: 'any', server: 'dns-resolver' },
        ...(SET.domain ? [{ domain_suffix: [SET.domain], server: 'dns-resolver' }] : []),
        { query_type: ['A','AAAA'], server: 'dns-fake' }
      ],
      final: 'dns-remote',
      independent_cache: true,
      fakeip: { enabled: true, inet4_range: '198.18.0.0/15' }
    },
    inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: 2080, sniff: true }],
    outbounds,
    route: { rules, final: '🚀 节点选择', auto_detect_interface: true }
  }, null, 2)
}

// ---------- 分享链接（v2rayN / 通用 base64 订阅）----------
// v2rayN 也能直接吃 Clash 订阅；这个格式是给它的 v2ray/Xray 内核以及其它只认
// base64 节点列表的客户端用的。分流规则不在此格式内，由客户端自行管理。
function b64utf8(s) {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  bytes.forEach(b => bin += String.fromCharCode(b))
  return btoa(bin)
}

// IPv6 字面量在 URL 里必须包方括号，否则冒号会和端口分隔符混淆，
// 机场的欧洲节点全是 IPv6，漏了这步客户端会整条导入失败。
function hostPart(h) {
  h = String(h)
  return (h.includes(':') && !h.startsWith('[')) ? `[${h}]` : h
}

function shareLink(n) {
  const tag = encodeURIComponent(n.name)
  if (n.own) {
    const o = n.o
    if (o.type === 'vless') {
      const qs = new URLSearchParams({
        encryption: 'none', security: 'reality', sni: o.sni, fp: 'chrome',
        pbk: o.pk, sid: o.sid, type: o.net === 'tcp' ? 'tcp' : 'xhttp'
      })
      if (o.flow) qs.set('flow', o.flow)
      return `vless://${o.u}@${hostPart(o.s)}:${o.p}?${qs}#${tag}`
    }
    const qs = new URLSearchParams({ sni: o.sni, insecure: '1' })
    if (o.obfs) { qs.set('obfs', o.obfs); qs.set('obfs-password', o.opwd) }
    if (o.ports) qs.set('mport', o.ports)
    return `hysteria2://${encodeURIComponent(o.u)}@${hostPart(o.s)}:${o.p}?${qs}#${tag}`
  }
  const v = k => n.kv[k] === undefined ? undefined : unquote(n.kv[k])
  const t = v('type'), host = v('server'), port = v('port'), pwd = v('password')
  const qs = new URLSearchParams()
  if (v('sni')) qs.set('sni', v('sni'))
  if (v('skip-cert-verify') === 'true') { qs.set('insecure', '1'); qs.set('allowInsecure', '1') }
  if (t === 'anytls')    return `anytls://${encodeURIComponent(pwd)}@${hostPart(host)}:${port}?${qs}#${tag}`
  if (t === 'trojan')    return `trojan://${encodeURIComponent(pwd)}@${hostPart(host)}:${port}?${qs}#${tag}`
  if (t === 'hysteria2') return `hysteria2://${encodeURIComponent(pwd)}@${hostPart(host)}:${port}?${qs}#${tag}`
  if (t === 'ss')        return `ss://${b64utf8(v('cipher') + ':' + pwd)}@${hostPart(host)}:${port}#${tag}`
  if (t === 'vmess') {
    return 'vmess://' + b64utf8(JSON.stringify({
      v: '2', ps: n.name, add: host, port: String(port), id: v('uuid'),
      aid: v('alterId') || '0', scy: v('cipher') || 'auto',
      net: v('network') || 'tcp', type: 'none', host: '', path: '', tls: ''
    }))
  }
  return null
}

function genShare(up, ownCfg) {
  const own = Object.values(ownCfg || {}).map(o => ({ name: o.name, own: true, o }))
  const links = [...own, ...up].map(shareLink).filter(Boolean)
  return b64utf8(links.join('\n'))
}

// ---------- 管理端页面 ----------

function adminHTML(authed, inited) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>订阅聚合</title>
<style>
:root{
  --bg:#faf9f7; --card:#fff; --bd:#e9e6e1; --bd2:#f1efeb;
  --tx:#1f1e1d; --tx2:#6f6b64; --tx3:#a8a29a;
  --acc:#c96442; --accH:#b5573a; --accBg:#fdf2ee; --accBd:#f0d8cc;
  --ok:#3d8f63; --warn:#b4432f; --warnBg:#fdf1ef; --warnBd:#f3d5cf;
  --hov:#f7f5f2; --sk:#f0ede9;
  --sh:0 1px 2px rgba(28,25,23,.04);
  --shM:0 16px 48px -12px rgba(28,25,23,.18),0 0 0 1px rgba(28,25,23,.05);
  --shT:0 8px 28px -8px rgba(28,25,23,.16),0 0 0 1px rgba(28,25,23,.06);
  --shP:0 10px 34px -10px rgba(28,25,23,.22),0 0 0 1px rgba(28,25,23,.07);
  --e:cubic-bezier(.16,1,.3,1);
}
@media(prefers-color-scheme:dark){
  :root{
    --bg:#1b1a18; --card:#232220; --bd:#34322e; --bd2:#2b2926;
    --tx:#efedea; --tx2:#a8a39b; --tx3:#78736c;
    --acc:#e08160; --accH:#eb9077; --accBg:#32241e; --accBd:#4b3227;
    --ok:#6cc08b; --warn:#e88b78; --warnBg:#32211e; --warnBd:#4a2c26;
    --hov:#2a2825; --sk:#2c2a27;
    --sh:0 1px 2px rgba(0,0,0,.2);
    --shM:0 16px 48px -12px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.06);
    --shT:0 8px 28px -8px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.07);
    --shP:0 10px 34px -10px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08);
  }
}
*{box-sizing:border-box;margin:0;padding:0}
::selection{background:var(--accBg);color:var(--acc)}
body{background:var(--bg);color:var(--tx);font:15px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased;padding:38px 24px 72px}
.wrap{max-width:860px;margin:0 auto}
.ic{width:15px;height:15px;flex-shrink:0;stroke-width:2;display:block}
.ic.s{width:13.5px;height:13.5px}

.top{display:flex;align-items:flex-start;gap:16px;margin-bottom:6px}
h1{font-size:21px;font-weight:600;letter-spacing:-.015em;line-height:1.3}
.lede{color:var(--tx2);font-size:13.5px;margin-top:6px}
.lede b{color:var(--tx);font-weight:500}
.top .sp{margin-left:auto;flex-shrink:0}

/* Tab */
.tabs{display:flex;gap:3px;margin-top:18px;border-bottom:1px solid var(--bd);padding-bottom:0}
.tab{background:none;border:none;color:var(--tx3);font-size:13.5px;font-weight:500;padding:8px 13px 10px;border-radius:0;position:relative;cursor:pointer;transition:color .16s var(--e)}
.tab:hover{color:var(--tx2);background:none}
.tab.on{color:var(--acc)}
.tab.on::after{content:'';position:absolute;left:11px;right:11px;bottom:-1px;height:2px;background:var(--acc);border-radius:2px 2px 0 0}
.tab:active{transform:none}

.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:19px 21px;margin-top:16px;box-shadow:var(--sh)}
.ttl{display:flex;align-items:center;gap:9px;font-size:13.5px;font-weight:600;margin-bottom:15px;letter-spacing:-.005em}
.ttl .sp{margin-left:auto}

button{font:inherit;font-size:13.5px;font-weight:500;cursor:pointer;white-space:nowrap;border-radius:9px;padding:8px 15px;border:1px solid transparent;background:var(--acc);color:#fff;display:inline-flex;align-items:center;gap:6px;transition:background .16s var(--e),transform .12s var(--e),color .16s,border-color .16s}
button:hover{background:var(--accH)}
button:active{transform:scale(.97)}
button:disabled{opacity:.5;cursor:default;transform:none}
button.g{background:var(--card);border-color:var(--bd);color:var(--tx2)}
button.g:hover{background:var(--hov);color:var(--tx);border-color:var(--tx3)}
button.sm{padding:6px 11px;font-size:12.5px}
button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.ib{width:29px;height:29px;padding:0;justify-content:center;border-radius:8px;background:transparent;border-color:transparent;color:var(--tx3)}
.ib:hover{background:var(--hov);color:var(--tx)}
.ib.dl:hover{background:var(--warnBg);color:var(--warn)}
.ib.on{color:var(--acc)}
.ib:active{transform:scale(.9)}

[data-tip]{position:relative}
[data-tip]::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%) translateY(3px);background:var(--tx);color:var(--bg);font-size:11.5px;font-weight:500;line-height:1;padding:5px 8px;border-radius:6px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .16s var(--e),transform .16s var(--e);z-index:20}
[data-tip]:hover::after{opacity:1;transform:translateX(-50%)}

input,textarea{font:inherit;font-size:13.5px;background:var(--card);color:var(--tx);border:1px solid var(--bd);border-radius:9px;padding:9px 12px;width:100%;outline:none;transition:border-color .16s var(--e),box-shadow .16s var(--e)}
textarea{resize:vertical;min-height:88px;line-height:1.7;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px}
input:hover,textarea:hover{border-color:var(--tx3)}
input:focus,textarea:focus{border-color:var(--acc);box-shadow:0 0 0 3.5px var(--accBg)}
input::placeholder,textarea::placeholder{color:var(--tx3)}
.row{display:flex;gap:9px;align-items:center}
.lb{font-size:12px;font-weight:600;color:var(--tx2);margin-bottom:6px;display:block}

/* 自定义下拉 */
.sel{position:relative}
.selb{width:100%;justify-content:space-between;background:var(--card);border-color:var(--bd);color:var(--tx);font-weight:400;padding:9px 12px}
.selb:hover{background:var(--card);border-color:var(--tx3);color:var(--tx)}
.selb .ic{color:var(--tx3);transition:transform .2s var(--e)}
.sel.open .selb{border-color:var(--acc);box-shadow:0 0 0 3.5px var(--accBg)}
.sel.open .selb .ic{transform:rotate(180deg)}
@keyframes popIn{from{opacity:0;transform:translateY(-5px) scale(.98)}to{opacity:1;transform:none}}
/* .anim 的入场动画含 opacity/transform，fill:both 会让每张卡片长期持有自己的层叠上下文，
   面板的 z-index 被困在卡片内部、被后面的兄弟卡片盖住。展开时给所在卡片加 .front 抬升。 */
.card.front{position:relative;z-index:40}
.selp{position:absolute;top:calc(100% + 5px);left:0;right:0;background:var(--card);border:1px solid var(--bd);border-radius:11px;box-shadow:var(--shP);padding:5px;z-index:30;max-height:250px;overflow:auto;animation:popIn .18s var(--e) both}
.selo{padding:8px 10px;border-radius:7px;font-size:13.5px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background .12s}
.selo:hover{background:var(--hov)}
.selo.on{color:var(--acc);font-weight:500}
/* 多选：左侧常驻复选框。只在选中时显示对勾的话，外观和单选毫无区别，
   用户根本看不出能多选。 */
.sel.multi .selo{position:relative;padding-left:11px}
.sel.multi .selo .ic{display:none}
.sel.multi .selo::before{content:'';flex-shrink:0;width:15px;height:15px;border-radius:4.5px;
  border:1.5px solid var(--bd);background:var(--card);transition:background .14s var(--e),border-color .14s var(--e)}
.sel.multi .selo::after{content:'';position:absolute;left:16px;top:50%;width:4px;height:8px;
  border:2px solid #fff;border-top:0;border-left:0;transform:translateY(-62%) rotate(45deg);
  opacity:0;transition:opacity .14s var(--e)}
.sel.multi .selo:hover::before{border-color:var(--tx3)}
.sel.multi .selo.on::before{background:var(--acc);border-color:var(--acc)}
.sel.multi .selo.on::after{opacity:1}
.sel.multi .selo.on{background:var(--accBg)}
.sel.multi .selp{padding-bottom:5px}
.lb .opt{font-weight:400;color:var(--tx3);margin-left:5px}
.selo .ic{opacity:0}
.selo.on .ic{opacity:1}

/* 多选 chips */
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid var(--bd);background:var(--card);color:var(--tx2);cursor:pointer;transition:all .14s var(--e);display:inline-flex;align-items:center;gap:5px}
.chip:hover{border-color:var(--tx3);color:var(--tx)}
.chip.on{background:var(--accBg);border-color:var(--accBd);color:var(--acc);font-weight:500}
.chip .n{opacity:.65;font-size:11px}

/* 策略行 */
.pol{display:flex;gap:11px;align-items:center;padding:11px 12px;border:1px solid var(--bd2);border-radius:11px;margin-bottom:7px;background:var(--card);transition:border-color .16s var(--e),background .16s var(--e),opacity .16s,box-shadow .16s var(--e)}
.pol:hover{border-color:var(--bd);background:var(--hov)}
/* 拖拽中：原行退成虚线空槽，作为落点指示。
   浏览器会另外渲染一张跟随鼠标的元素快照，原行若还留着淡淡的内容，
   两者叠在一起就是重影。用 opacity:0 抹掉内容但保留行高。 */
.pol.drag{background:var(--accBg);border:1.5px dashed var(--accBd);box-shadow:none}
.pol.drag > *{opacity:0}
.pol{cursor:default}
.pol[draggable="true"]{cursor:grabbing}
.pol.off{opacity:.5}
.grip{color:var(--tx3);cursor:grab;display:flex;padding:2px}
.grip:active{cursor:grabbing}
.pol .nm{font-weight:500;font-size:13.5px;min-width:110px}
.pol .meta{color:var(--tx3);font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arrow{color:var(--tx3);font-size:12px}
.tgt{font-size:12px;color:var(--tx2);background:var(--bg);border:1px solid var(--bd2);padding:2.5px 8px;border-radius:6px;white-space:nowrap}
.tgt.strict{background:var(--accBg);border-color:var(--accBd);color:var(--acc)}
.tgt.gone{background:var(--warnBg);border-color:var(--warnBd);color:var(--warn);text-decoration:line-through}
.tgts{display:flex;gap:4px;flex-wrap:wrap;min-width:0}

.sw{width:34px;height:20px;border-radius:11px;background:var(--bd);border:none;padding:0;position:relative;flex-shrink:0;transition:background .22s var(--e)}
.sw:hover{background:var(--tx3)}
.sw[data-on="1"]{background:var(--ok)}
.sw[data-on="1"]:hover{opacity:.85;background:var(--ok)}
.sw i{position:absolute;top:2.5px;left:2.5px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);transition:transform .22s var(--e)}
.sw[data-on="1"] i{transform:translateX(14px)}
.sw:active{transform:none}

.url{font:12.5px/1.6 ui-monospace,"SF Mono",Menlo,monospace;background:var(--bg);border:1px solid var(--bd2);border-radius:9px;padding:11px 13px;color:var(--tx2);word-break:break-all}
.tips{color:var(--tx3);font-size:12.5px;margin-top:11px;display:flex;flex-wrap:wrap;gap:5px 14px}
.tips span{display:inline-flex;align-items:center;gap:6px}
code{background:var(--bg);border:1px solid var(--bd2);border-radius:5px;padding:2px 6px;font:11.5px ui-monospace,monospace;color:var(--tx2)}

/* 列宽必须由父容器统一决定：每行各自 display:grid 时列宽只在行内计算，
   行与行之间不共享，于是名称长度一变，后面所有列就错开。
   subgrid 让每行沿用父容器的列轨道，多行才真正逐列对齐。 */
.uplist{display:grid;gap:7px}
.uplist.own{grid-template-columns:auto auto auto minmax(0,1fr) auto auto}
.uplist.src{grid-template-columns:auto auto minmax(0,1fr) auto auto auto auto auto}
.uplist.lib{grid-template-columns:auto minmax(0,1fr) auto auto}
.up{grid-column:1/-1;display:grid;grid-template-columns:subgrid;align-items:center;gap:11px;padding:10px 12px;border:1px solid var(--bd2);border-radius:10px;transition:border-color .16s var(--e),background .16s var(--e)}
.up:hover{border-color:var(--bd);background:var(--hov)}
.up .nm{font-weight:500;font-size:13.5px;white-space:nowrap}
.up .u{color:var(--tx3);font:11.5px ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.up.src .tgt{font-variant-numeric:tabular-nums;white-space:nowrap;justify-self:end}
.up.src .tgt.hot{background:var(--warnBg);border-color:var(--warnBd);color:var(--warn)}
.bar{height:4px;border-radius:2px;background:var(--bd2);overflow:hidden;width:46px;align-self:center}
.bar i{display:block;height:100%;background:var(--ok);border-radius:2px;transition:width .3s var(--e)}
.bar.hot i{background:var(--warn)}
.up.off .nm,.up.off .u{opacity:.45}
.dot{width:6px;height:6px;border-radius:50%;background:var(--ok);flex-shrink:0}
.up.off .dot{background:var(--tx3)}

.rg{margin-bottom:19px}.rg:last-child{margin-bottom:0}
.rgh{display:flex;align-items:center;gap:8px;padding:5px 6px 8px;margin:0 -6px 3px;border-bottom:1px solid var(--bd2);cursor:pointer;user-select:none;border-radius:7px 7px 0 0;transition:background .14s var(--e)}
.rgh:hover{background:var(--hov)}
.rgh .n{font-size:13px;font-weight:600}
.rgh .c{font-size:11.5px;color:var(--tx3);font-variant-numeric:tabular-nums}
.rgh .src{margin-left:auto;font-size:11.5px;color:var(--tx3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%}
.rgh .chev{color:var(--tx3);transition:transform .22s var(--e);flex-shrink:0}
.rg.coll .chev{transform:rotate(-90deg)}
/* grid-template-rows 0fr↔1fr 是目前最干净的高度折叠动画，不必预估内容高度 */
.rg .nds{display:grid;grid-template-rows:1fr;transition:grid-template-rows .26s var(--e),opacity .2s var(--e);opacity:1}
.rg .nds > .inner{overflow:hidden;min-height:0}
.rg.coll .nds{grid-template-rows:0fr;opacity:0}
.rgh .badge{font-size:10.5px;padding:1px 6px;border-radius:5px;background:var(--bg);border:1px solid var(--bd2);color:var(--tx3);font-weight:500}
.nd{display:flex;gap:11px;align-items:center;padding:6px 10px;margin:0 -10px;border-radius:8px;transition:background .14s var(--e)}
.nd:hover{background:var(--hov)}
.nd .nm{font-size:13.5px;font-weight:500;min-width:124px;display:flex;align-items:center}
.nd .raw{color:var(--tx3);font-size:12.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nd .act{display:flex;gap:2px;align-items:center;opacity:0;transform:translateX(4px);transition:opacity .16s var(--e),transform .16s var(--e)}
.nd:hover .act,.nd:focus-within .act{opacity:1;transform:none}
.nd.off .nm,.nd.off .raw{opacity:.4}
.nd.off .act{opacity:1;transform:none}
.tag{font-size:10.5px;padding:1.5px 6px;border-radius:5px;background:var(--accBg);color:var(--acc);border:1px solid var(--accBd);font-weight:500;margin-left:7px}
.edit{width:170px;padding:3px 8px!important;font-size:13.5px!important;border-radius:6px!important}

.alert{background:var(--warnBg);border:1px solid var(--warnBd);color:var(--warn);padding:10px 14px;border-radius:10px;font-size:13px;margin-top:14px;display:flex;gap:8px;align-items:center}
.empty{color:var(--tx3);font-size:13px;padding:4px 0}
.hint{color:var(--tx3);font-size:12px;margin-top:7px;line-height:1.65}

@keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.anim{animation:up .42s var(--e) both}
@keyframes sh{0%{background-position:-180% 0}100%{background-position:180% 0}}
.sk{background:linear-gradient(90deg,var(--sk) 20%,var(--hov) 50%,var(--sk) 80%);background-size:180% 100%;animation:sh 1.5s linear infinite;border-radius:6px}
.skrow{display:flex;gap:11px;align-items:center;padding:9px 0}
@keyframes spin{to{transform:rotate(360deg)}}

/* 退场必须用独立的 animation-name。
   若沿用入场同名动画只改 duration/direction，浏览器不会重启动画，
   animationend 永不触发，弹窗 DOM 会一直留着当全屏遮罩，页面看似卡死。 */
@keyframes bdIn{from{opacity:0}to{opacity:1}}
@keyframes bdOut{from{opacity:1}to{opacity:0}}
@keyframes mdIn{from{opacity:0;transform:scale(.965) translateY(8px)}to{opacity:1;transform:none}}
@keyframes mdOut{from{opacity:1;transform:none}to{opacity:0;transform:scale(.965) translateY(8px)}}
.bd{position:fixed;inset:0;background:rgba(28,25,23,.32);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px;z-index:50;animation:bdIn .2s var(--e) both}
.bd.out{animation:bdOut .16s var(--e) both}
.md{background:var(--card);border-radius:15px;box-shadow:var(--shM);width:100%;max-width:392px;max-height:86vh;
  display:flex;flex-direction:column;overflow:hidden;animation:mdIn .26s var(--e) both}
.md.lg{max-width:520px}
/* 头尾 flex-shrink:0 固定，中间 min-height:0 才能真正滚动（flex 子项默认 min-height:auto 会撑破容器） */
.md .hd{padding:21px 23px 14px;flex-shrink:0;border-bottom:1px solid transparent;transition:border-color .18s var(--e)}
.md .ct{padding:0 23px;overflow-y:auto;flex:1;min-height:0}
.md.sc .hd{border-bottom-color:var(--bd2)}
.md.scb .ft{border-top-color:var(--bd2)}
.bd.out .md{animation:mdOut .16s var(--e) both}
.md h3{font-size:15.5px;font-weight:600;letter-spacing:-.01em}
.md p{color:var(--tx2);font-size:13.5px;margin-top:7px;line-height:1.6}
.md .bdy{padding:15px 0;display:flex;flex-direction:column;gap:9px}
.md .ft{display:flex;gap:8px;justify-content:flex-end;padding:14px 23px 20px;flex-shrink:0;border-top:1px solid transparent;transition:border-color .18s var(--e)}
.fg{margin-bottom:14px}.fg:last-child{margin-bottom:0}

/* 顶部居中 toast，位移动画放在 .toast 自身避免两层 transform 打架 */
.toasts{position:fixed;top:20px;left:0;right:0;z-index:60;display:flex;flex-direction:column;gap:9px;align-items:center;pointer-events:none}
@keyframes tIn{from{opacity:0;transform:translateY(-18px) scale(.94)}to{opacity:1;transform:none}}
@keyframes tOut{from{opacity:1;transform:none;max-height:60px;margin-bottom:0}to{opacity:0;transform:translateY(-14px) scale(.94);max-height:0;margin-bottom:-9px}}
.toast{display:flex;align-items:center;gap:8px;pointer-events:auto;background:var(--card);border:1px solid var(--bd);box-shadow:var(--shT);color:var(--tx);font-size:13px;font-weight:500;padding:9px 14px 9px 12px;border-radius:11px;max-width:340px;animation:tIn .32s var(--e) both}
.toast.out{animation:tOut .26s var(--e) both}
.toast .ic{color:var(--ok)}
.toast.err .ic{color:var(--warn)}

.foot{text-align:center;margin-top:24px;color:var(--tx3);font-size:12.5px}
.login{max-width:348px;margin:13vh auto 0}
.login h2{font-size:17.5px;font-weight:600;letter-spacing:-.01em}
.login p{color:var(--tx2);font-size:13.5px;margin:6px 0 20px}
.msg{font-size:12.5px;margin-top:11px;min-height:18px;color:var(--warn)}
.gap{height:9px}
</style></head><body>

<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<g id="i-copy" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M4.5 15.5A2.5 2.5 0 0 1 3 13.2V5.5A2.5 2.5 0 0 1 5.5 3h7.7a2.5 2.5 0 0 1 2.3 1.5"/></g>
<g id="i-check" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></g>
<g id="i-warn" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5M12 16.5h.01"/></g>
<g id="i-trash" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6h17M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6M18.5 6v13a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6"/></g>
<g id="i-edit" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.6 2.6 0 0 1 3.7 3.7L7.5 19.9 2.5 21.5l1.6-5Z"/></g>
<g id="i-refresh" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.7 9.7 0 0 1 6.7 2.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.7 9.7 0 0 1-6.7-2.7L3 16"/><path d="M8 16H3v5"/></g>
<g id="i-plus" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></g>
<g id="i-out" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 21H5.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 16.5 4.5-4.5L16 7.5"/><path d="M20.5 12H9.5"/></g>
<g id="i-down" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></g>
<g id="i-grip" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="15" cy="18" r="1.3"/></g>
<g id="i-undo" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.1-9.4L3 7"/></g>
<g id="i-fold" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m4 8 8 8 8-8"/></g>
</defs></svg>

<div class="toasts" id="toasts"></div>
<div class="wrap" id="app"></div>

<script>
const authed = ${authed}, inited = ${inited}
const app = document.getElementById('app')
const tsBox = document.getElementById('toasts')
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const api = async (p, b) => (await fetch(p, b ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)} : {})).json()
const icon = (n, cls = '') => \`<svg class="ic \${cls}" viewBox="0 0 24 24" stroke-width="2"><use href="#i-\${n}"/></svg>\`
let TAB = 'node', ST = null, POL = null, OWN = null, PRF = null, PF = '', SET = null

function toast(msg, err){
  const dup = [...tsBox.children].find(e => e.dataset.msg === msg && !e.dataset.x)
  if (dup) { clearTimeout(+dup.dataset.t); dup.dataset.t = setTimeout(() => dup.kill(), 2600); return }
  const el = document.createElement('div')
  el.className = 'toast' + (err ? ' err' : ''); el.dataset.msg = msg
  el.innerHTML = icon(err ? 'warn' : 'check', 's') + '<span>' + esc(msg) + '</span>'
  tsBox.appendChild(el)
  el.kill = () => {
    if (el.dataset.x) return
    el.dataset.x = 1
    el.classList.add('out')
    el.addEventListener('animationend', () => el.remove(), { once: true })
    setTimeout(() => el.remove(), 500)   // 同上，动画不触发时的兜底
  }
  el.onclick = el.kill
  el.dataset.t = setTimeout(el.kill, 2600)
}

function modal({title, desc, html = '', fields = [], ok = '确定', danger = false, wide = false, onMount}){
  return new Promise(resolve => {
    const bd = document.createElement('div')
    bd.className = 'bd'
    bd.innerHTML = \`<div class="md \${wide?'lg':''}" role="dialog" aria-modal="true">
      <div class="hd"><h3>\${esc(title)}</h3>\${desc ? \`<p>\${esc(desc)}</p>\` : ''}</div>
      <div class="ct">
        \${html ? \`<div class="bdy">\${html}</div>\` : ''}
        \${fields.length ? \`<div class="bdy">\${fields.map((f,i)=>\`<input data-i="\${i}" placeholder="\${esc(f.ph||'')}" value="\${esc(f.val||'')}">\`).join('')}</div>\` : ''}
      </div>
      <div class="ft"><button class="g" data-x>取消</button>
        <button data-ok \${danger?'style="background:var(--warn)"':''}>\${esc(ok)}</button></div>
    </div>\`
    document.body.appendChild(bd)
    const box = bd.querySelector('.md')
    const inputs = [...bd.querySelectorAll('.bdy input[data-i]')]
    setTimeout(() => (inputs[0] || bd.querySelector('[data-ok]')).focus(), 60)
    if (inputs[0]) inputs[0].select()
    if (onMount) onMount(box)
    // 内容可滚动时才给头尾描边，避免短内容也画两条线
    const ct = box.querySelector('.ct')
    const shade = () => {
      box.classList.toggle('sc', ct.scrollTop > 2)
      box.classList.toggle('scb', ct.scrollTop + ct.clientHeight < ct.scrollHeight - 2)
    }
    ct.addEventListener('scroll', shade)
    requestAnimationFrame(shade)
    // 双保险：animationend 正常时立即清理；若动画被系统「减少动态效果」禁用
    // 或因任何原因不触发，400ms 后强制移除，绝不让遮罩留在页面上。
    const close = v => {
      const done = () => { bd.remove(); document.removeEventListener('keydown', onKey) }
      bd.classList.add('out')
      bd.addEventListener('animationend', done, { once: true })
      setTimeout(done, 400)
      resolve(v)
    }
    const submit = () => close(html ? box : (fields.length ? inputs.map(i => i.value.trim()) : true))
    const onKey = e => {
      if (e.key === 'Escape') { if (bd.querySelector('.sel.open')) return; close(null) }
      if (e.key === 'Enter' && !html && document.body.contains(bd)) submit()
    }
    document.addEventListener('keydown', onKey)
    bd.querySelector('[data-x]').onclick = () => close(null)
    bd.querySelector('[data-ok]').onclick = submit
    bd.onclick = e => { if (e.target === bd) close(null) }
  })
}

/* 自定义下拉，替代原生 select。multi=true 时可多选，面板不自动收起。 */
function selectHTML(id, opts, val, multi){
  const picked = multi ? (Array.isArray(val) ? val : [val]).filter(Boolean) : [val]
  const has = v => picked.includes(v)
  const first = opts.find(o => has(o.v)) || opts[0]
  return \`<div class="sel \${multi?'multi':''}" id="\${id}" data-v="\${esc(multi ? picked.join('|') : (first||{}).v || '')}">
    <button type="button" class="g selb">\${esc(selLabel(opts, picked, multi))}\${icon('down','s')}</button>
    <div class="selp" hidden>\${opts.map(o =>
      \`<div class="selo \${has(o.v)?'on':''}" data-v="\${esc(o.v)}">\${icon('check','s')}<span>\${esc(o.label)}</span></div>\`).join('')}</div>
  </div>\`
}
function selLabel(opts, picked, multi){
  const names = picked.map(v => (opts.find(o => o.v === v) || {}).label).filter(Boolean)
  if (!names.length) return multi ? '未选择' : (opts[0] || {}).label || ''
  if (!multi) return names[0]
  if (names.length === 1) return names[0] + '（已选 1 项）'
  return names.length === 2 ? names.join('、') : \`\${names[0]} 等 \${names.length} 项\`
}
// 读取当前值：单选得字符串，多选得数组
function selValue(sel){
  if (!sel.classList.contains('multi')) return sel.dataset.v
  return [...sel.querySelectorAll('.selo.on')].map(o => o.dataset.v)
}
function bindSelect(root){
  root.querySelectorAll('.sel').forEach(sel => {
    const btn = sel.querySelector('.selb'), pop = sel.querySelector('.selp')
    const multi = sel.classList.contains('multi')
    const opts = [...pop.querySelectorAll('.selo')].map(o => ({ v: o.dataset.v, label: o.querySelector('span').textContent }))
    const repaint = () => {
      const picked = [...pop.querySelectorAll('.selo.on')].map(o => o.dataset.v)
      sel.dataset.v = multi ? picked.join('|') : (picked[0] || '')
      btn.innerHTML = esc(selLabel(opts, picked, multi)) + icon('down','s')
    }
    btn.onclick = e => {
      e.stopPropagation()
      const open = sel.classList.contains('open')
      closeAllSel()
      if (!open) {
        sel.classList.add('open'); pop.hidden = false
        sel.closest('.card')?.classList.add('front')
      }
    }
    pop.querySelectorAll('.selo').forEach(o => {
      o.onclick = e => {
        e.stopPropagation()
        if (multi) {
          o.classList.toggle('on')
          // 一个都不选没有意义，至少留一个
          if (!pop.querySelector('.selo.on')) o.classList.add('on')
          repaint()
          return          // 多选时保持展开，方便连续勾选
        }
        pop.querySelectorAll('.selo').forEach(x => x.classList.toggle('on', x === o))
        repaint()
        closeAllSel()
      }
    })
  })
}
function closeAllSel(){
  document.querySelectorAll('.sel.open').forEach(s => {
    s.classList.remove('open')
    s.querySelector('.selp').hidden = true
    s.closest('.card')?.classList.remove('front')
  })
}
document.addEventListener('click', closeAllSel)

// 顶栏常驻。整页 innerHTML 重建会让它的入场动画每次重播，表现为切 tab 时上方闪一下。
// 这里首次渲染后只做增量更新：改统计文案、切 tab 高亮。
function ledeHTML(){
  const total = ST.regions.reduce((a, r) => a + r.nodes.length, 0)
  const when = new Date(ST.at).toLocaleString('zh-CN', {hour12:false, month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'})
  return \`<b>\${ST.upstreams.length}</b> 个订阅源 · <b>\${total}</b> 个节点 · \${when} 更新\${ST.stale ? ' · <span style="color:var(--warn)">上游异常，显示缓存</span>' : ''}\`
}
const TABS = [['node','节点'],['sub','订阅'],['pol','分流策略'],['lib','域名库']]
function paintHeader(){
  let hdr = document.getElementById('hdr')
  if (!hdr) {
    app.innerHTML = \`<div id="hdr" class="anim">
      <div class="top"><div><h1>订阅聚合</h1><div class="lede">\${ledeHTML()}</div></div>
        <span class="sp"><button class="ib" data-tip="退出登录" onclick="logout()">\${icon('out')}</button></span></div>
      <div class="tabs">\${TABS.map(([k,n]) =>
        \`<button class="tab \${TAB===k?'on':''}" data-t="\${k}" onclick="go('\${k}')">\${n}</button>\`).join('')}</div>
    </div><div id="body"></div>\`
    return
  }
  hdr.querySelector('.lede').innerHTML = ledeHTML()
  hdr.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.t === TAB))
}

function skeleton(){
  const bar = (w, h = 13) => \`<div class="sk" style="width:\${w};height:\${h}px"></div>\`
  const cards = [0,1,2].map(i =>
    \`<div class="card anim" style="animation-delay:\${i*.05}s"><div style="margin-bottom:15px">\${bar('76px')}</div>
      \${[0,1,2].map(()=>\`<div class="skrow">\${bar('118px')}\${bar('44%',12)}</div>\`).join('')}</div>\`).join('')
  // 顶栏已经在了就只换内容区，否则增删订阅源后顶栏会跟着闪一下
  const body = document.getElementById('body')
  if (body) { body.innerHTML = cards; return }
  app.innerHTML = \`<div class="top"><div style="flex:1">\${bar('132px',21)}<div style="height:9px"></div>\${bar('268px',12)}</div></div>\${cards}\`
}

function login(){
  app.innerHTML = \`<div class="login anim"><div class="card" style="margin:0">
    <h2>\${inited ? '订阅聚合' : '初始化'}</h2>
    <p>\${inited ? '输入管理密码继续' : '首次使用，用订阅 token 验证身份并设置密码'}</p>
    \${inited ? '' : '<input id="tk" placeholder="订阅 token"><div class="gap"></div>'}
    <input id="pw" type="password" placeholder="\${inited ? '管理密码' : '设置密码（至少 8 位）'}">
    <div class="gap"></div>
    <button style="width:100%;justify-content:center" onclick="doLogin()">\${inited ? '登录' : '设置并登录'}</button>
    <div id="msg" class="msg"></div></div></div>\`
  document.getElementById('pw').focus()
  app.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() }))
}
window.doLogin = async () => {
  const tk = document.getElementById('tk'), btn = app.querySelector('button')
  btn.disabled = true; btn.textContent = '验证中'
  const r = await api('/admin/login', { password: document.getElementById('pw').value, initToken: tk ? tk.value.trim() : undefined })
  if (r.ok) return location.reload()
  btn.disabled = false; btn.textContent = inited ? '登录' : '设置并登录'
  document.getElementById('msg').textContent = r.msg || '失败'
}

async function dash(skip){
  if (!skip) skeleton()
  // 每个 tab 只拉自己要的，且并行发出——串行等两个请求是之前切 tab 卡顿的主因之一
  const jobs = []
  if (!ST) jobs.push(api('/api/state').then(r => { ST = r }))
  if (TAB === 'node' && !OWN) jobs.push(api('/api/own').then(r => { OWN = r }))
  if (TAB === 'node' && !SET) jobs.push(api('/api/settings').then(r => { SET = r }))
  if (TAB === 'sub' && !PRF) jobs.push(api('/api/profiles').then(r => { PRF = r }))
  if ((TAB === 'pol' || TAB === 'lib') && !POL) jobs.push(api('/api/policies?pf=' + encodeURIComponent(PF)).then(r => { POL = r }))
  if (jobs.length) await Promise.all(jobs)
  if (!ST || !ST.ok) { app.innerHTML = \`<div class="alert">\${icon('warn','s')}\${esc((ST&&ST.msg)||'加载失败')}</div>\`; return }

  paintHeader()
  document.getElementById('body').innerHTML =
    TAB === 'node' ? viewNode() : TAB === 'sub' ? viewSub() : TAB === 'pol' ? viewPol() : viewLib()
  if (TAB === 'pol') {
    bindDrag()
    const sel = document.getElementById('pfsel')
    if (sel) {
      bindSelect(document)
      sel.querySelectorAll('.selo').forEach(o => o.addEventListener('click', () => {
        if (o.dataset.v === PF) return
        PF = o.dataset.v; POL = null; dash(true)
      }))
    }
  }
}
// 切 tab 若需要拉数据，先把内容区换成骨架，避免点了没反应像卡死
function tabSkeleton(){
  const body = document.getElementById('body')
  if (!body) return
  const bar = (w, h = 13) => \`<div class="sk" style="width:\${w};height:\${h}px"></div>\`
  body.innerHTML = ([0,1].map(i =>
    \`<div class="card anim" style="animation-delay:\${i*.05}s">
      <div style="margin-bottom:15px">\${bar('76px')}</div>
      \${[0,1,2].map(()=>\`<div class="skrow">\${bar('118px')}\${bar('44%',12)}</div>\`).join('')}
    </div>\`).join(''))
}
window.go = t => {
  if (t === TAB) return
  TAB = t
  const need = (t === 'node' && (!OWN || !SET)) || (t === 'sub' && !PRF) || ((t === 'pol' || t === 'lib') && !POL)
  // tab 高亮立即切过去，让点击有即时反馈
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.t === t))
  if (need) tabSkeleton()
  // 从长页面切到短页面时，不重置会停在一片空白上
  if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' })
  dash(true)
}

function viewNode(){
  const st = (SET && SET.settings) || { domain:'', directDomains:[], directIPs:[] }
  // 订阅地址统一在「订阅」页展示，这里不再重复一份
  let h = \`<div class="card anim" style="animation-delay:0s">
    <div class="ttl">站点设置<span class="sp"></span>
      <button class="g sm" onclick="editSettings()">\${icon('edit','s')}编辑</button></div>
    <div class="uplist" style="grid-template-columns:auto minmax(0,1fr)">
      <div class="up"><span class="nm">本站域名</span>
        <span class="u">\${st.domain ? esc(st.domain) : '<span style="color:var(--warn)">未设置 — 影响 DNS 策略与自身直连规则</span>'}</span></div>
      <div class="up"><span class="nm">直连域名</span>
        <span class="u">\${st.directDomains.length ? esc(st.directDomains.join('、')) : '（无）'}</span></div>
      <div class="up"><span class="nm">直连 IP</span>
        <span class="u">\${st.directIPs.length ? esc(st.directIPs.join('、')) : '（无）'}</span></div>
    </div>
  </div>\`
  const ow = (OWN && OWN.own) || {}
  h += \`<div class="card anim" style="animation-delay:.06s">
    <div class="ttl">自有节点<span class="sp"></span>
      <button class="g sm" onclick="resetOwn()">\${icon('undo','s')}恢复默认</button>
      <button class="sm" onclick="editOwn(null)">\${icon('plus','s')}添加</button></div>
    <div class="hint" style="margin:-6px 0 12px">自建节点，与机场订阅无关。分流策略可直接指向它们。</div>\`
  h += '<div class="uplist own">'
  h += Object.entries(ow).map(([k,n]) => \`<div class="up own">
      <span class="dot"></span>
      <span class="nm">\${esc(n.name)}</span>
      <span class="tgt">\${n.type === 'vless' ? 'VLESS Reality' : 'Hysteria2'}</span>
      <span class="u">\${esc(n.s)}:\${esc(String(n.p))}\${n.ports ? ' · ' + esc(n.ports) : ''}</span>
      <button class="ib" data-tip="编辑" onclick="editOwn('\${esc(k)}')">\${icon('edit')}</button>
      <button class="ib dl" data-tip="删除" onclick="delOwn('\${esc(k)}','\${esc(n.name)}')">\${icon('trash')}</button>
    </div>\`).join('') || '<div class="empty">还没有自有节点</div>'
  h += '</div></div>'

  h += \`<div class="card anim" style="animation-delay:.06s"><div class="ttl">订阅源<span class="sp"></span>
    <button class="sm" onclick="addUp()">\${icon('plus','s')}添加</button></div>\`
  h += '<div class="uplist src">'
  h += ST.upstreams.map(u => \`<div class="up src \${u.enabled===false?'off':''}">
      <span class="dot"></span><span class="nm">\${esc(u.name)}</span><span class="u">\${esc(u.url)}</span>
      \${upMeta((ST.meta || {})[u.id])}
      <button class="sw" data-on="\${u.enabled===false?0:1}" data-tip="\${u.enabled===false?'启用':'停用'}" onclick="upAct('toggle','\${u.id}',this)"><i></i></button>
      <button class="ib dl" data-tip="删除" onclick="delUp('\${u.id}','\${esc(u.name)}')">\${icon('trash')}</button>
    </div>\`).join('') || '<div class="empty">还没有订阅源</div>'
  h += '</div></div>'
  h += \`<div class="card anim" style="animation-delay:.10s"><div class="ttl">节点<span class="sp"></span>
    <button class="g sm" onclick="foldAll(true)">展开全部</button>
    <button class="g sm" onclick="foldAll(false)">收起全部</button>
    <button class="ib" data-tip="重新拉取" onclick="refresh(this)">\${icon('refresh')}</button></div>\`
  for (const r of ST.regions) {
    const src = (ST.bySrc || {})[r.key] || {}
    const srcTxt = Object.entries(src).map(([n, c]) => esc(n) + ' ' + c).join(' · ')
    h += \`<div class="rg \${COLL.has(r.key)?'coll':''}" data-k="\${r.key}">
      <div class="rgh" onclick="toggleRg('\${r.key}',this)">
        \${icon('fold','s chev')}
        <span class="n">\${r.flag} \${r.cn}</span><span class="c">\${r.nodes.length}</span>
        <span class="src">\${srcTxt}</span>
      </div>
      <div class="nds"><div class="inner">\`
    h += r.nodes.map(n => \`<div class="nd \${n.off?'off':''}" data-k="\${esc(n.key)}">
      <span class="nm">\${esc(n.name)}\${n.custom?'<span class="tag">自定义</span>':''}</span>
      <span class="raw">\${esc(n.upName)} · \${esc(n.raw)}</span>
      <span class="act" onclick="event.stopPropagation()"><button class="ib" data-tip="重命名" onclick="rename(this)">\${icon('edit')}</button>
      <button class="sw" data-on="\${n.off?0:1}" data-tip="\${n.off?'启用':'停用'}" onclick="toggle('\${esc(n.key)}',\${!n.off},this)"><i></i></button></span>
    </div>\`).join('')
    h += '</div></div></div>'
  }
  if (!ST.regions.length) h += '<div class="empty">暂无节点，先添加订阅源</div>'
  return h + '</div><div class="foot anim" style="animation-delay:.14s">节点每小时自动刷新，上游故障时沿用缓存</div>'
}

/* 带「全部」语义的多选：'all' 与具体白名单二选一 */
function chipsHTML(id, opts, val, word){
  const all = val === 'all'
  return \`<div class="chips" id="\${id}" data-word="\${esc(word||'项')}">
    <span class="chip \${all?'on':''}" data-v="__all">全部</span>
    \${opts.map(o => \`<span class="chip \${!all && Array.isArray(val) && val.includes(o.v) ? 'on':''}" data-v="\${esc(o.v)}">\${esc(o.label)}</span>\`).join('')
      || '<span class="hint" style="margin:0;align-self:center">（暂无可选项）</span>'}
  </div>
  <div class="hint chipst" data-for="\${id}" style="margin-top:6px"></div>\`
}
// 三态：全部 / 指定几个 / 一个都不选。
// 「都不选」是合法状态——比如给别人的订阅就不该包含自建节点，
// 所以不能像早先那样在清空时自动跳回「全部」。
function paintChips(box){
  const t = box.parentNode.querySelector('.chipst[data-for="' + box.id + '"]')
  if (!t) return
  const word = box.dataset.word || '项'
  const allc = box.querySelector('.chip[data-v="__all"]')
  const picked = [...box.querySelectorAll('.chip.on')].filter(c => c !== allc)
  if (allc && allc.classList.contains('on')) t.innerHTML = '包含全部' + word
  else if (picked.length) t.innerHTML = '仅包含选中的 <b>' + picked.length + '</b> 个' + word
  else t.innerHTML = '<b style="color:var(--warn)">不包含任何' + word + '</b>'
}
function bindChips(root){
  root.querySelectorAll('.chips').forEach(box => {
    const allc = box.querySelector('.chip[data-v="__all"]')
    if (!allc) return
    box.querySelectorAll('.chip').forEach(c => c.onclick = () => {
      if (c === allc) {
        // 再点一次「全部」即清空，得到「都不选」
        const wasAll = allc.classList.contains('on')
        box.querySelectorAll('.chip').forEach(x => x.classList.remove('on'))
        if (!wasAll) allc.classList.add('on')
      } else {
        allc.classList.remove('on')
        c.classList.toggle('on')
      }
      paintChips(box)
    })
    paintChips(box)
  })
}
function chipsValue(box){
  const allc = box.querySelector('.chip[data-v="__all"]')
  if (!allc || allc.classList.contains('on')) return 'all'
  return [...box.querySelectorAll('.chip.on')].map(c => c.dataset.v).filter(v => v !== '__all')
}
function sumOf(v, opts, word){
  if (v === 'all') return '全部' + word
  if (!Array.isArray(v) || !v.length) return '无' + word
  const names = v.map(x => (opts.find(o => o.v === x) || {}).label || x)
  return names.length <= 2 ? names.join(' · ') : names.slice(0,2).join(' · ') + \` 等 \${names.length} 项\`
}

function viewSub(){
  const ps = PRF.profiles || [], o = PRF.opts || {own:[],ups:[],regions:[],pols:[]}
  let h = \`<div class="card anim" style="animation-delay:.04s">
    <div class="ttl">订阅<span class="sp"></span>
      <button class="g sm" onclick="resetProf()">\${icon('undo','s')}恢复默认</button>
      <button class="sm" onclick="editProf(null)">\${icon('plus','s')}新建</button></div>
    <div class="hint" style="margin:-6px 0 11px">每份订阅一个独立 token，可分别挑选包含哪些节点、机场、地区和策略。给不同设备或不同人用不同订阅，互不影响。</div>
    <div class="tips" style="margin:0 0 15px">
      <span><code>&mode=blacklist</code> 黑名单</span>
      <span><code>&fmt=singbox</code> sing-box</span>
      <span><code>&fmt=share</code> v2rayN / base64</span>
      <span><code>&upstream=0</code> 仅自有节点</span>
    </div>
    <div class="hint" style="margin:-8px 0 13px">Clash Verge · Stash · Shadowrocket · v2rayN 直接用地址即可；sing-box 与只认 base64 节点列表的客户端加对应参数。</div>\`
  h += ps.map((x, i) => \`<div class="pol \${x.enabled===false?'off':''}" style="align-items:flex-start;padding:13px 14px">
      <div style="flex:1;min-width:0">
        <div class="row" style="gap:8px">
          <span class="nm" style="min-width:0">\${esc(x.name)}</span>
          <span class="tgt">\${x.mode==='blacklist'?'黑名单':'白名单'}</span>
          \${x.note ? \`<span class="hint" style="margin:0">\${esc(x.note)}</span>\` : ''}
        </div>
        <div class="url" style="margin:8px 0 7px;padding:8px 10px;font-size:11.5px" id="su\${i}">https://\${location.host}/sub?token=\${esc(x.token)}</div>
        <div class="hint" style="margin:0">\${sumOf(x.own,o.own,'自有节点')} · \${sumOf(x.ups,o.ups,'机场')} · \${sumOf(x.regions,o.regions,'地区')} · \${Array.isArray(x.policies) ? \`<b style="color:var(--acc)">专属策略 \${x.policies.length} 条</b>\` : sumOf(x.pols,o.pols,'策略') + '（继承）'}</div>
      </div>
      <div class="row" style="gap:2px;flex-shrink:0">
        <button class="ib" data-tip="复制地址" onclick="copySub(\${i},this)">\${icon('copy')}</button>
        <button class="sw" data-on="\${x.enabled===false?0:1}" data-tip="\${x.enabled===false?'启用':'停用'}" onclick="toggleProf(\${i},this)"><i></i></button>
        <button class="ib" data-tip="编辑" onclick="editProf(\${i})">\${icon('edit')}</button>
        <button class="ib dl" data-tip="删除" onclick="delProf(\${i})">\${icon('trash')}</button>
      </div>
    </div>\`).join('') || '<div class="empty">还没有订阅</div>'
  return h + '</div>'
}

window.copySub = async (i, b) => {
  try { await navigator.clipboard.writeText(document.getElementById('su'+i).textContent) }
  catch { return toast('复制失败，请手动选取', true) }
  b.innerHTML = icon('check'); b.classList.add('on')
  toast('订阅地址已复制')
  setTimeout(() => { b.innerHTML = icon('copy'); b.classList.remove('on') }, 1500)
}

async function saveProf(msg){
  const r = await api('/api/profiles', { profiles: PRF.profiles })
  if (!r.ok) { toast(r.msg || '保存失败', true); PRF = await api('/api/profiles'); dash(true); return false }
  PRF.profiles = r.profiles
  if (msg) toast(msg)
  ST = null   // 订阅地址展示依赖首个启用档案
  dash(true)
  return true
}
window.toggleProf = async (i, el) => {
  const x = PRF.profiles[i]
  x.enabled = x.enabled === false
  if (el) {
    const row = el.closest('.pol')
    if (row) row.classList.toggle('off', !x.enabled)
    el.dataset.on = x.enabled ? 1 : 0
    el.dataset.tip = x.enabled ? '停用' : '启用'
  }
  const r = await api('/api/profiles', { profiles: PRF.profiles })
  if (!r.ok) { toast(r.msg || '保存失败', true); PRF = null; dash(true); return }
  PRF.profiles = r.profiles; ST = null
}
window.delProf = async i => {
  const x = PRF.profiles[i]
  if (!await modal({title:'删除订阅', desc:\`「\${x.name}」删除后，正在使用该地址的客户端会立刻拉不到配置。\`, ok:'删除', danger:true})) return
  PRF.profiles.splice(i,1); await saveProf('已删除')
}
window.resetProf = async () => {
  if (!await modal({title:'恢复默认订阅', desc:'所有订阅配置将被覆盖为单条默认订阅，其它 token 立即失效。', ok:'恢复', danger:true})) return
  const r = await api('/api/profiles', { act:'reset' })
  if (r.ok) { PRF = await api('/api/profiles'); ST = null; toast('已恢复默认'); dash(true) }
}

window.editProf = async (i) => {
  const isNew = i === null
  const o = PRF.opts || {own:[],ups:[],regions:[],pols:[]}
  const x = isNew
    ? { name:'', token: PRF.newToken || '', enabled:true, own:'all', ups:'all', regions:'all', pols:'all', mode:'whitelist', note:'' }
    : JSON.parse(JSON.stringify(PRF.profiles[i]))
  const html = \`
    <div class="fg"><label class="lb">订阅名称</label><input id="sn" value="\${esc(x.name)}" placeholder="如 手机 / 家人"></div>
    <div class="fg"><label class="lb">访问 token</label>
      <div class="row"><input id="stk" value="\${esc(x.token)}" placeholder="16-64 位字母数字">
        <button type="button" class="g sm" id="sgen">重新生成</button></div>
      <div class="hint">这是这份订阅的唯一凭据，改了之后旧地址立即失效。</div></div>
    <div class="fg"><label class="lb">默认模式</label>
      \${selectHTML('smd', [{v:'whitelist',label:'白名单（未命中走代理）'},{v:'blacklist',label:'黑名单（未命中直连）'}], x.mode)}</div>
    <div class="fg"><label class="lb">自有节点</label>\${chipsHTML('so', o.own, x.own, '自有节点')}</div>
    <div class="fg"><label class="lb">机场源</label>\${chipsHTML('su', o.ups, x.ups, '机场源')}</div>
    <div class="fg"><label class="lb">地区</label>\${chipsHTML('sr', o.regions, x.regions, '地区')}</div>
    <div class="fg"><label class="lb">分流策略</label>
      <div class="hint" style="margin:0 0 7px">\${Array.isArray(x.policies)
        ? '该订阅使用<b style="color:var(--acc)">专属策略</b>，到「分流策略」页选中它即可单独编辑。'
        : '该订阅<b>继承全局策略</b>，可在下方勾选只启用其中一部分；要完全独立配置，请到「分流策略」页选中它并改为专属。'}</div>
      \${Array.isArray(x.policies) ? '' : chipsHTML('sp', o.pols, x.pols, '策略')}</div>
    <div class="fg"><label class="lb">备注</label><input id="snt" value="\${esc(x.note||'')}" placeholder="可留空"></div>\`

  const box = await modal({ title: isNew ? '新建订阅' : '编辑订阅', html, ok:'保存', wide:true, onMount: b => {
    bindSelect(b); bindChips(b)
    b.querySelector('#sgen').onclick = () => {
      // 用 Web Crypto 生成，避免 Math.random 的可预测性
      const a = new Uint8Array(16); crypto.getRandomValues(a)
      b.querySelector('#stk').value = [...a].map(v => v.toString(16).padStart(2,'0')).join('')
    }
  }})
  if (!box) return

  const np = {
    id: x.id || 'f' + Date.now().toString(36),
    name: box.querySelector('#sn').value.trim(),
    token: box.querySelector('#stk').value.trim(),
    enabled: x.enabled !== false,
    mode: selValue(box.querySelector('#smd')),
    own: chipsValue(box.querySelector('#so')), ups: chipsValue(box.querySelector('#su')),
    regions: chipsValue(box.querySelector('#sr')),
    pols: box.querySelector('#sp') ? chipsValue(box.querySelector('#sp')) : (x.pols || 'all'),
    policies: Array.isArray(x.policies) ? x.policies : 'inherit',
    note: box.querySelector('#snt').value.trim()
  }
  if (!np.name) return toast('订阅名称不能为空', true)
  if (isNew) PRF.profiles.push(np); else PRF.profiles[i] = np
  await saveProf(isNew ? '已新建订阅' : '已保存')
}

/* 地区折叠状态存本地，刷新后保留；节点多时默认收起，避免一屏拉不到底 */
const COLL = new Set((() => { try { return JSON.parse(localStorage.getItem('rgcoll') || '[]') } catch { return [] } })())
function saveColl(){ try { localStorage.setItem('rgcoll', JSON.stringify([...COLL])) } catch {} }
window.toggleRg = (k, el) => {
  COLL.has(k) ? COLL.delete(k) : COLL.add(k)
  saveColl()
  el.closest('.rg').classList.toggle('coll', COLL.has(k))
}
window.foldAll = (open) => {
  const rgs = document.querySelectorAll('#body .rg')
  COLL.clear()
  if (!open) rgs.forEach(r => COLL.add(r.dataset.k))
  saveColl()
  rgs.forEach(r => r.classList.toggle('coll', !open))
}

const GB = 1073741824
function fmtSize(b){
  if (!b) return '0'
  if (b >= 1099511627776) return (b / 1099511627776).toFixed(2) + ' TB'
  return (b / GB).toFixed(b >= 100 * GB ? 0 : 1) + ' GB'
}
// 机场的流量与到期。返回三个平级元素（进度条 / 流量 / 到期），
// 缺项用空 span 占位——列数恒定，各行才能逐列对齐。
function upMeta(m){
  const blank = '<span></span>'
  if (!m) return blank + blank + blank
  let bar = blank, traffic = blank, exp = blank
  if (m.total > 0) {
    const left = Math.max(0, m.total - m.up - m.down)
    const pct = Math.round(left / m.total * 100)
    const hot = pct <= 15
    bar = \`<span class="bar \${hot?'hot':''}" title="剩余 \${pct}%"><i style="width:\${pct}%"></i></span>\`
    traffic = \`<span class="tgt \${hot?'hot':''}" title="剩余 / 总量">\${fmtSize(left)} / \${fmtSize(m.total)}</span>\`
  }
  if (m.expire > 0) {
    const days = Math.ceil((m.expire * 1000 - Date.now()) / 86400000)
    const d = new Date(m.expire * 1000)
    exp = \`<span class="tgt \${days <= 7 ? 'hot' : ''}" title="\${d.toLocaleDateString('zh-CN')}">\${days < 0 ? '已过期' : days + ' 天后到期'}</span>\`
  }
  return bar + traffic + exp
}

function tgtLabel(v){
  const t = (POL.targets || []).find(x => x.v === v)
  return t ? t.label : v
}

function viewPol(){
  const ps = POL.policies || []
  const pfs = POL.profiles || []
  // 目标失效时 resolveTarget 会静默回退到「节点选择」，出口可能悄悄变成别的地区。
  // 这种降级比直接报错更难察觉，必须在界面上点出来。
  const known = new Set((POL.targets || []).map(t => t.v))
  const polTargets = p => Array.isArray(p.target) ? (p.target.length ? p.target : ['all']) : [p.target || 'all']
  const broken = ps.filter(p => p.enabled !== false && polTargets(p).some(t => !known.has(t)))
  const cur = pfs.find(x => x.id === PF)
  const inherit = POL.inherit !== false
  const scopeOpts = [{v:'',label:'全局默认（新订阅的模板）'}, ...pfs.map(x => ({v:x.id, label:x.name + (x.own ? '（专属）' : '（继承）')}))]

  let h = \`<div class="card anim" style="animation-delay:.02s">
    <div class="ttl">编辑对象</div>
    <div class="row" style="align-items:flex-start">
      <div style="flex:1;max-width:300px">\${selectHTML('pfsel', scopeOpts, PF)}</div>
      \${PF ? (inherit
        ? \`<button class="g sm" onclick="detachPol()">改为专属配置</button>\`
        : \`<button class="g sm" onclick="inheritPol()">改回继承全局</button>\`) : ''}
    </div>
    <div class="hint" style="margin-top:9px">\${
      !PF ? '这是全局模板。改动会影响所有「继承」状态的订阅。'
      : inherit ? \`「\${esc(cur ? cur.name : '')}」当前继承全局策略，此处看到的是全局内容。要单独配置请点右侧按钮。\`
      : \`「\${esc(cur ? cur.name : '')}」使用专属策略，与全局及其它订阅互不影响。\`
    }</div>
  </div>

  <div class="card anim" style="animation-delay:.06s">
    <div class="ttl">分流策略\${PF && !inherit ? '<span class="tag" style="margin-left:2px">专属</span>' : ''}<span class="sp"></span>
      <button class="g sm" data-tip="恢复默认" onclick="resetPol()">\${icon('undo','s')}恢复默认</button>
      <button class="sm" onclick="editPol(null)">\${icon('plus','s')}新建</button></div>
    <div class="hint" style="margin:-6px 0 13px">拖动左侧手柄调整顺序 —— 顺序即匹配优先级，靠上的先命中。规则命中后不再往下匹配，所以更具体的策略要放在更宽泛的前面。</div>
    \${broken.length ? \`<div class="alert" style="margin:-4px 0 13px">\${icon('warn','s')}
      <span>\${broken.map(p => esc(p.name)).join('、')} 指向的节点已不存在，当前被降级为「🚀 节点选择」——
      出口可能不是你预期的地区。请编辑这些策略重新指定目标。</span></div>\` : ''}
    <div id="pollist">\`
  h += ps.map((p, i) => \`<div class="pol \${p.enabled===false?'off':''}" draggable="true" data-i="\${i}">
      <span class="grip">\${icon('grip','s')}</span>
      <span class="nm">\${esc(p.name)}</span>
      <span class="arrow">→</span>
      <span class="tgts">\${polTargets(p).map(t => \`<span class="tgt \${p.strict?'strict':''} \${known.has(t)?'':'gone'}" \${
        known.has(t) ? (p.strict?'data-tip="严格模式：目标不可用即失败，不回落"':'')
                     : 'data-tip="目标已不存在，实际走节点选择"'}>\${esc(tgtLabel(t))}</span>\`).join('')}</span>
      <span class="meta">\${(p.presets||[]).length ? (p.presets||[]).map(k => (POL.lib[k]||{}).name || k).join(' · ') + ' · ' : ''}\${polCount(p)} 条域名\${(p.keywords||[]).length?' · '+p.keywords.length+' 关键词':''}\${(p.processes||[]).length?' · '+p.processes.length+' 进程':''}</span>
      <button class="sw" data-on="\${p.enabled===false?0:1}" data-tip="\${p.enabled===false?'启用':'停用'}" onclick="togglePol(\${i})"><i></i></button>
      <button class="ib" data-tip="编辑" onclick="editPol(\${i})">\${icon('edit')}</button>
      <button class="ib dl" data-tip="删除" onclick="delPol(\${i})">\${icon('trash')}</button>
    </div>\`).join('') || '<div class="empty">还没有策略</div>'
  return h + '</div></div>'
}
function polCount(p){
  const s = new Set()
  ;(p.presets||[]).forEach(k => ((POL.lib[k]||{}).domains||[]).forEach(d => s.add(d)))
  ;(p.domains||[]).forEach(d => s.add(d))
  return s.size
}

function viewLib(){
  const lib = POL.lib || {}
  let h = \`<div class="card anim" style="animation-delay:.04s">
    <div class="ttl">域名库<span class="sp"></span><button class="sm" onclick="editLib(null)">\${icon('plus','s')}新建集合</button></div>
    <div class="hint" style="margin:-6px 0 13px">策略通过引用这些集合来获得域名，一处修改所有引用它的策略同步生效。</div>\`
  h += '<div class="uplist lib">'
  h += Object.entries(lib).map(([k, v]) => \`<div class="up">
      <span class="nm">\${esc(v.name || k)}</span>
      <span class="u" style="font-family:inherit;font-size:12px">\${esc(v.hint || '')}</span>
      <span class="tgt">\${(v.domains||[]).length} 条</span>
      <button class="ib" data-tip="编辑" onclick="editLib('\${esc(k)}')">\${icon('edit')}</button>
    </div>\`).join('')
  return h + '</div></div>'
}

/* 拖拽排序 */
function bindDrag(){
  const list = document.getElementById('pollist')
  if (!list) return
  let src = null

  // FLIP：先量旧位置，改完 DOM 再把元素反向偏移回去，然后过渡到 0，
  // 这样 DOM 重排也能有平滑的位移动画，视觉上就是「其他项主动让开」。
  const flip = (mutate) => {
    const items = [...list.children]
    const before = items.map(el => el.getBoundingClientRect().top)
    mutate()
    items.forEach((el, i) => {
      const dy = before[i] - el.getBoundingClientRect().top
      if (!dy) return
      el.style.transition = 'none'
      el.style.transform = 'translateY(' + dy + 'px)'
      requestAnimationFrame(() => {
        el.style.transition = 'transform .19s var(--e)'
        el.style.transform = ''
      })
    })
  }

  list.querySelectorAll('.pol').forEach(row => {
    const grip = row.querySelector('.grip')
    // 默认不可拖，只有在手柄上按下才开启，避免拖到按钮或文字时误触发
    row.draggable = false
    if (grip) {
      grip.addEventListener('mousedown', () => { row.draggable = true })
      grip.addEventListener('touchstart', () => { row.draggable = true }, { passive: true })
    }
    document.addEventListener('mouseup', () => { row.draggable = false })

    row.ondragstart = e => {
      src = row
      e.dataTransfer.effectAllowed = 'move'
      try { e.dataTransfer.setData('text/plain', '') } catch (_) {}
      // 延后一帧再加类，否则浏览器截取的拖拽预览图也会变成半透明
      setTimeout(() => row.classList.add('drag'), 0)
    }
    row.ondragend = () => {
      row.classList.remove('drag')
      row.draggable = false
      src = null
      list.querySelectorAll('.pol').forEach(r => { r.style.transition = ''; r.style.transform = '' })
      persistOrder()
    }
    row.ondragover = e => {
      e.preventDefault()
      if (!src || src === row) return
      const r = row.getBoundingClientRect()
      const after = e.clientY > r.top + r.height / 2
      const ref = after ? row.nextSibling : row
      if (ref === src) return                       // 已经在目标位置
      if (after && row.nextSibling === src) return  // 同上，避免抖动
      flip(() => list.insertBefore(src, ref))
    }
  })
  list.ondragover = e => e.preventDefault()
  list.ondrop = e => e.preventDefault()
}

// 拖拽结束后按 DOM 的实际顺序回写数据；顺序没变就不发请求
async function persistOrder(){
  const list = document.getElementById('pollist')
  if (!list) return
  const cur = POL.policies
  const next = [...list.querySelectorAll('.pol')].map(el => cur[+el.dataset.i]).filter(Boolean)
  if (next.length !== cur.length) return
  if (next.every((p, i) => p === cur[i])) return
  POL.policies = next
  await savePol('顺序已保存')
}

async function savePol(msg){
  const r = await api('/api/policies', { pf: PF, policies: POL.policies })
  if (!r.ok) {
    toast(r.msg || '保存失败', true)
    POL = await api('/api/policies?pf=' + encodeURIComponent(PF)); dash(true); return false
  }
  POL.policies = r.policies
  if (r.inherit !== undefined) POL.inherit = r.inherit
  PRF = null   // 档案的策略选项依赖它
  if (msg) toast(msg)
  dash(true)
  return true
}

window.detachPol = async () => {
  if (!await modal({title:'改为专属配置', desc:'会把当前生效的策略复制一份给这个订阅，之后两边各改各的，互不影响。', ok:'改为专属'})) return
  const r = await api('/api/policies', { pf: PF, act:'detach' })
  if (!r.ok) return toast(r.msg || '失败', true)
  POL = null; PRF = null; toast('已改为专属配置'); dash(true)
}
window.inheritPol = async () => {
  if (!await modal({title:'改回继承全局', desc:'该订阅的专属策略将被丢弃，之后跟随全局配置变动。此操作不可撤销。', ok:'改回继承', danger:true})) return
  const r = await api('/api/policies', { pf: PF, act:'inherit' })
  if (!r.ok) return toast(r.msg || '失败', true)
  POL = null; PRF = null; toast('已改回继承'); dash(true)
}

// 就地更新，不重渲染整页——否则整列表会重新播放入场动画，看起来像"跳一下"
function paintSwitch(row, on){
  if (!row) return
  row.classList.toggle('off', !on)
  const sw = row.querySelector('.sw')
  if (sw) { sw.dataset.on = on ? 1 : 0; sw.dataset.tip = on ? '停用' : '启用' }
}
async function quietSave(reloadOnFail){
  const r = await api('/api/policies', { pf: PF, policies: POL.policies })
  if (!r.ok) { toast(r.msg || '保存失败', true); POL = null; dash(true); return false }
  POL.policies = r.policies
  if (r.inherit !== undefined) POL.inherit = r.inherit
  PRF = null
  return true
}
window.togglePol = async i => {
  const p = POL.policies[i]
  p.enabled = p.enabled === false
  paintSwitch(document.querySelectorAll('#pollist .pol')[i], p.enabled !== false)
  await quietSave()
}
window.delPol = async i => {
  const p = POL.policies[i]
  if (!await modal({title:'删除策略', desc:\`「\${p.name}」将从订阅中移除，它引用的域名集不受影响。\`, ok:'删除', danger:true})) return
  POL.policies.splice(i, 1); await savePol('已删除')
}
window.resetPol = async () => {
  const who = PF ? '这个订阅的策略' : '全局策略'
  if (!await modal({title:'恢复默认策略', desc:who + '将被覆盖为内置默认值，此操作不可撤销。', ok:'恢复', danger:true})) return
  const r = await api('/api/policies', { pf: PF, act:'reset' })
  if (!r.ok) return toast(r.msg || '失败', true)
  POL = null; PRF = null; toast('已恢复默认'); dash(true)
}

window.editPol = async (i) => {
  const isNew = i === null
  const p = isNew ? { name:'', target:'all', strict:false, enabled:true, presets:[], domains:[], keywords:[], processes:[] } : JSON.parse(JSON.stringify(POL.policies[i]))
  const libs = Object.entries(POL.lib || {})
  const html = \`
    <div class="fg"><label class="lb">策略名称</label>
      <input id="pn" value="\${esc(p.name)}" placeholder="如 🎬 流媒体"></div>
    <div class="fg"><label class="lb">分流目标<span class="opt">可多选</span></label>
      \${selectHTML('pt', POL.targets, Array.isArray(p.target) ? p.target : [p.target || 'all'], true)}
      <div class="hint">选中的会按顺序放进该策略的节点组，客户端里可自行切换，第一个为默认。</div></div>
    <div class="fg"><label class="lb">严格模式</label>
      <div class="row"><button class="sw" id="ps" data-on="\${p.strict?1:0}"><i></i></button>
        <span class="hint" style="margin:0">开启后组内只有目标本身，目标不可用即断流，不会静默回落到其它地区。</span></div></div>
    <div class="fg"><label class="lb">引用域名集</label>
      <div class="chips" id="pc">\${libs.map(([k,v]) =>
        \`<span class="chip \${(p.presets||[]).includes(k)?'on':''}" data-k="\${esc(k)}">\${esc(v.name||k)}<span class="n">\${(v.domains||[]).length}</span></span>\`).join('')}</div></div>
    <div class="fg"><label class="lb">额外域名（每行一个）</label>
      <textarea id="pd" placeholder="example.com">\${esc((p.domains||[]).join('\\n'))}</textarea></div>
    <div class="fg"><label class="lb">关键词 / 进程名（逗号分隔）</label>
      <div class="row"><input id="pk" value="\${esc((p.keywords||[]).join(', '))}" placeholder="关键词，如 binance">
        <input id="pp" value="\${esc((p.processes||[]).join(', '))}" placeholder="进程名，如 ChatGPT"></div></div>\`

  const box = await modal({ title: isNew ? '新建策略' : '编辑策略', html, ok:'保存', wide:true, onMount: b => {
    bindSelect(b)
    b.querySelector('#ps').onclick = function(){ this.dataset.on = this.dataset.on === '1' ? '0' : '1' }
    b.querySelectorAll('#pc .chip').forEach(c => c.onclick = () => c.classList.toggle('on'))
  }})
  if (!box) return

  const name = box.querySelector('#pn').value.trim()
  if (!name) return toast('策略名称不能为空', true)
  const np = {
    id: p.id || 'p' + Math.abs([...name].reduce((a,c)=>a*31+c.charCodeAt(0)|0,7)).toString(36),
    name, target: selValue(box.querySelector('#pt')),
    strict: box.querySelector('#ps').dataset.on === '1',
    enabled: p.enabled !== false,
    presets: [...box.querySelectorAll('#pc .chip.on')].map(c => c.dataset.k),
    domains: box.querySelector('#pd').value.split('\\n').map(s=>s.trim()).filter(Boolean),
    keywords: box.querySelector('#pk').value.split(',').map(s=>s.trim()).filter(Boolean),
    processes: box.querySelector('#pp').value.split(',').map(s=>s.trim()).filter(Boolean)
  }
  if (isNew) POL.policies.push(np); else POL.policies[i] = np
  await savePol(isNew ? '已新建' : '已保存')
}

window.editLib = async (key) => {
  const isNew = key === null
  const v = isNew ? { name:'', hint:'', domains:[] } : (POL.lib[key] || { name:'', hint:'', domains:[] })
  const html = \`
    <div class="fg"><label class="lb">集合名称</label><input id="ln" value="\${esc(v.name||'')}" placeholder="如 流媒体"></div>
    <div class="fg"><label class="lb">说明</label><input id="lh" value="\${esc(v.hint||'')}" placeholder="可留空"></div>
    <div class="fg"><label class="lb">域名（每行一个，保存时自动去重转小写）</label>
      <textarea id="ld" style="min-height:180px">\${esc((v.domains||[]).join('\\n'))}</textarea></div>\`
  const box = await modal({ title: isNew ? '新建域名集' : '编辑域名集', html, ok:'保存', wide:true })
  if (!box) return
  const name = box.querySelector('#ln').value.trim()
  if (!name) return toast('名称不能为空', true)
  const k = key || 'c' + Math.abs([...name].reduce((a,c)=>a*31+c.charCodeAt(0)|0,7)).toString(36)
  const r = await api('/api/lib', { key:k, name, hint: box.querySelector('#lh').value.trim(),
    domains: box.querySelector('#ld').value.split('\\n').map(s=>s.trim()).filter(Boolean) })
  if (!r.ok) return toast(r.msg || '保存失败', true)
  POL.lib = r.lib; toast('已保存'); dash(true)
}

window.editSettings = async () => {
  const st = (SET && SET.settings) || { domain:'', directDomains:[], directIPs:[] }
  const html = \`
    <div class="fg"><label class="lb">本站域名</label>
      <input id="stdm" value="\${esc(st.domain)}" placeholder="sub.example.com">
      <div class="hint">用于 DNS 策略与「访问本站不走代理」的规则，填部署这个 Worker 的域名。</div></div>
    <div class="fg"><label class="lb">额外直连域名（每行一个）</label>
      <textarea id="stdd" placeholder="api.example.com">\${esc(st.directDomains.join('\\n'))}</textarea></div>
    <div class="fg"><label class="lb">额外直连 IP（每行一个）</label>
      <textarea id="stip" placeholder="203.0.113.10" style="min-height:70px">\${esc(st.directIPs.join('\\n'))}</textarea>
      <div class="hint">自建节点所在服务器的 IP 建议填这里：程序按 IP 直连时匹配不到域名规则，会被兜底送进代理绕一圈。</div></div>\`
  const box = await modal({ title:'站点设置', html, ok:'保存', wide:true })
  if (!box) return
  const lines = el => box.querySelector(el).value.split('\\n').map(x => x.trim()).filter(Boolean)
  const r = await api('/api/settings', {
    domain: box.querySelector('#stdm').value.trim(),
    directDomains: lines('#stdd'), directIPs: lines('#stip')
  })
  if (!r.ok) return toast(r.msg || '保存失败', true)
  SET = { ok:true, settings: r.settings }
  toast('已保存'); dash(true)
}

/* 自有节点编辑：按协议动态切换专属字段 */
window.editOwn = async (key) => {
  const isNew = key === null
  const ow = (OWN && OWN.own) || {}
  const n = isNew ? { name:'', type:'vless', s:'', p:443, u:'', sni:'', net:'tcp', flow:'xtls-rprx-vision', pk:'', sid:'', obfs:'salamander', opwd:'', ports:'' } : JSON.parse(JSON.stringify(ow[key]))
  const html = \`
    <div class="fg"><label class="lb">节点标识\${isNew ? '' : '（不可改）'}</label>
      <input id="ok" value="\${esc(key || '')}" placeholder="如 usV2，仅字母数字" \${isNew ? '' : 'disabled style="opacity:.55"'}>
      <div class="hint">策略通过 <code>own:标识</code> 指向该节点，改了会让现有策略失效。</div></div>
    <div class="fg"><label class="lb">节点名称</label><input id="on" value="\${esc(n.name)}" placeholder="如 美西-AI-Vision"></div>
    <div class="fg"><label class="lb">协议</label>
      \${selectHTML('ot', [{v:'vless',label:'VLESS + Reality'},{v:'hysteria2',label:'Hysteria2'}], n.type)}</div>
    <div class="fg"><label class="lb">服务器 / 端口</label>
      <div class="row"><input id="os" value="\${esc(n.s)}" placeholder="cloud.example.com">
        <input id="op" value="\${esc(String(n.p||443))}" placeholder="443" style="max-width:110px"></div></div>
    <div class="fg"><label class="lb" id="ulb">UUID</label><input id="ou" value="\${esc(n.u)}" placeholder="uuid 或密码"></div>
    <div class="fg"><label class="lb">SNI</label><input id="osni" value="\${esc(n.sni||'')}" placeholder="www.bing.com"></div>
    <div id="fv">
      <div class="fg"><label class="lb">Reality 公钥 / ShortId</label>
        <div class="row"><input id="opk" value="\${esc(n.pk||'')}" placeholder="PublicKey">
          <input id="osid" value="\${esc(n.sid||'')}" placeholder="ShortId" style="max-width:150px"></div></div>
      <div class="fg"><label class="lb">传输方式</label>
        \${selectHTML('onet', [{v:'tcp',label:'TCP + Vision 流控'},{v:'xhttp',label:'XHTTP'}], n.net||'tcp')}</div>
    </div>
    <div id="fh" hidden>
      <div class="fg"><label class="lb">端口跳跃（可留空）</label><input id="oports" value="\${esc(n.ports||'')}" placeholder="50000-50020"></div>
      <div class="fg"><label class="lb">混淆类型 / 密码</label>
        <div class="row"><input id="oobfs" value="\${esc(n.obfs||'salamander')}" placeholder="salamander" style="max-width:150px">
          <input id="oopwd" value="\${esc(n.opwd||'')}" placeholder="obfs 密码"></div></div>
    </div>\`

  const box = await modal({ title: isNew ? '添加自有节点' : '编辑自有节点', html, ok:'保存', wide:true, onMount: b => {
    bindSelect(b)
    const sync = () => {
      const t = b.querySelector('#ot').dataset.v
      b.querySelector('#fv').hidden = t !== 'vless'
      b.querySelector('#fh').hidden = t !== 'hysteria2'
      b.querySelector('#ulb').textContent = t === 'vless' ? 'UUID' : '密码'
    }
    b.querySelectorAll('#ot .selo').forEach(o => o.addEventListener('click', () => setTimeout(sync, 0)))
    sync()
  }})
  if (!box) return

  const k = (key || box.querySelector('#ok').value.trim()).replace(/[^\w-]/g,'')
  if (!k) return toast('节点标识不能为空', true)
  const t = selValue(box.querySelector('#ot'))
  const np = { name: box.querySelector('#on').value.trim(), type: t,
    s: box.querySelector('#os').value.trim(), p: box.querySelector('#op').value.trim(),
    u: box.querySelector('#ou').value.trim(), sni: box.querySelector('#osni').value.trim() }
  if (t === 'vless') {
    np.pk = box.querySelector('#opk').value.trim(); np.sid = box.querySelector('#osid').value.trim()
    np.net = selValue(box.querySelector('#onet'))
    np.flow = np.net === 'tcp' ? 'xtls-rprx-vision' : ''
  } else {
    np.ports = box.querySelector('#oports').value.trim()
    np.obfs = box.querySelector('#oobfs').value.trim()
    np.opwd = box.querySelector('#oopwd').value.trim()
  }
  const next = { ...ow, [k]: np }
  const r = await api('/api/own', { own: next })
  if (!r.ok) return toast(r.msg || '保存失败', true)
  OWN = { ok:true, own: r.own }; POL = null; PRF = null   // targets 与档案选项都依赖自有节点
  toast(isNew ? '已添加节点' : '已保存'); dash(true)
}

window.delOwn = async (key, name) => {
  if (!await modal({title:'删除自有节点', desc:\`「\${name}」将从订阅中移除。若有策略指向它，需先改那些策略的分流目标。\`, ok:'删除', danger:true})) return
  const next = { ...((OWN && OWN.own) || {}) }
  delete next[key]
  const r = await api('/api/own', { own: next })
  if (!r.ok) return toast(r.msg || '删除失败', true)
  OWN = { ok:true, own: r.own }; POL = null
  toast('已删除'); dash(true)
}

window.resetOwn = async () => {
  if (!await modal({title:'恢复默认节点', desc:'自有节点配置将被覆盖为内置默认值，此操作不可撤销。', ok:'恢复', danger:true})) return
  const r = await api('/api/own', { act:'reset' })
  if (!r.ok) return toast(r.msg || '失败', true)
  OWN = { ok:true, own: r.own }; POL = null
  toast('已恢复默认'); dash(true)
}

window.logout = async () => { if (await modal({title:'退出登录', desc:'下次进入需要重新输入管理密码。', ok:'退出'})) location.href = '/admin/logout' }
window.addUp = async () => {
  const v = await modal({ title:'添加订阅源', desc:'填入机场提供的订阅链接，保存后立即拉取。', fields:[{ph:'名称，便于区分多个来源'},{ph:'https://...'}], ok:'添加' })
  if (!v) return
  const [name, url] = v
  if (!url) return toast('订阅链接不能为空', true)
  const r = await api('/api/upstreams', {act:'add', name, url})
  if (!r.ok) return toast(r.msg, true)
  toast('已添加订阅源'); ST = null; dash()
}
window.delUp = async (id, name) => {
  if (!await modal({title:'删除订阅源', desc:\`「\${name}」及其全部节点将从订阅中移除。\`, ok:'删除', danger:true})) return
  await api('/api/upstreams', {act:'del', id}); toast('已删除'); ST = null; dash()
}
window.upAct = async (act, id, el) => {
  if (act === 'toggle' && el) {
    const row = el.closest('.up'), on = el.dataset.on === '1'
    row.classList.toggle('off', on)
    el.dataset.on = on ? 0 : 1
    el.dataset.tip = on ? '启用' : '停用'
  }
  await api('/api/upstreams', {act, id})
  if (act === 'toggle') {
    const u = ((ST && ST.upstreams) || []).find(x => x.id === id)
    if (u) u.enabled = u.enabled === false
    PRF = null   // 档案的机场选项依赖它
  } else {
    ST = null; PRF = null; dash()   // 增删要重拉节点
  }
}
window.toggle = async (key, off, el) => {
  const row = el && el.closest('.nd')
  if (row) {
    row.classList.toggle('off', off)
    el.dataset.on = off ? 0 : 1
    el.dataset.tip = off ? '启用' : '停用'
    el.setAttribute('onclick', \`toggle('\${row.dataset.k}',\${!off},this)\`)
  }
  await api('/api/node', {key, off})
  for (const rg of ((ST && ST.regions) || [])) {
    const n = rg.nodes.find(x => x.key === key)
    if (n) n.off = off
  }
}
window.rename = (btn) => {
  const row = btn.closest('.nd')
  if (row.querySelector('input')) return
  const key = row.dataset.k, nm = row.querySelector('.nm')
  const old = nm.textContent.replace('自定义','').trim()
  nm.innerHTML = \`<input class="edit" value="\${esc(old)}">\`
  const inp = nm.querySelector('input'); inp.focus(); inp.select()
  let done = false
  const fin = async (save) => {
    if (done) return; done = true
    if (!save) { ST = null; return dash(true) }
    const v = inp.value.trim()
    const r = await api('/api/node', {key, name: v})
    if (!r.ok) { toast(r.msg || '保存失败', true); ST = null; return dash(true) }
    // 只改了 overrides，本地同步即可，不必整页重拉
    for (const rg of (ST.regions || [])) {
      const n = rg.nodes.find(x => x.key === key)
      if (n) { n.name = v || n.auto || n.name; n.custom = !!v }
    }
    toast(v ? '已重命名' : '已恢复自动命名')
    dash(true)
  }
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false) })
  inp.addEventListener('blur', () => fin(true))
}
window.refresh = async (b) => {
  b.disabled = true
  b.querySelector('svg').style.animation = 'spin .9s linear infinite'
  const r = await api('/api/refresh', {})
  toast(r.ok ? \`已拉取 \${r.count} 个节点\` : '拉取失败', !r.ok)
  ST = null; dash(true)
}

authed ? dash() : login()
</script></body></html>`
}
