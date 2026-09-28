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
// DNS 归成三组，域名按组指派。直接摊开 mihomo 那一堆字段的话，
// proxy-server-nameserver 必须直连、respect-rules 不能关这类约束没地方表达，
// 配错了还很难自己发现 —— 分组能把这些约束固化在生成逻辑里。
const DNS_GROUPS = [
  { k: 'remote',    label: '境外 DNS', hint: '解析境外域名。要用加密 DoH，明文查询会被污染' },
  { k: 'domestic',  label: '国内 DNS', hint: '解析国内域名与直连域名，也用来解析节点服务器地址' },
  { k: 'bootstrap', label: '引导 DNS', hint: '只用来解析上面那些 DoH 服务器自己的域名，必须填纯 IP' }
]
const DEFAULT_DNS = {
  fakeIp: true,
  ipv6: true,
  remote: ['https://dns.cloudflare.com/dns-query', 'https://dns.google/dns-query'],
  domestic: ['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query'],
  bootstrap: ['223.5.5.5', '119.29.29.29'],
  // 本站域名默认走境外组：它多半托管在 Cloudflare、服务器也常在境外，
  // 交给国内 DNS 可能拿到被污染的地址，再叠加「本站域名直连」就会直连到错误的 IP
  selfGroup: 'remote',
  // 境外 DNS 的查询本身走代理。境内直连根本连不上 Cloudflare / Google 的 DoH
  // （实测国内直连全部超时），mihomo 连不上就回落到国内明文 DNS —— 表现为
  // DNS 泄露检测里冒出运营商的 DNS 出口。让查询走代理即可，不会循环依赖：
  // 节点服务器地址由 proxy-server-nameserver 用国内 DNS 解析，代理先起得来。
  remoteViaProxy: true,
  policies: [{ domain: '+.cn', group: 'domestic' }],
  extraFilter: []    // 追加的 fake-ip-filter，某些应用需要拿到真实 IP
}
const DEFAULT_SETTINGS = {
  domain: '',        // 本站域名，用于 DNS 策略与直连规则
  directDomains: [], // 额外直连域名
  directIPs: [],     // 额外直连 IP（如自建节点所在服务器，避免按 IP 连接时被兜底送进代理）
  // 强制走代理的域名。规则生成在所有直连规则之前 —— 命中即停，所以这是唯一能
  // 从「整个域名直连」里把个别子域名拎出来的位置。
  // 实际用途：某个子域名在直连路径上被 TLS 劫持（拿到伪造证书、跳转到搜索引擎），
  // 而同域名下别的服务又必须直连，只能单独把它送去代理。
  proxyDomains: [],
  dns: DEFAULT_DNS
}
async function loadSettings() {
  const v = await kvGet('settings', null)
  const s = { ...DEFAULT_SETTINGS, ...(v && typeof v === 'object' ? v : {}) }
  // dns 是后加的，老配置里没有；缺字段也要能按默认补齐，不能整块塌掉
  s.dns = { ...DEFAULT_DNS, ...(s.dns && typeof s.dns === 'object' ? s.dns : {}) }
  for (const g of DNS_GROUPS) if (!Array.isArray(s.dns[g.k]) || !s.dns[g.k].length) s.dns[g.k] = DEFAULT_DNS[g.k]
  if (!Array.isArray(s.dns.policies)) s.dns.policies = DEFAULT_DNS.policies
  if (!Array.isArray(s.dns.extraFilter)) s.dns.extraFilter = []
  if (!DNS_GROUPS.some(g => g.k === s.dns.selfGroup)) s.dns.selfGroup = 'remote'
  return s
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
// 机场按 UA 决定给什么格式，也有干脆按 UA 拒绝的。一种身份被挡住不代表这条链接
// 是死的 —— 依次换几种主流客户端再试，比当场判死刑靠谱。顺序即优先级：
// 前面的能拿到带分流规则的 YAML，后面的通常只给 base64 节点列表，够用但信息少。
const UPSTREAM_UAS = [
  UPSTREAM_UA,
  'ClashforWindows/0.19.23',
  'v2rayN/6.45',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  ''      // 不带 UA
]
// 后台刷新跑在 waitUntil 里，有 30 秒上限。单次请求 8 秒、单个机场 20 秒封顶，
// 各机场再并行拉，才不会被截断在半路
const UP_TIMEOUT = 8000
const UP_BUDGET = 20000
const FRESH_TTL = 3600      // 1h 内直接用缓存
const STALE_TTL = 604800    // 缓存保留 7d，上游挂了拿它兜底

// 地区分类：顺序敏感，先匹配先归类
const REGIONS = [
  { key: 'jp', flag: '🇯🇵', cn: '日本', re: /Japan|名古屋|日本|\bJP\b|东京|東京|大阪|埼玉|川日|穗日|沪日|滬日/i },
  { key: 'hk', flag: '🇭🇰', cn: '香港', re: /Hong Kong SAR China|中国香港特别行政区|中國香港特別行政區|Hong Kong|中國香港|香港|\bHK\b|港服|深港|沪港|滬港|广港|廣港/i },
  { key: 'tw', flag: '🇹🇼', cn: '台湾', re: /Taiwan|台湾|台灣|\bTW\b|台北|台中|新北|彰化/i },
  { key: 'sg', flag: '🇸🇬', cn: '新加坡', re: /Singapore|新加坡|\bSG\b|狮城|獅城/i },
  { key: 'kr', flag: '🇰🇷', cn: '韩国', re: /South Korea|韩国|南韓|\bKR\b|韓國|首尔|首爾/i },
  { key: 'us', flag: '🇺🇸', cn: '美国', re: /United States|拉斯维加斯|USA|洛杉矶|洛杉磯|堪萨斯|圣何塞|聖何塞|西雅图|西雅圖|达拉斯|鳳凰城|凤凰城|芝加哥|迈阿密|邁阿密|美国|美國|\bUS\b|美西|美东|美東|硅谷|矽谷|纽约|紐約/i },
  { key: 'gb', flag: '🇬🇧', cn: '英国', re: /United Kingdom|Britain|England|英国|英國|\bUK\b|\bGB\b|伦敦|倫敦/i },
  { key: 'de', flag: '🇩🇪', cn: '德国', re: /Germany|法兰克福|法蘭克福|德国|德國|\bDE\b|柏林/i },
  { key: 'fr', flag: '🇫🇷', cn: '法国', re: /France|法国|法國|\bFR\b|巴黎|马赛|馬賽/i },
  { key: 'ca', flag: '🇨🇦', cn: '加拿大', re: /Canada|蒙特利尔|加拿大|多伦多|多倫多|温哥华|溫哥華|\bCA\b/i },
  { key: 'au', flag: '🇦🇺', cn: '澳大利亚', re: /Australia|澳大利亚|澳大利亞|布里斯班|墨尔本|墨爾本|澳洲|\bAU\b|悉尼|雪梨|珀斯/i },
  { key: 'nz', flag: '🇳🇿', cn: '新西兰', re: /New Zealand|新西兰|紐西蘭|新西蘭|奥克兰|奧克蘭|\bNZ\b/i },
  { key: 'mo', flag: '🇲🇴', cn: '澳门', re: /Macao SAR China|中国澳门特别行政区|中國澳門特別行政區|Macao|Macau|中國澳門|澳门|\bMO\b|澳門/i },
  { key: 'cn', flag: '🇨🇳', cn: '中国', re: /China|中国|中國|回国|回國|广州|廣州|深圳|上海|北京|杭州|成都/i },
  { key: 'ru', flag: '🇷🇺', cn: '俄罗斯', re: /Russia|圣彼得堡|聖彼得堡|俄罗斯|俄羅斯|莫斯科|\bRU\b/i },
  { key: 'id', flag: '🇮🇩', cn: '印尼', re: /Indonesia|印度尼西亚|印度尼西亞|雅加达|雅加達|印尼/i },
  { key: 'my', flag: '🇲🇾', cn: '马来西亚', re: /Malaysia|马来西亚|馬來西亞|吉隆坡|大马|大馬/i },
  { key: 'th', flag: '🇹🇭', cn: '泰国', re: /Thailand|泰国|泰國|曼谷/i },
  { key: 'vn', flag: '🇻🇳', cn: '越南', re: /Vietnam|胡志明|越南|\bVN\b|河内|河內/i },
  { key: 'ph', flag: '🇵🇭', cn: '菲律宾', re: /Philippines|菲律宾|菲律賓|马尼拉|馬尼拉|\bPH\b/i },
  { key: 'in', flag: '🇮🇳', cn: '印度', re: /India|班加罗尔|新德里|印度|孟买|孟買/i },
  { key: 'tr', flag: '🇹🇷', cn: '土耳其', re: /Türkiye|Turkiye|伊斯坦布尔|伊斯坦堡|土耳其|安卡拉|\bTR\b/i },
  { key: 'ae', flag: '🇦🇪', cn: '阿联酋', re: /United Arab Emirates|阿拉伯联合酋长国|阿拉伯聯合大公國|阿拉伯联合|阿布扎比|阿联酋|UAE|阿聯酋|\bAE\b|迪拜|杜拜/i },
  { key: 'nl', flag: '🇳🇱', cn: '荷兰', re: /Netherlands|Holland|阿姆斯特丹|荷兰|荷蘭|\bNL\b/i },
  { key: 'br', flag: '🇧🇷', cn: '巴西', re: /Brazil|圣保罗|聖保羅|巴西|\bBR\b|里约|里約/i },
  { key: 'za', flag: '🇿🇦', cn: '南非', re: /South Africa|约翰内斯堡|約翰內斯堡|开普敦|開普敦|南非|\bZA\b/i },
  { key: 'gs', flag: '🇬🇸', cn: '南乔治亚和南桑威奇', re: /South Georgia & South Sandwich Islands|南乔治亚和南桑威奇群岛|南喬治亞與南三明治群島|南乔治亚和南桑威奇|南喬治亞與南三明治/i },
  { key: 'io', flag: '🇮🇴', cn: '英属印度洋领地', re: /British Indian Ocean Territory|英属印度洋领地|英屬印度洋領地/i },
  { key: 'tf', flag: '🇹🇫', cn: '法属南部领地', re: /French Southern Territories|法属南部领地|法屬南部屬地/i },
  { key: 'cf', flag: '🇨🇫', cn: '中非', re: /Central African Republic|中非共和国|中非共和國|中非/i },
  { key: 'hm', flag: '🇭🇲', cn: '赫德岛和麦克唐纳', re: /Heard & McDonald Islands|赫德岛和麦克唐纳群岛|赫德島及麥唐納群島|赫德岛和麦克唐纳|赫德島及麥唐納/i },
  { key: 'mp', flag: '🇲🇵', cn: '北马里亚纳', re: /Northern Mariana Islands|北马里亚纳群岛|北馬利安納群島|北马里亚纳|北馬利安納/i },
  { key: 'vc', flag: '🇻🇨', cn: '圣文森特和格林纳丁斯', re: /St\. Vincent & Grenadines|圣文森特和格林纳丁斯|聖文森及格瑞那丁/i },
  { key: 'cc', flag: '🇨🇨', cn: '科科斯', re: /Cocos \(Keeling\) Islands|Cocos  Islands|科科斯（基林）群岛|科克斯（基靈）群島|科科斯群岛|科克斯群島|科科斯|科克斯/i },
  { key: 'ps', flag: '🇵🇸', cn: '巴勒斯坦领土', re: /Palestinian Territories|巴勒斯坦自治區|巴勒斯坦领土/i },
  { key: 'tc', flag: '🇹🇨', cn: '特克斯和凯科斯', re: /Turks & Caicos Islands|特克斯和凯科斯群岛|土克斯及開科斯群島|特克斯和凯科斯|土克斯及開科斯/i },
  { key: 'vg', flag: '🇻🇬', cn: '英属维尔京', re: /British Virgin Islands|英属维尔京群岛|英屬維京群島|英属维尔京|英屬維京/i },
  { key: 'bq', flag: '🇧🇶', cn: '荷属加勒比区', re: /Caribbean Netherlands|荷属加勒比区|荷蘭加勒比區/i },
  { key: 'pm', flag: '🇵🇲', cn: '圣皮埃尔和密克隆', re: /St\. Pierre & Miquelon|圣皮埃尔和密克隆群岛|聖皮埃與密克隆群島|圣皮埃尔和密克隆|聖皮埃與密克隆/i },
  { key: 'um', flag: '🇺🇲', cn: '美国本土外小岛屿', re: /U\.S\. Outlying Islands|美国本土外小岛屿|美國本土外小島嶼/i },
  { key: 'ba', flag: '🇧🇦', cn: '波斯尼亚和黑塞哥维那', re: /Bosnia & Herzegovina|波斯尼亚和黑塞哥维那|波士尼亞與赫塞哥維納/i },
  { key: 'sj', flag: '🇸🇯', cn: '斯瓦尔巴和扬马延', re: /Svalbard & Jan Mayen|挪威屬斯瓦巴及尖棉|斯瓦尔巴和扬马延/i },
  { key: 'cg', flag: '🇨🇬', cn: '刚果', re: /Congo - Brazzaville|剛果（布拉薩）|刚果（布）|刚果|剛果/i },
  { key: 'st', flag: '🇸🇹', cn: '圣多美和普林西比', re: /São Tomé & Príncipe|圣多美和普林西比|聖多美普林西比/i },
  { key: 'vi', flag: '🇻🇮', cn: '美属维尔京', re: /U\.S\. Virgin Islands|美属维尔京群岛|美屬維京群島|美属维尔京|美屬維京/i },
  { key: 'do', flag: '🇩🇴', cn: '多米尼加', re: /Dominican Republic|多米尼加共和国|多明尼加共和國|多米尼加|多明尼加/i },
  { key: 'ag', flag: '🇦🇬', cn: '安提瓜和巴布达', re: /Antigua & Barbuda|安提瓜和巴布达|安地卡及巴布達/i },
  { key: 'gq', flag: '🇬🇶', cn: '赤道几内亚', re: /Equatorial Guinea|赤道几内亚|赤道幾內亞/i },
  { key: 'kn', flag: '🇰🇳', cn: '圣基茨和尼维斯', re: /St\. Kitts & Nevis|聖克里斯多福及尼維斯|圣基茨和尼维斯/i },
  { key: 'tt', flag: '🇹🇹', cn: '特立尼达和多巴哥', re: /Trinidad & Tobago|特立尼达和多巴哥|千里達及托巴哥/i },
  { key: 'cd', flag: '🇨🇩', cn: '刚果', re: /Congo - Kinshasa|剛果（金夏沙）|刚果（金）|刚果|剛果/i },
  { key: 'cx', flag: '🇨🇽', cn: '圣诞岛', re: /Christmas Island|圣诞岛|聖誕島/i },
  { key: 'fk', flag: '🇫🇰', cn: '福克兰', re: /Falkland Islands|福克兰群岛|福克蘭群島|福克兰|福克蘭/i },
  { key: 'mh', flag: '🇲🇭', cn: '马绍尔', re: /Marshall Islands|马绍尔群岛|馬紹爾群島|马绍尔|馬紹爾/i },
  { key: 'pf', flag: '🇵🇫', cn: '法属波利尼西亚', re: /French Polynesia|法属波利尼西亚|法屬玻里尼西亞/i },
  { key: 'pg', flag: '🇵🇬', cn: '巴布亚新几内亚', re: /Papua New Guinea|巴布亚新几内亚|巴布亞紐幾內亞/i },
  { key: 'pn', flag: '🇵🇳', cn: '皮特凯恩', re: /Pitcairn Islands|皮特凯恩群岛|皮特肯群島|皮特凯恩|皮特肯/i },
  { key: 'zr', flag: '🇿🇷', cn: '刚果', re: /Congo - Kinshasa|剛果（金夏沙）|刚果（金）|刚果|剛果/i },
  { key: 'bu', flag: '🇧🇺', cn: '缅甸', re: /Myanmar \(Burma\)|Myanmar|缅甸|緬甸/i },
  { key: 'mk', flag: '🇲🇰', cn: '北马其顿', re: /North Macedonia|北马其顿|北馬其頓/i },
  { key: 'mm', flag: '🇲🇲', cn: '缅甸', re: /Myanmar \(Burma\)|Myanmar|缅甸|緬甸/i },
  { key: 'sb', flag: '🇸🇧', cn: '所罗门', re: /Solomon Islands|所罗门群岛|索羅門群島|所罗门|索羅門/i },
  { key: 'wf', flag: '🇼🇫', cn: '瓦利斯和富图纳', re: /Wallis & Futuna|瓦利斯群島和富圖那群島|瓦利斯群島和富圖那|瓦利斯和富图纳/i },
  { key: 'as', flag: '🇦🇸', cn: '美属萨摩亚', re: /American Samoa|美属萨摩亚|美屬薩摩亞/i },
  { key: 'bl', flag: '🇧🇱', cn: '圣巴泰勒米', re: /St\. Barthélemy|圣巴泰勒米|聖巴瑟米/i },
  { key: 'eh', flag: '🇪🇭', cn: '西撒哈拉', re: /Western Sahara|西撒哈拉/i },
  { key: 'ky', flag: '🇰🇾', cn: '开曼', re: /Cayman Islands|开曼群岛|開曼群島|开曼|開曼/i },
  { key: 'nf', flag: '🇳🇫', cn: '诺福克岛', re: /Norfolk Island|诺福克岛|諾福克島/i },
  { key: 'uk', flag: '🇺🇰', cn: '英国', re: /United Kingdom|英国|英國/i },
  { key: 'ax', flag: '🇦🇽', cn: '奥兰', re: /Åland Islands|奥兰群岛|奧蘭群島|奥兰|奧蘭/i },
  { key: 'bv', flag: '🇧🇻', cn: '布韦岛', re: /Bouvet Island|布韦岛|布威島/i },
  { key: 'ci', flag: '🇨🇮', cn: '科特迪瓦', re: /Côte d’Ivoire|科特迪瓦|象牙海岸/i },
  { key: 'fo', flag: '🇫🇴', cn: '法罗', re: /Faroe Islands|法罗群岛|法羅群島|法罗|法羅/i },
  { key: 'gf', flag: '🇬🇫', cn: '法属圭亚那', re: /French Guiana|法属圭亚那|法屬圭亞那/i },
  { key: 'gw', flag: '🇬🇼', cn: '几内亚比绍', re: /Guinea-Bissau|几内亚比绍|幾內亞比索/i },
  { key: 'li', flag: '🇱🇮', cn: '列支敦士登', re: /Liechtenstein|列支敦士登|列支敦斯登/i },
  { key: 'nc', flag: '🇳🇨', cn: '新喀里多尼亚', re: /New Caledonia|新喀里多尼亚|新喀里多尼亞/i },
  { key: 'bf', flag: '🇧🇫', cn: '布基纳法索', re: /Burkina Faso|布基纳法索|布吉納法索/i },
  { key: 'ck', flag: '🇨🇰', cn: '库克', re: /Cook Islands|库克群岛|庫克群島|库克|庫克/i },
  { key: 'hv', flag: '🇭🇻', cn: '布基纳法索', re: /Burkina Faso|布基纳法索|布吉納法索/i },
  { key: 'sa', flag: '🇸🇦', cn: '沙特阿拉伯', re: /Saudi Arabia|沙烏地阿拉伯|沙特阿拉伯/i },
  { key: 'sl', flag: '🇸🇱', cn: '塞拉利昂', re: /Sierra Leone|塞拉利昂|獅子山/i },
  { key: 'sx', flag: '🇸🇽', cn: '荷属圣马丁', re: /Sint Maarten|荷属圣马丁|荷屬聖馬丁/i },
  { key: 'tm', flag: '🇹🇲', cn: '土库曼斯坦', re: /Turkmenistan|土库曼斯坦|土庫曼/i },
  { key: 'va', flag: '🇻🇦', cn: '梵蒂冈', re: /Vatican City|梵蒂冈|梵蒂岡/i },
  { key: 'af', flag: '🇦🇫', cn: '阿富汗', re: /Afghanistan|阿富汗/i },
  { key: 'ch', flag: '🇨🇭', cn: '瑞士', re: /Switzerland|瑞士/i },
  { key: 'im', flag: '🇮🇲', cn: '马恩岛', re: /Isle of Man|马恩岛|曼島/i },
  { key: 'kp', flag: '🇰🇵', cn: '朝鲜', re: /North Korea|朝鲜|北韓/i },
  { key: 'pr', flag: '🇵🇷', cn: '波多黎各', re: /Puerto Rico|波多黎各/i },
  { key: 'ss', flag: '🇸🇸', cn: '南苏丹', re: /South Sudan|南苏丹|南蘇丹/i },
  { key: 'sv', flag: '🇸🇻', cn: '萨尔瓦多', re: /El Salvador|萨尔瓦多|薩爾瓦多/i },
  { key: 'tl', flag: '🇹🇱', cn: '东帝汶', re: /Timor-Leste|东帝汶|東帝汶/i },
  { key: 'tp', flag: '🇹🇵', cn: '东帝汶', re: /Timor-Leste|东帝汶|東帝汶/i },
  { key: 'aq', flag: '🇦🇶', cn: '南极洲', re: /Antarctica|南极洲|南極洲/i },
  { key: 'az', flag: '🇦🇿', cn: '阿塞拜疆', re: /Azerbaijan|阿塞拜疆|亞塞拜然/i },
  { key: 'bd', flag: '🇧🇩', cn: '孟加拉国', re: /Bangladesh|孟加拉国|孟加拉/i },
  { key: 'cr', flag: '🇨🇷', cn: '哥斯达黎加', re: /Costa Rica|哥斯达黎加|哥斯大黎加/i },
  { key: 'cv', flag: '🇨🇻', cn: '佛得角', re: /Cape Verde|佛得角|維德角/i },
  { key: 'fm', flag: '🇫🇲', cn: '密克罗尼西亚', re: /Micronesia|密克罗尼西亚|密克羅尼西亞/i },
  { key: 'gp', flag: '🇬🇵', cn: '瓜德罗普', re: /Guadeloupe|瓜德罗普|瓜地洛普/i },
  { key: 'kg', flag: '🇰🇬', cn: '吉尔吉斯斯坦', re: /Kyrgyzstan|吉尔吉斯斯坦|吉爾吉斯/i },
  { key: 'kz', flag: '🇰🇿', cn: '哈萨克斯坦', re: /Kazakhstan|哈萨克斯坦|哈薩克/i },
  { key: 'lu', flag: '🇱🇺', cn: '卢森堡', re: /Luxembourg|卢森堡|盧森堡/i },
  { key: 'me', flag: '🇲🇪', cn: '黑山', re: /Montenegro|蒙特內哥羅|黑山/i },
  { key: 'mf', flag: '🇲🇫', cn: '法属圣马丁', re: /St\. Martin|法属圣马丁|法屬聖馬丁/i },
  { key: 'mg', flag: '🇲🇬', cn: '马达加斯加', re: /Madagascar|马达加斯加|馬達加斯加/i },
  { key: 'mq', flag: '🇲🇶', cn: '马提尼克', re: /Martinique|马提尼克|馬丁尼克/i },
  { key: 'mr', flag: '🇲🇷', cn: '毛里塔尼亚', re: /Mauritania|毛里塔尼亚|茅利塔尼亞/i },
  { key: 'ms', flag: '🇲🇸', cn: '蒙特塞拉特', re: /Montserrat|蒙特塞拉特|蒙哲臘/i },
  { key: 'mz', flag: '🇲🇿', cn: '莫桑比克', re: /Mozambique|莫桑比克|莫三比克/i },
  { key: 'sc', flag: '🇸🇨', cn: '塞舌尔', re: /Seychelles|塞舌尔|塞席爾/i },
  { key: 'sh', flag: '🇸🇭', cn: '圣赫勒拿', re: /St\. Helena|聖赫勒拿島|圣赫勒拿/i },
  { key: 'sm', flag: '🇸🇲', cn: '圣马力诺', re: /San Marino|圣马力诺|聖馬利諾/i },
  { key: 'tj', flag: '🇹🇯', cn: '塔吉克斯坦', re: /Tajikistan|塔吉克斯坦|塔吉克/i },
  { key: 'uz', flag: '🇺🇿', cn: '乌兹别克斯坦', re: /Uzbekistan|乌兹别克斯坦|烏茲別克/i },
  { key: 'ar', flag: '🇦🇷', cn: '阿根廷', re: /Argentina|阿根廷/i },
  { key: 'gi', flag: '🇬🇮', cn: '直布罗陀', re: /Gibraltar|直布罗陀|直布羅陀/i },
  { key: 'gl', flag: '🇬🇱', cn: '格陵兰', re: /Greenland|格陵兰|格陵蘭/i },
  { key: 'gt', flag: '🇬🇹', cn: '危地马拉', re: /Guatemala|危地马拉|瓜地馬拉/i },
  { key: 'lc', flag: '🇱🇨', cn: '圣卢西亚', re: /St\. Lucia|圣卢西亚|聖露西亞/i },
  { key: 'lk', flag: '🇱🇰', cn: '斯里兰卡', re: /Sri Lanka|斯里兰卡|斯里蘭卡/i },
  { key: 'lt', flag: '🇱🇹', cn: '立陶宛', re: /Lithuania|立陶宛/i },
  { key: 'mu', flag: '🇲🇺', cn: '毛里求斯', re: /Mauritius|毛里求斯|模里西斯/i },
  { key: 'ni', flag: '🇳🇮', cn: '尼加拉瓜', re: /Nicaragua|尼加拉瓜/i },
  { key: 've', flag: '🇻🇪', cn: '委内瑞拉', re: /Venezuela|委内瑞拉|委內瑞拉/i },
  { key: 'ai', flag: '🇦🇮', cn: '安圭拉', re: /Anguilla|安圭拉|安奎拉/i },
  { key: 'bb', flag: '🇧🇧', cn: '巴巴多斯', re: /Barbados|巴巴多斯|巴貝多/i },
  { key: 'bg', flag: '🇧🇬', cn: '保加利亚', re: /Bulgaria|保加利亚|保加利亞/i },
  { key: 'bw', flag: '🇧🇼', cn: '博茨瓦纳', re: /Botswana|博茨瓦纳|波札那/i },
  { key: 'cm', flag: '🇨🇲', cn: '喀麦隆', re: /Cameroon|喀麦隆|喀麥隆/i },
  { key: 'co', flag: '🇨🇴', cn: '哥伦比亚', re: /Colombia|哥伦比亚|哥倫比亞/i },
  { key: 'dj', flag: '🇩🇯', cn: '吉布提', re: /Djibouti|吉布提|吉布地/i },
  { key: 'dm', flag: '🇩🇲', cn: '多米尼克', re: /Dominica|多米尼克/i },
  { key: 'et', flag: '🇪🇹', cn: '埃塞俄比亚', re: /Ethiopia|埃塞俄比亚|衣索比亞/i },
  { key: 'gg', flag: '🇬🇬', cn: '根西岛', re: /Guernsey|根西岛|根息/i },
  { key: 'hn', flag: '🇭🇳', cn: '洪都拉斯', re: /Honduras|洪都拉斯|宏都拉斯/i },
  { key: 'kh', flag: '🇰🇭', cn: '柬埔寨', re: /Cambodia|柬埔寨/i },
  { key: 'ki', flag: '🇰🇮', cn: '基里巴斯', re: /Kiribati|基里巴斯|吉里巴斯/i },
  { key: 'mn', flag: '🇲🇳', cn: '蒙古', re: /Mongolia|蒙古/i },
  { key: 'mv', flag: '🇲🇻', cn: '马尔代夫', re: /Maldives|马尔代夫|馬爾地夫/i },
  { key: 'pk', flag: '🇵🇰', cn: '巴基斯坦', re: /Pakistan|巴基斯坦/i },
  { key: 'pt', flag: '🇵🇹', cn: '葡萄牙', re: /Portugal|葡萄牙/i },
  { key: 'py', flag: '🇵🇾', cn: '巴拉圭', re: /Paraguay|巴拉圭/i },
  { key: 'rh', flag: '🇷🇭', cn: '津巴布韦', re: /Zimbabwe|津巴布韦|辛巴威/i },
  { key: 'si', flag: '🇸🇮', cn: '斯洛文尼亚', re: /Slovenia|斯洛文尼亚|斯洛維尼亞/i },
  { key: 'sk', flag: '🇸🇰', cn: '斯洛伐克', re: /Slovakia|斯洛伐克/i },
  { key: 'sr', flag: '🇸🇷', cn: '苏里南', re: /Suriname|苏里南|蘇利南/i },
  { key: 'sz', flag: '🇸🇿', cn: '斯威士兰', re: /Eswatini|斯威士兰|史瓦帝尼/i },
  { key: 'tz', flag: '🇹🇿', cn: '坦桑尼亚', re: /Tanzania|坦桑尼亚|坦尚尼亞/i },
  { key: 'zw', flag: '🇿🇼', cn: '津巴布韦', re: /Zimbabwe|津巴布韦|辛巴威/i },
  { key: 'ad', flag: '🇦🇩', cn: '安道尔', re: /Andorra|安道尔|安道爾/i },
  { key: 'al', flag: '🇦🇱', cn: '阿尔巴尼亚', re: /Albania|阿尔巴尼亚|阿爾巴尼亞/i },
  { key: 'am', flag: '🇦🇲', cn: '亚美尼亚', re: /Armenia|亚美尼亚|亞美尼亞/i },
  { key: 'an', flag: '🇦🇳', cn: '库拉索', re: /Curaçao|库拉索|庫拉索/i },
  { key: 'at', flag: '🇦🇹', cn: '奥地利', re: /Austria|奥地利|奧地利/i },
  { key: 'be', flag: '🇧🇪', cn: '比利时', re: /Belgium|比利时|比利時/i },
  { key: 'bh', flag: '🇧🇭', cn: '巴林', re: /Bahrain|巴林/i },
  { key: 'bi', flag: '🇧🇮', cn: '布隆迪', re: /Burundi|布隆迪|蒲隆地/i },
  { key: 'bm', flag: '🇧🇲', cn: '百慕大', re: /Bermuda|百慕大|百慕達/i },
  { key: 'bo', flag: '🇧🇴', cn: '玻利维亚', re: /Bolivia|玻利维亚|玻利維亞/i },
  { key: 'bs', flag: '🇧🇸', cn: '巴哈马', re: /Bahamas|巴哈马|巴哈馬/i },
  { key: 'by', flag: '🇧🇾', cn: '白俄罗斯', re: /Belarus|白俄罗斯|白俄羅斯/i },
  { key: 'cw', flag: '🇨🇼', cn: '库拉索', re: /Curaçao|库拉索|庫拉索/i },
  { key: 'cz', flag: '🇨🇿', cn: '捷克', re: /Czechia|捷克/i },
  { key: 'dd', flag: '🇩🇩', cn: '德国', re: /Germany|德国|德國/i },
  { key: 'dk', flag: '🇩🇰', cn: '丹麦', re: /Denmark|丹麦|丹麥/i },
  { key: 'dz', flag: '🇩🇿', cn: '阿尔及利亚', re: /Algeria|阿尔及利亚|阿爾及利亞/i },
  { key: 'ec', flag: '🇪🇨', cn: '厄瓜多尔', re: /Ecuador|厄瓜多尔|厄瓜多/i },
  { key: 'ee', flag: '🇪🇪', cn: '爱沙尼亚', re: /Estonia|爱沙尼亚|愛沙尼亞/i },
  { key: 'er', flag: '🇪🇷', cn: '厄立特里亚', re: /Eritrea|厄立特里亚|厄利垂亞/i },
  { key: 'fi', flag: '🇫🇮', cn: '芬兰', re: /Finland|芬兰|芬蘭/i },
  { key: 'gd', flag: '🇬🇩', cn: '格林纳达', re: /Grenada|格林纳达|格瑞那達/i },
  { key: 'ge', flag: '🇬🇪', cn: '格鲁吉亚', re: /Georgia|格鲁吉亚|喬治亞/i },
  { key: 'hr', flag: '🇭🇷', cn: '克罗地亚', re: /Croatia|克羅埃西亞|克罗地亚/i },
  { key: 'hu', flag: '🇭🇺', cn: '匈牙利', re: /Hungary|匈牙利/i },
  { key: 'ie', flag: '🇮🇪', cn: '爱尔兰', re: /Ireland|爱尔兰|愛爾蘭/i },
  { key: 'is', flag: '🇮🇸', cn: '冰岛', re: /Iceland|冰岛|冰島/i },
  { key: 'jm', flag: '🇯🇲', cn: '牙买加', re: /Jamaica|牙买加|牙買加/i },
  { key: 'km', flag: '🇰🇲', cn: '科摩罗', re: /Comoros|科摩罗|葛摩/i },
  { key: 'lb', flag: '🇱🇧', cn: '黎巴嫩', re: /Lebanon|黎巴嫩/i },
  { key: 'lr', flag: '🇱🇷', cn: '利比里亚', re: /Liberia|利比里亚|賴比瑞亞/i },
  { key: 'ls', flag: '🇱🇸', cn: '莱索托', re: /Lesotho|莱索托|賴索托/i },
  { key: 'ma', flag: '🇲🇦', cn: '摩洛哥', re: /Morocco|摩洛哥/i },
  { key: 'md', flag: '🇲🇩', cn: '摩尔多瓦', re: /Moldova|摩尔多瓦|摩爾多瓦/i },
  { key: 'na', flag: '🇳🇦', cn: '纳米比亚', re: /Namibia|纳米比亚|納米比亞/i },
  { key: 'ng', flag: '🇳🇬', cn: '尼日利亚', re: /Nigeria|尼日利亚|奈及利亞/i },
  { key: 'nh', flag: '🇳🇭', cn: '瓦努阿图', re: /Vanuatu|瓦努阿图|萬那杜/i },
  { key: 're', flag: '🇷🇪', cn: '留尼汪', re: /Réunion|留尼汪|留尼旺/i },
  { key: 'ro', flag: '🇷🇴', cn: '罗马尼亚', re: /Romania|罗马尼亚|羅馬尼亞/i },
  { key: 'sn', flag: '🇸🇳', cn: '塞内加尔', re: /Senegal|塞内加尔|塞內加爾/i },
  { key: 'so', flag: '🇸🇴', cn: '索马里', re: /Somalia|索馬利亞|索马里/i },
  { key: 'tk', flag: '🇹🇰', cn: '托克劳', re: /Tokelau|托克勞群島|托克劳|托克勞/i },
  { key: 'tn', flag: '🇹🇳', cn: '突尼斯', re: /Tunisia|突尼西亞|突尼斯/i },
  { key: 'ua', flag: '🇺🇦', cn: '乌克兰', re: /Ukraine|乌克兰|烏克蘭/i },
  { key: 'uy', flag: '🇺🇾', cn: '乌拉圭', re: /Uruguay|乌拉圭|烏拉圭/i },
  { key: 'vd', flag: '🇻🇩', cn: '越南', re: /Vietnam|越南/i },
  { key: 'vu', flag: '🇻🇺', cn: '瓦努阿图', re: /Vanuatu|瓦努阿图|萬那杜/i },
  { key: 'yt', flag: '🇾🇹', cn: '马约特', re: /Mayotte|馬約特島|马约特/i },
  { key: 'ao', flag: '🇦🇴', cn: '安哥拉', re: /Angola|安哥拉/i },
  { key: 'bn', flag: '🇧🇳', cn: '文莱', re: /Brunei|文莱|汶萊/i },
  { key: 'bt', flag: '🇧🇹', cn: '不丹', re: /Bhutan|不丹/i },
  { key: 'bz', flag: '🇧🇿', cn: '伯利兹', re: /Belize|伯利兹|貝里斯/i },
  { key: 'cs', flag: '🇨🇸', cn: '塞尔维亚', re: /Serbia|塞尔维亚|塞爾維亞/i },
  { key: 'cy', flag: '🇨🇾', cn: '塞浦路斯', re: /Cyprus|塞浦路斯|賽普勒斯/i },
  { key: 'fx', flag: '🇫🇽', cn: '法国', re: /France|法国|法國/i },
  { key: 'gm', flag: '🇬🇲', cn: '冈比亚', re: /Gambia|冈比亚|甘比亞/i },
  { key: 'gn', flag: '🇬🇳', cn: '几内亚', re: /Guinea|几内亚|幾內亞/i },
  { key: 'gr', flag: '🇬🇷', cn: '希腊', re: /Greece|希腊|希臘/i },
  { key: 'gy', flag: '🇬🇾', cn: '圭亚那', re: /Guyana|圭亚那|蓋亞那/i },
  { key: 'il', flag: '🇮🇱', cn: '以色列', re: /Israel|以色列/i },
  { key: 'je', flag: '🇯🇪', cn: '泽西岛', re: /Jersey|泽西岛|澤西島/i },
  { key: 'jo', flag: '🇯🇴', cn: '约旦', re: /Jordan|约旦|約旦/i },
  { key: 'kw', flag: '🇰🇼', cn: '科威特', re: /Kuwait|科威特/i },
  { key: 'lv', flag: '🇱🇻', cn: '拉脱维亚', re: /Latvia|拉脱维亚|拉脫維亞/i },
  { key: 'mc', flag: '🇲🇨', cn: '摩纳哥', re: /Monaco|摩纳哥|摩納哥/i },
  { key: 'mw', flag: '🇲🇼', cn: '马拉维', re: /Malawi|马拉维|馬拉威/i },
  { key: 'mx', flag: '🇲🇽', cn: '墨西哥', re: /Mexico|墨西哥/i },
  { key: 'no', flag: '🇳🇴', cn: '挪威', re: /Norway|挪威/i },
  { key: 'pa', flag: '🇵🇦', cn: '巴拿马', re: /Panama|巴拿马|巴拿馬/i },
  { key: 'pl', flag: '🇵🇱', cn: '波兰', re: /Poland|波兰|波蘭/i },
  { key: 'rs', flag: '🇷🇸', cn: '塞尔维亚', re: /Serbia|塞尔维亚|塞爾維亞/i },
  { key: 'rw', flag: '🇷🇼', cn: '卢旺达', re: /Rwanda|卢旺达|盧安達/i },
  { key: 'se', flag: '🇸🇪', cn: '瑞典', re: /Sweden|瑞典/i },
  { key: 'su', flag: '🇸🇺', cn: '俄罗斯', re: /Russia|俄罗斯|俄羅斯/i },
  { key: 'tv', flag: '🇹🇻', cn: '图瓦卢', re: /Tuvalu|图瓦卢|吐瓦魯/i },
  { key: 'ug', flag: '🇺🇬', cn: '乌干达', re: /Uganda|乌干达|烏干達/i },
  { key: 'xk', flag: '🇽🇰', cn: '科索沃', re: /Kosovo|科索沃/i },
  { key: 'yu', flag: '🇾🇺', cn: '塞尔维亚', re: /Serbia|塞尔维亚|塞爾維亞/i },
  { key: 'zm', flag: '🇿🇲', cn: '赞比亚', re: /Zambia|赞比亚|尚比亞/i },
  { key: 'aw', flag: '🇦🇼', cn: '阿鲁巴', re: /荷屬阿魯巴|Aruba|阿鲁巴/i },
  { key: 'bj', flag: '🇧🇯', cn: '贝宁', re: /Benin|贝宁|貝南/i },
  { key: 'cl', flag: '🇨🇱', cn: '智利', re: /Chile|智利/i },
  { key: 'dy', flag: '🇩🇾', cn: '贝宁', re: /Benin|贝宁|貝南/i },
  { key: 'eg', flag: '🇪🇬', cn: '埃及', re: /Egypt|埃及/i },
  { key: 'es', flag: '🇪🇸', cn: '西班牙', re: /Spain|西班牙/i },
  { key: 'ga', flag: '🇬🇦', cn: '加蓬', re: /Gabon|加蓬|加彭/i },
  { key: 'gh', flag: '🇬🇭', cn: '加纳', re: /Ghana|加纳|迦納/i },
  { key: 'ht', flag: '🇭🇹', cn: '海地', re: /Haiti|海地/i },
  { key: 'it', flag: '🇮🇹', cn: '意大利', re: /Italy|意大利|義大利/i },
  { key: 'ke', flag: '🇰🇪', cn: '肯尼亚', re: /Kenya|肯尼亚|肯亞/i },
  { key: 'ly', flag: '🇱🇾', cn: '利比亚', re: /Libya|利比亚|利比亞/i },
  { key: 'mt', flag: '🇲🇹', cn: '马耳他', re: /Malta|马耳他|馬爾他/i },
  { key: 'ne', flag: '🇳🇪', cn: '尼日尔', re: /Niger|尼日尔|尼日/i },
  { key: 'np', flag: '🇳🇵', cn: '尼泊尔', re: /Nepal|尼泊尔|尼泊爾/i },
  { key: 'nr', flag: '🇳🇷', cn: '瑙鲁', re: /Nauru|瑙鲁|諾魯/i },
  { key: 'pw', flag: '🇵🇼', cn: '帕劳', re: /Palau|帕劳|帛琉/i },
  { key: 'qa', flag: '🇶🇦', cn: '卡塔尔', re: /Qatar|卡塔尔|卡達/i },
  { key: 'sd', flag: '🇸🇩', cn: '苏丹', re: /Sudan|苏丹|蘇丹/i },
  { key: 'sy', flag: '🇸🇾', cn: '叙利亚', re: /Syria|叙利亚|敘利亞/i },
  { key: 'to', flag: '🇹🇴', cn: '汤加', re: /Tonga|汤加|東加/i },
  { key: 'ws', flag: '🇼🇸', cn: '萨摩亚', re: /Samoa|萨摩亚|薩摩亞/i },
  { key: 'yd', flag: '🇾🇩', cn: '也门', re: /Yemen|也门|葉門/i },
  { key: 'ye', flag: '🇾🇪', cn: '也门', re: /Yemen|也门|葉門/i },
  { key: 'cq', flag: '🇨🇶', cn: '萨克岛', re: /Sark|萨克岛|薩克島/i },
  { key: 'cu', flag: '🇨🇺', cn: '古巴', re: /Cuba|古巴/i },
  { key: 'fj', flag: '🇫🇯', cn: '斐济', re: /Fiji|斐济|斐濟/i },
  { key: 'gu', flag: '🇬🇺', cn: '关岛', re: /Guam|关岛|關島/i },
  { key: 'iq', flag: '🇮🇶', cn: '伊拉克', re: /Iraq|伊拉克/i },
  { key: 'ir', flag: '🇮🇷', cn: '伊朗', re: /Iran|伊朗/i },
  { key: 'la', flag: '🇱🇦', cn: '老挝', re: /Laos|老挝|寮國/i },
  { key: 'ml', flag: '🇲🇱', cn: '马里', re: /Mali|马里|馬利/i },
  { key: 'nu', flag: '🇳🇺', cn: '纽埃', re: /Niue|紐埃島|纽埃/i },
  { key: 'om', flag: '🇴🇲', cn: '阿曼', re: /Oman|阿曼/i },
  { key: 'pe', flag: '🇵🇪', cn: '秘鲁', re: /Peru|秘鲁|秘魯/i },
  { key: 'td', flag: '🇹🇩', cn: '乍得', re: /Chad|乍得|查德/i },
  { key: 'tg', flag: '🇹🇬', cn: '多哥', re: /Togo|多哥/i },
  { key: 'other', flag: '🌐', cn: '其他', re: /.*/ }
]

// 节点名里的国旗 emoji 直接编码了 ISO 国家码（两个 Regional Indicator 字符），
// 比拿文字去猜可靠得多 —— 机场爱写「🇪🇸 马德里」这种只有城市名的，文字匹配抓不到。
// 但有两种国旗不能全信：
//   🇺🇲（美国本土外小岛屿）常被当成美国旗用 —— 两者长得一模一样，机场挑错的很多
//   🇨🇳 配「香港 / 台湾 / 澳门」的写法也常见，这时文字才是节点真正所在
// 不能整体改成文字优先：「🇯🇵 日本-美国中转」这类名字文字会误判到美国。
function flagRegion(name) {
  const s = String(name)
  const m = s.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)
  if (!m) return null
  let cc = [...m[0]].map(c => String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 65)).join('').toLowerCase()
  if (cc === 'um') cc = 'us'
  if (cc === 'cn') {
    const sar = ['hk', 'tw', 'mo'].find(k => (REGIONS.find(r => r.key === k) || { re: /$^/ }).re.test(s))
    if (sar) return sar
  }
  return REGIONS.some(r => r.key === cc) ? cc : null
}
// 国旗优先，退回文字匹配。凡是要定地区的地方都走这里，别各写各的。
function regionOf(name) {
  return flagRegion(name) || REGIONS.find(x => x.re.test(name)).key
}

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
  ai: { name: 'AI 服务', hint: 'Claude / DeepSeek / Copilot 等；Gemini 归 google 预置集', domains: [
    'anthropic.com','claude.ai','api.anthropic.com',
    'cohere.ai','api.cohere.ai','mistral.ai','api.mistral.ai',
    'perplexity.ai','perplexity.com','githubcopilot.com','copilot.microsoft.com',
    'huggingface.co','together.xyz','fireworks.ai','groq.com','api.groq.com',
    'deepseek.com','api.deepseek.com','x.ai','grok.com','moonshot.cn','bigmodel.cn'
  ]},
  aitest: { name: 'IP 检测', hint: '验证出口用，务必与服务端 ai-proxy 表保持一致', domains: [
    'ping0.cc','ip.net.coffee'
  ]},
  google: { name: 'Google', hint: '账号基础设施 + Gemini；不整族同出口会被判定异地', domains: [
    'google.com','gstatic.com','googleusercontent.com','google.cn',
    'googlesource.com','googletagmanager.com','google-analytics.com',
    'dns.google','withgoogle.com','goo.gl','ggpht.com',
    // Gemini / AI Studio 跑在 Google 账号体系上，认证走 accounts.google.com。
    // 放进 AI 组会让它和账号域名分到两个出口，Google 直接判异常流量。
    'googleapis.com','gemini.google.com','generativelanguage.googleapis.com',
    'bard.google.com','deepmind.google','aistudio.google.com'
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
  // Google 单独一组，不跟其它 AI 混。Gemini 对出口 IP 的信誉要求比搜索高得多——
  // 同一个 IP 搜索能正常返回，Gemini 却会被 302 打到 /sorry/。共享 VPS（搬瓦工这类）
  // 和多人共用的第三方落地基本都进了黑名单，这一组必须指向独占且未被标记的出口。
  // strict 不能关：回落到别的节点就是 Google 全族跨出口，照样触发风控。
  { id:'google',  name:'🔍 Google',   target:'own:usGoogle', strict:true, presets:['google'], domains:[], keywords:[], processes:[], enabled:true },
  { id:'ai',      name:'🤖 AI 服务',   target:'own:usV2',   strict:true,  presets:['ai','aitest'], domains:[], keywords:[], processes:[], enabled:true },
  { id:'crypto',  name:'💰 加密货币',  target:'own:usV2',   strict:false, presets:['crypto'],  domains:[], keywords:['binance'], processes:[], enabled:true },
  { id:'tg',      name:'✈️ Telegram', target:'all',        strict:false, presets:['telegram'],domains:[], keywords:[], processes:[], enabled:true },
  { id:'dev',     name:'⚙️ 开发者',    target:'all',        strict:false, presets:['dev'],     domains:[], keywords:[], processes:[], enabled:true },
  { id:'apple',   name:'🍎 Apple',    target:'direct',     strict:false, presets:['apple'],   domains:[], keywords:[], processes:[], enabled:true },
  { id:'ms',      name:'🪟 Microsoft', target:'direct',    strict:false, presets:['microsoft'],domains:[],keywords:[], processes:[], enabled:true },
  { id:'misc',    name:'🌐 常用境外',  target:'all',        strict:false, presets:['misc'],    domains:[], keywords:[], processes:[], enabled:true }
]

// 一项输入 → 规则里能用的域名；不像域名的返回空串。
// 粘完整 URL、写成 `*.x.com` / `+.x.com` 都是常事：DOMAIN-SUFFIX 本身就含全部子域名，
// 带着通配符前缀生成的规则永远匹配不上，而且不报错，是静默失效。
const DOMAIN_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$/
function cleanDomain(x) {
  let d = String(x || '').trim().toLowerCase()
  if (d.length <= 253 && DOMAIN_RE.test(d)) return d      // 绝大多数本来就是干净的，免费版 CPU 预算紧
  d = d
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')      // 协议头
    .replace(/^[^@/?#]*@/, '')                   // user@
    .replace(/[/?#].*$/, '')                     // 路径、查询串、锚点
    .replace(/:\d*$/, '')                        // 端口
    .replace(/^[*+]?\.+/, '')                    // *. +. .
    .replace(/\.+$/, '')
  if (/[^\x00-\x7f]/.test(d)) { try { d = new URL('http://' + d).hostname } catch (e) { return '' } }   // 中文域名转 punycode
  if (d.length > 253 || !DOMAIN_RE.test(d)) return ''
  return d
}
// 一行里可能塞了好几个（`a.com, b.com`），整行当一个域名会生成一条非法规则。
// 拆出来的若是不带点的单词，多半是一句话被拆开了（`not a domain`），丢掉；
// 单独填一个 `cn` 这类顶级域则是有意为之，保留
const splitDomains = x => {
  const s = String(x || '')
  if (!/[\s,，]/.test(s)) { const d = cleanDomain(s); return d ? [d] : [] }
  const parts = s.split(/[\s,，]+/).filter(Boolean)
  return parts.map(cleanDomain).filter(d => d && (parts.length === 1 || d.includes('.')))
}

// 合并策略自身的域名与它引用的预置集，去重后保持顺序
function policyDomains(p, lib) {
  const out = [], seen = new Set()
  const push = x => { for (const d of splitDomains(x)) if (!seen.has(d)) { seen.add(d); out.push(d) } }
  ;(p.presets || []).forEach(k => (lib[k]?.domains || []).forEach(push))
  ;(p.domains || []).forEach(push)
  return out
}

async function loadPolicies() {
  const ps = await kvGet('policies', null)
  return Array.isArray(ps) && ps.length ? ps : DEFAULT_POLICIES
}

// 每个域名集被哪些策略引用（全局 + 各订阅的专属策略）。
// 删集合前要查它，域名库页也靠它告诉用户「改这里会影响谁」。
function libRefs(globals, profiles) {
  const refs = {}
  const note = (k, who) => { const a = refs[k] || (refs[k] = []); if (!a.includes(who)) a.push(who) }
  for (const pol of globals || []) for (const k of pol.presets || []) note(k, pol.name)
  for (const pr of profiles || []) {
    if (!Array.isArray(pr.policies)) continue
    for (const pol of pr.policies) for (const k of pol.presets || []) note(k, `${pr.name}／${pol.name}`)
  }
  return refs
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
// 「重置订阅」用的默认档案，token 一律新生成。沿用 SETUP_TOKEN 的话，管理员之前因泄露
// 换掉的那个地址（默认订阅的 token 就是它，deploy.sh 还把它打印在终端上）会重新生效
function defaultProfiles() {
  return DEFAULT_PROFILES.map(p => ({ ...p, token: randHex(16) }))
}

// 订阅名下发给客户端。HTTP 头只能是 ASCII，中文得按 RFC 6266 编码成
// filename*，同时留一份 ASCII 的 filename 给不认 filename* 的老客户端。
// 两个都给时，认得 filename* 的客户端会优先用它。
function contentDisposition(name, ext) {
  const n = String(name || '').trim().slice(0, 60) || '订阅'
  // 引号和反斜杠会截断头部，控制字符更是直接让整个响应非法
  const ascii = n.replace(/[^\x20-\x7E]/g, '').replace(/["\\;]/g, '').trim()
  let fallback = ascii || 'subscription'
  let star = n
  const e = String(ext || '').replace(/^\./, '')
  if (e && /^[A-Za-z0-9]+$/.test(e)) {
    const suf = '.' + e
    if (!/\.[A-Za-z0-9]+$/.test(fallback)) fallback += suf
    if (!/\.[A-Za-z0-9]+$/.test(star)) star += suf
  }
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(star)}`
}

// ---------- 链式代理 ----------
// 一条链 = 先连中转，再从中转连落地，出口 IP 是落地的。
// 典型用法：自建节点做中转（入口线路好、稳），机场家宽节点做落地（住宅 IP，
// 风控友好）—— 机场家宽便宜正是因为入口线路差，套一层自建正好互补。
async function loadChains() {
  const c = await kvGet('chains', null)
  return Array.isArray(c) ? c : []
}

// 落地节点必须是具体的某一个：dialer-proxy 是加在节点上的字段，
// 指向一个组的话没地方安放。中转反过来可以是组，组内挂了会自动换。
//
// pool 传的是「全部节点」而不是档案筛选后的那批。档案筛选的语义是
// 「这份订阅里能直接选哪些节点」，而链式是用户在别处显式定义的独立节点，
// 引用某个落地只为拿它的连接配置。两者混在一起的后果是：在链式里选了一个
// 恰好被该档案排除的节点，链就静默不生成 —— 界面上看着好好的，订阅里没有。
function resolveChains(chains, pool, own, liveKeys) {
  const out = []
  const byKey = {}
  for (const n of pool) byKey[n.key] = n
  for (const c of (chains || [])) {
    if (c.enabled === false) continue
    const land = byKey[c.out]
    if (!land) continue                       // 落地节点没了（机场改名/下线），整条链跳过
    const via = resolveTarget(c.via, liveKeys, own, null)
    if (!via || via === c.name) continue      // 中转解析不出来，或指向自己
    out.push({ id: c.id, name: c.name, via, land })
  }
  return out
}

// 落地节点的协议决定这条链能不能通：链路里层跑在外层的隧道内，
// 基于 UDP 的协议（hysteria2/tuic）在多数隧道里没法转发。
// mihomo 官方文档也建议落地用简单协议。
const CHAIN_BAD_LANDING = /^(hysteria2?|tuic|wireguard)$/i
function chainLandingWarn(kv) {
  const t = unquote((kv || {}).type || '')
  return CHAIN_BAD_LANDING.test(t) ? `落地节点是 ${t}，基于 UDP 的协议在链式里多半连不通，建议换 vless / vmess / trojan / ss` : ''
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

// 严格策略指向的自有节点被这份订阅排除时，订阅里那一组会回落到「🚀 节点选择」——
// 出口悄悄换成机场节点，正是严格模式想防的事。这里不改生成逻辑（改成断流会让
// 不含自建节点的订阅整族断掉 Google），只把它找出来，管理端在订阅卡片上点名。
function strictLost(prof, globals) {
  const pols = Array.isArray(prof.policies) ? prof.policies
    : (globals || []).filter(p => prof.pols === 'all' || (Array.isArray(prof.pols) && prof.pols.includes(p.id)))
  const hasOwn = k => prof.own === 'all' || (Array.isArray(prof.own) && prof.own.includes(k))
  return pols.filter(p => p.enabled !== false && p.strict).filter(p => {
    const t = targetList(p)
    return t.length && t.every(x => String(x).startsWith('own:') && !hasOwn(String(x).slice(4)))
  }).map(p => p.name)
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

// 不能当对象属性名的 key：写进去改的是原型链，不是这个对象
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// 备份覆盖的全部配置项。缓存、快照、拉取记录、登录凭据都不在内（快照另外单独带）。
const BACKUP_KEYS = ['settings', 'nodes', 'upstreams', 'overrides', 'profiles', 'policies', 'lib', 'chains']

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

// 定长比较。普通的 === 遇到第一个不同字符就返回，耗时随「猜对了几位」变化，
// 签名和密码哈希都不该给出这种信号。
function safeEq(a, b) {
  a = String(a); b = String(b)
  let d = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return d === 0
}

// 管理密码：PBKDF2-SHA256 加盐。以前是一次无盐 sha256 —— KV 一旦外泄，
// 8 位密码在显卡上几分钟就能跑出来，同一个密码用在别处的也跟着遭殃。
// 迭代次数受免费版 10ms CPU 限制：1 万次约 2.5ms，改密码要算两次也还有余量。
// 参数写进哈希串里，以后要调高不影响已存的旧哈希。
const PW_ITER = 10000
async function hashPassword(pw, salt, iter) {
  iter = iter || PW_ITER
  salt = salt || crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256)
  return `pbkdf2$${iter}$${b64u(salt)}$${b64u(bits)}`
}
function b64uDecode(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4))
  return Uint8Array.from(b, c => c.charCodeAt(0))
}
// 返回 { ok, legacy }：legacy 表示还是老的无盐 sha256，登录成功后顺手升级
async function verifyPassword(pw, stored) {
  stored = String(stored || '')
  if (!stored) return { ok: false }
  const p = stored.split('$')
  if (p[0] === 'pbkdf2' && p.length === 4) {
    const iter = parseInt(p[1], 10)
    if (!(iter > 0 && iter <= 100000)) return { ok: false }   // Workers 的 PBKDF2 上限就是 10 万
    return { ok: safeEq(await hashPassword(pw, b64uDecode(p[2]), iter), stored) }
  }
  return { ok: safeEq(await sha256(String(pw)), stored), legacy: true }
}

// 密码错误计数，按来源 IP。公网上的后台不限次数，等于允许无限次猜密码。
//
// 计数不写 KV：免费版每天只有 1000 次写入，错一次写一次的话，谁都能不登录就把配额刷光，
// 当天连管理端保存都跟着失败。计数放两处：本 isolate 的内存（同一时刻涌进来的并发猜测
// 在这里就会撞上），以及本机房的 Cache API（跨 isolate 共享、自动过期、不限写入；
// 部署在 workers.dev 子域名上时它不生效，只剩内存计数）。
const LOGIN_MAX_FAIL = 5
const LOGIN_LOCK_SEC = 900
const FAILS = new Map()      // 桶 → { n, first, until }
const PENDING = new Map()    // 桶 → 正在校验中的次数
// 只认 Cloudflare 填的 CF-Connecting-IP。X-Forwarded-For 客户端想写什么写什么，
// 拿它计数的话，每次换个值就能绕过登录限速。
function clientIP(req) {
  return req.headers.get('CF-Connecting-IP') || 'unknown'
}
// IPv6 按 /64 计：一个用户手里通常就是一整段 /64，逐个地址计数等于没限
function ipBucket(ip) {
  ip = String(ip || '')
  if (!ip.includes(':')) return ip
  const [head, tail] = ip.split('::')
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
  const g = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  return g.slice(0, 4).map(x => (x || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64'
}
const guardKey = (req, k) => new Request(new URL('/__guard/' + encodeURIComponent(k), req.url))
async function failRec(req) {
  const k = ipBucket(clientIP(req))
  let r = FAILS.get(k) || null
  if (!r && typeof caches !== 'undefined') {
    try { const c = await caches.default.match(guardKey(req, k)); if (c) r = await c.json() } catch (e) {}
  }
  // 窗口过了且没在锁定中，从头算
  if (r && !(r.until > Date.now()) && Date.now() - r.first > LOGIN_LOCK_SEC * 1000) r = null
  return { k, r }
}
// 进门检查。返回 { wait: 还要锁多少秒, done(ok) }：放行的请求先占一个名额再去算哈希，
// 校验完调 done 交还 —— 同一时刻并发 30 个错误密码，也只有前 5 个进得了门
async function loginGate(req) {
  const { k, r } = await failRec(req)
  if (r && r.until > Date.now()) return { wait: Math.ceil((r.until - Date.now()) / 1000) }
  const busy = PENDING.get(k) || 0
  if ((r ? r.n : 0) + busy >= LOGIN_MAX_FAIL) return { wait: 60 }
  PENDING.set(k, busy + 1)
  let used = false
  return { wait: 0, done: async ok => {
    if (used) return 0
    used = true
    PENDING.set(k, Math.max(0, (PENDING.get(k) || 1) - 1))
    if (ok) {
      if (FAILS.delete(k) || r) { if (typeof caches !== 'undefined') try { await caches.default.delete(guardKey(req, k)) } catch (e) {} }
      return LOGIN_MAX_FAIL
    }
    const cur = FAILS.get(k) || r
    const n = (cur ? cur.n : 0) + 1
    const rec = { n, first: cur ? cur.first : Date.now(), until: n >= LOGIN_MAX_FAIL ? Date.now() + LOGIN_LOCK_SEC * 1000 : 0 }
    if (FAILS.size > 5000) FAILS.clear()     // 别让内存无限涨
    FAILS.set(k, rec)
    if (typeof caches !== 'undefined') {
      try { await caches.default.put(guardKey(req, k), new Response(JSON.stringify(rec), { headers: { 'Cache-Control': 'max-age=' + LOGIN_LOCK_SEC * 2 } })) } catch (e) {}
    }
    return LOGIN_MAX_FAIL - n
  } }
}

// 会话密钥：首次访问时生成并落 KV
async function sessionSecret() {
  let s = await kvGet('auth:secret', null)
  if (!s) { s = randHex(32); await kvPut('auth:secret', s) }
  return s
}

async function makeCookie(secret) {
  const exp = Date.now() + 7 * 86400 * 1000
  const payload = String(exp)
  const sig = await hmac(secret || await sessionSecret(), payload)
  return `${payload}.${sig}`
}
// 轮换签名密钥：旧 cookie 全部作废。新 cookie 直接用刚生成的密钥签 ——
// KV 是最终一致的，写完马上再读，可能读回旧值，签出来的 cookie 立刻就失效
async function rotateSecret() {
  const s = randHex(32)
  await kvPut('auth:secret', s)
  return makeCookie(s)
}
// 只有本机调试（localhost 走 http）才去掉 Secure：Safari 不收 http 下的 Secure cookie。
// 线上即便有人用 http 访问，会话 cookie 也照样只走 https
function sessCookie(val, req) {
  const u = new URL(req.url)
  const local = u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)
  const secure = local ? '' : '; Secure'
  return val
    ? `sess=${val}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=604800`
    : `sess=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`
}

async function checkCookie(req) {
  if (!hasKV) return false          // 无 KV 时拿不到会话密钥，一律未登录
  const raw = req.headers.get('Cookie') || ''
  const m = raw.match(/(?:^|;\s*)sess=([^;]+)/)
  if (!m) return false
  let v = ''
  try { v = decodeURIComponent(m[1]) } catch (e) { return false }
  const [payload, sig] = v.split('.')
  if (!payload || !sig) return false
  if (!(Number(payload) > Date.now())) return false
  try {
    return safeEq(sig, await hmac(await sessionSecret(), payload))
  } catch (e) { return false }
}

// ---------- 上游订阅解析 ----------

// 按顶层逗号切分，跳过引号内和括号内的逗号。
// 双引号串里的 \" 是转义不是结束 —— 我们自己用 JSON.stringify 写出的值就带这种转义，
// 不认的话含引号的密码会在这里被切成两半。
function splitTop(s) {
  const out = []
  let buf = '', depth = 0, q = '', esc = false
  for (const ch of s) {
    if (q) {
      buf += ch
      if (esc) { esc = false; continue }
      if (q === '"' && ch === '\\') { esc = true; continue }
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

// 去掉 YAML 引号并还原转义。双引号串按 JSON 解（我们写出的值都是 JSON.stringify 的），
// 解不了（YAML 特有的 \x41 之类）就退回只剥引号；单引号串里 '' 代表一个 '。
function unquote(v) {
  v = String(v).trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { const s = JSON.parse(v); if (typeof s === 'string') return s } catch (e) {}
    return v.slice(1, -1)
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
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

// ---------- 分享链接 / 块式 YAML → Clash 节点 ----------
// 机场按 UA 给的格式天差地别：clash UA 给 YAML（有的单行 flow、有的块式缩进），
// 浏览器与 v2rayN UA 常给 base64 分享链接列表。三条路最终都落到同一种 kv 形状
// （键名用 Clash proxy 的字段名），下游 genClash / toSB / shareLink 才不用各认一套。

// flow 写法里以 - ? : 等开头、或含逗号花括号的值必须加引号，否则 YAML 解析器
// 会把它当成别的结构 —— reality 的 public-key 就常以 '-' 开头。机场原样给的
// YAML 自己带了引号，我们从分享链接造 kv 时得自己补。
// 除了结构字符，还有一类是「类型会变」：0888 / 1e5 / 0x1F 会被读成数字
// （Reality short-id 就栽在这上面），true / null / ~ 会被读成布尔和空值，
// *abc 是别名、&abc 是锚点、#abc 是注释。字符串语义的值碰到这些一律加引号。
const YAML_TYPED = /^(?:[-+]?[.\d]|(?:y|n|yes|no|on|off|true|false|null|~|\.inf|\.nan)$)/i
function flowVal(s) {
  const t = String(s)
  if (t === '') return "''"
  if (/^['"]/.test(t)) return t                                  // 已经带引号
  if (YAML_TYPED.test(t) || /^[-?:,[\]{}#&*!|>%@`=<\s]|[,{}[\]]|:\s|:$|\s#|\s$|[\x00-\x1f\x7f]/.test(t))
    return `'${t.replace(/'/g, "''")}'`
  return t
}

// 分享链接里取出来的字符串值一律写成 JSON 双引号串：逐条判断哪些值需要加引号，
// 迟早漏一种（*Abc 被当别名、#Abc 被当注释、0888 被当数字）。
// 只有端口、布尔这类我们自己校验过形状的字段不加。
const yq = v => JSON.stringify(String(v))
const yqOpt = v => (v === undefined || v === null || v === '') ? '' : yq(v)
const yqList = a => `[${a.map(yq).join(', ')}]`

// 对象 → YAML flow 映射字符串，嵌套递归。空对象返回 '' 表示该字段不写。
// 布尔要传真的 true（写成字符串 'true' 会被加引号，mihomo 解不成布尔），列表传数组。
function nestFlow(o) {
  const parts = []
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    const s = v === true ? 'true'
      : Array.isArray(v) ? (v.length ? `[${v.map(flowVal).join(', ')}]` : '')
      : (typeof v === 'object') ? nestFlow(v) : flowVal(v)
    if (s !== '') parts.push(`${k}: ${s}`)
  }
  return parts.length ? `{ ${parts.join(', ')} }` : ''
}

// nestFlow 的逆运算：`{ path: /x, headers: { Host: y } }` → 对象。
// 三种入站格式都把嵌套值归一成了这种 flow 写法，这里是唯一的反向出口。
// 值是 flow 列表（h2-opts.host、http-opts.path）时还原成数组。
function parseFlow(s) {
  const t = String(s || '').trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return {}
  const o = {}
  for (const pair of splitTop(t.slice(1, -1))) {
    const i = pair.indexOf(':')
    if (i < 0) continue
    const k = unquote(pair.slice(0, i).trim())
    if (!k) continue
    const v = pair.slice(i + 1).trim()
    o[k] = v.startsWith('{') ? parseFlow(v)
         : (v.startsWith('[') && v.endsWith(']')) ? splitTop(v.slice(1, -1)).map(unquote).filter(x => x !== '')
         : unquote(v)
  }
  return o
}

// URL.hostname 对 IPv6 会带方括号，Clash 的 server 字段要的是裸地址
function bareHost(h) {
  h = String(h || '')
  return (h.startsWith('[') && h.endsWith(']')) ? h.slice(1, -1) : h
}

// 分享链接的传输层参数 → Clash 的 network 与各 *-opts
function shareTransport(kv, q) {
  const net = String(q.type || q.net || 'tcp').toLowerCase()
  // URLSearchParams 已经解过一次码。有的生成器会把 path 再编码一层，所以这里仍解一次，
  // 但必须用 safeDecode：`path=%2F100%25` 解一次是 `/100%`，再 decodeURIComponent 就抛异常，
  // 以前这一条异常能把整个机场的解析一起带崩。
  const path = q.path ? safeDecode(q.path) : ''
  const host = String(q.host || '')
  const hosts = host.split(',').map(s => s.trim()).filter(Boolean)
  if (net === 'ws') {
    kv.network = 'ws'
    kv['ws-opts'] = nestFlow({ path: yq(path || '/'), headers: host ? { Host: yq(host) } : '' })
  } else if (net === 'httpupgrade') {
    // mihomo 没有单独的 httpupgrade，是 ws 加一个开关；丢了开关就是按 ws 握手，连不上
    kv.network = 'ws'
    kv['ws-opts'] = nestFlow({ path: yq(path || '/'), headers: host ? { Host: yq(host) } : '', 'v2ray-http-upgrade': true })
  } else if (net === 'grpc') {
    kv.network = 'grpc'
    const g = nestFlow({ 'grpc-service-name': yqOpt(q.serviceName || q.servicename || '') })
    if (g) kv['grpc-opts'] = g
  } else if (net === 'h2' || net === 'http') {
    kv.network = 'h2'
    // h2-opts.host 是列表，flow 写法里要带方括号
    const h = nestFlow({ path: yqOpt(path), host: hosts.map(yq) })
    if (h) kv['h2-opts'] = h
  } else if (net === 'xhttp' || net === 'splithttp') {
    kv.network = 'xhttp'
    const x = nestFlow({ path: yqOpt(path), host: yqOpt(host), mode: yqOpt(q.mode) })
    if (x) kv['xhttp-opts'] = x
  } else if ((net === 'tcp' || net === 'raw') && String(q.headerType || '').toLowerCase() === 'http') {
    // tcp + HTTP 伪装（vmess JSON 里的 "type":"http"）。丢了伪装头，服务端直接断开
    kv.network = 'http'
    const paths = (path || '/').split(',').map(s => s.trim()).filter(Boolean)
    kv['http-opts'] = nestFlow({ path: (paths.length ? paths : ['/']).map(yq), headers: hosts.length ? { Host: hosts.map(yq) } : '' })
  } else if (net !== 'tcp' && net !== 'raw' && net !== 'none' && net !== '') {
    kv.network = yq(net)          // quic / kcp 等，原样带过去，别丢
  }
}

// TLS 相关参数三家共用（vless / trojan / 部分 vmess）
function shareTLS(kv, q, sniKey) {
  const sec = String(q.security || q.tls || '').toLowerCase()
  if (sec && sec !== 'none') kv.tls = 'true'
  if (q.sni || q.peer) kv[sniKey] = yq(q.sni || q.peer)
  if (q.fp) kv['client-fingerprint'] = yq(q.fp)
  const alpn = q.alpn ? safeDecode(q.alpn).split(',').map(s => s.trim()).filter(Boolean) : []
  if (alpn.length) kv.alpn = yqList(alpn)
  if (q.insecure === '1' || q.insecure === 'true' || q.allowInsecure === '1' || q.allowInsecure === 'true')
    kv['skip-cert-verify'] = 'true'
  if (sec === 'reality') {
    const r = nestFlow({ 'public-key': yqOpt(q.pbk), 'short-id': yqOpt(q.sid) })
    if (r) kv['reality-opts'] = r
  }
}

// ss:// 有两种写法：SIP002 的 base64(method:password)@host:port，
// 以及老客户端的整串 base64(method:password@host:port)
function parseSSBody(body) {
  let s = String(body || '')
  // 整串 base64 的老格式，padding 可能被编码成 %3D
  if (!s.includes('@')) s = b64decode(safeDecode(s))
  const at = s.lastIndexOf('@')
  if (at < 0) return null
  // SIP002 对 2022-blake3 推荐的明文写法是百分号编码的 method:password（%2B、%3D 都得还原），
  // base64 写法的 padding 也常被编码成 %3D —— 两种都要先解码，再判断是哪一种
  let cred = safeDecode(s.slice(0, at))
  const hostport = s.slice(at + 1).replace(/[/?#].*$/, '')
  if (!cred.includes(':')) cred = b64decode(cred)
  const ci = cred.indexOf(':')
  if (ci < 0) return null
  const pi = hostport.lastIndexOf(':')
  if (pi < 0) return null
  const port = hostport.slice(pi + 1)
  if (!/^\d+$/.test(port)) return null
  return {
    cipher: cred.slice(0, ci), password: cred.slice(ci + 1),
    server: bareHost(hostport.slice(0, pi)), port
  }
}

// SIP003 插件串（`obfs-local;obfs=http;obfs-host=x`，; = \ 用反斜杠转义）→ Clash 的 plugin + plugin-opts。
// 返回 undefined 表示没有插件；null 表示有插件但认不出 —— 调用方应整条丢弃：
// 服务端挂着插件，客户端不带插件直连，这个节点只会一直超时。
function ssPlugin(str) {
  const s = String(str || '').trim()
  if (!s) return undefined
  const seg = [], unesc = x => x.replace(/\\(.)/g, '$1')
  let buf = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { buf += s[i] + s[++i]; continue }
    if (s[i] === ';') { seg.push(buf); buf = ''; continue }
    buf += s[i]
  }
  seg.push(buf)
  const name = unesc(seg.shift()).trim().toLowerCase()
  const o = {}
  for (const p of seg) {
    const m = p.match(/^((?:\\.|[^=\\])*)(?:=(.*))?$/)
    if (m && m[1]) o[unesc(m[1]).trim()] = m[2] === undefined ? '' : unesc(m[2])
  }
  if (!name || name === 'none') return undefined
  if (name === 'obfs-local' || name === 'simple-obfs' || name === 'obfs') {
    const mode = String(o.obfs || 'http').toLowerCase()
    if (mode !== 'http' && mode !== 'tls') return null
    return { plugin: 'obfs', opts: nestFlow({ mode: yq(mode), host: yqOpt(o['obfs-host']) }) }
  }
  if (name === 'v2ray-plugin') {
    // mihomo 的 v2ray-plugin 只有 websocket 模式
    if (String(o.mode || 'websocket').toLowerCase() !== 'websocket') return null
    const flag = k => k in o && !/^(0|false)$/i.test(o[k])
    return { plugin: 'v2ray-plugin', opts: nestFlow({
      mode: yq('websocket'), tls: flag('tls'), host: yqOpt(o.host), path: yqOpt(o.path),
      mux: flag('mux') && (o.mux === '' || Number(o.mux) > 0)
    }) }
  }
  return null
}

// userinfo 原样取出再整体解码。URL 对象会在第一个冒号处把它拆成 username / password，
// 而 trojan / anytls 的密码可以含冒号，hysteria2 的 userpass 认证更是规定 user:pass 整串就是密码。
function shareUserinfo(raw) {
  const rest = raw.slice(raw.indexOf('://') + 3)
  const end = rest.search(/[/?#]/)
  const auth = end < 0 ? rest : rest.slice(0, end)
  const at = auth.lastIndexOf('@')
  return at < 0 ? '' : safeDecode(auth.slice(0, at))
}

// 一行分享链接 → 与 parseProxyLine 同形状的 kv；认不出返回 null。
// 任何一条链接抛异常都只能丢掉它自己：以前一条坏链接能让整个机场解析失败、
// 添加自有节点的解析接口直接 500。
function parseShareLine(line) {
  try { return parseShareLineRaw(line) } catch (e) { return null }
}

function parseShareLineRaw(line) {
  let raw = String(line).trim()
  const si = raw.indexOf('://')
  if (si < 1) return null
  const scheme = raw.slice(0, si).toLowerCase()
  const kv = {}
  let tag = ''
  const done = (host, port) => {
    const nm = tag || `${host}:${port}`
    kv.name = yq(nm)
    kv._name = nm
    return kv
  }

  if (scheme === 'vmess') {
    // 绝大多数是 base64(JSON)；少数新客户端写成 URL 形式，交给下面的通用分支
    const body = raw.slice(si + 3)
    if (!body.includes('@')) {
      let j = null
      try { j = JSON.parse(b64decode(safeDecode(body.split('#')[0]))) } catch (e) { return null }
      if (!j || !j.add || !j.port) return null
      const port = String(parseInt(j.port, 10))
      if (!/^\d+$/.test(port) || !j.id) return null
      tag = String(j.ps || j.remark || '')
      const server = bareHost(String(j.add))
      Object.assign(kv, {
        type: 'vmess', server: yq(server), port,
        uuid: yq(j.id), alterId: String(parseInt(j.aid, 10) || 0),
        cipher: yq(j.scy || j.security || 'auto'), udp: 'true'
      })
      // 3x-ui 会写 "tls":"none"，以前只看非空就开了 TLS，节点必然握手失败
      if (String(j.tls || '').toLowerCase() === 'tls') kv.tls = 'true'
      if (j.sni) kv.servername = yq(j.sni)
      if (j.fp) kv['client-fingerprint'] = yq(j.fp)
      if (j.alpn) { const a = String(j.alpn).split(',').map(s => s.trim()).filter(Boolean); if (a.length) kv.alpn = yqList(a) }
      shareTransport(kv, { type: j.net, headerType: j.type, path: j.path ? encodeURIComponent(j.path) : '', host: j.host, serviceName: j.path, mode: j.mode })
      return done(server, port)
    }
  }

  if (scheme === 'ss') {
    const hi = raw.indexOf('#')
    const rest = raw.slice(si + 3, hi < 0 ? undefined : hi)
    const qi = rest.indexOf('?')
    const p = parseSSBody((qi < 0 ? rest : rest.slice(0, qi)).replace(/\/$/, ''))
    if (!p || !p.server || !p.port) return null
    tag = hi < 0 ? '' : safeDecode(raw.slice(hi + 1))
    Object.assign(kv, { type: 'ss', server: yq(p.server), port: p.port, cipher: yq(p.cipher), password: yq(p.password), udp: 'true' })
    const pl = ssPlugin(qi < 0 ? '' : new URLSearchParams(rest.slice(qi + 1)).get('plugin'))
    if (pl === null) return null
    if (pl) { kv.plugin = pl.plugin; if (pl.opts) kv['plugin-opts'] = pl.opts }
    return done(p.server, p.port)
  }

  // hysteria2 的端口段可以是 443,20000-30000（端口跳跃），也可以干脆省略（默认 443）。
  // 这两种 URL 解析器都不认，以前整条链接直接丢了。先把端口段摘出来。
  let hyPorts = ''
  if (scheme === 'hysteria2' || scheme === 'hy2') {
    const rest = raw.slice(si + 3)
    const end = rest.search(/[/?#]/)
    const auth = end < 0 ? rest : rest.slice(0, end)
    const at = auth.lastIndexOf('@')
    const hp = auth.slice(at + 1)
    const rb = hp.startsWith('[') ? hp.indexOf(']') : -1
    const ci = hp.indexOf(':', rb + 1)
    const hostPart = ci < 0 ? hp : hp.slice(0, ci)
    const spec = ci < 0 ? '' : hp.slice(ci + 1)
    if (!/^[\d,-]*$/.test(spec)) return null
    const first = (spec.match(/^\d+/) || ['443'])[0]
    if (spec && spec !== first) hyPorts = spec
    raw = raw.slice(0, si + 3) + auth.slice(0, at + 1) + hostPart + ':' + first + (end < 0 ? '' : rest.slice(end))
  }

  let u = null
  try { u = new URL(raw) } catch (e) { return null }
  const host = bareHost(u.hostname), port = u.port
  if (!host || !port) return null
  const q = {}
  u.searchParams.forEach((v, k) => { q[k] = v })
  tag = safeDecode(u.hash.slice(1))
  const user = safeDecode(u.username)
  const whole = shareUserinfo(raw)

  if (scheme === 'vless') {
    if (!user) return null
    Object.assign(kv, { type: 'vless', server: yq(host), port, uuid: yq(user), udp: 'true' })
    if (q.flow) kv.flow = yq(q.flow)
    shareTLS(kv, q, 'servername')
    shareTransport(kv, q)
  } else if (scheme === 'vmess') {
    if (!user) return null
    Object.assign(kv, { type: 'vmess', server: yq(host), port, uuid: yq(user), alterId: String(parseInt(q.aid, 10) || 0), cipher: yq(q.scy || q.encryption || 'auto'), udp: 'true' })
    shareTLS(kv, q, 'servername')
    shareTransport(kv, q)
  } else if (scheme === 'trojan') {
    if (!whole) return null
    Object.assign(kv, { type: 'trojan', server: yq(host), port, password: yq(whole), udp: 'true' })
    shareTLS(kv, q, 'sni')
    shareTransport(kv, q)
  } else if (scheme === 'hysteria2' || scheme === 'hy2') {
    // `:pass@` 这种只写了 password 的，照旧取 password
    const pwd = whole.startsWith(':') ? whole.slice(1) : whole
    Object.assign(kv, { type: 'hysteria2', server: yq(host), port, password: yq(pwd) })
    if (q.sni || q.peer) kv.sni = yq(q.sni || q.peer)
    if (q.insecure === '1' || q.insecure === 'true') kv['skip-cert-verify'] = 'true'
    // 混淆类型和密码缺一不可：mihomo 见到 obfs 却没有密码会拒绝加载整份配置
    if (q.obfs && q.obfs !== 'none' && q['obfs-password']) { kv.obfs = yq(q.obfs); kv['obfs-password'] = yq(q['obfs-password']) }
    const ports = hyPorts || q.mport || ''
    if (/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(ports)) kv.ports = yq(ports)         // 端口跳跃
  } else if (scheme === 'tuic') {
    Object.assign(kv, { type: 'tuic', server: yq(host), port, uuid: yq(user), password: yq(safeDecode(u.password)), udp: 'true' })
    if (q.sni) kv.sni = yq(q.sni)
    if (q.congestion_control) kv['congestion-controller'] = yq(q.congestion_control)
    const alpn = q.alpn ? safeDecode(q.alpn).split(',').map(s => s.trim()).filter(Boolean) : []
    if (alpn.length) kv.alpn = yqList(alpn)
    if (q.allow_insecure === '1' || q.insecure === '1') kv['skip-cert-verify'] = 'true'
  } else if (scheme === 'anytls') {
    if (!whole) return null
    Object.assign(kv, { type: 'anytls', server: yq(host), port, password: yq(whole), udp: 'true' })
    if (q.sni) kv.sni = yq(q.sni)
    if (q.insecure === '1' || q.allowInsecure === '1') kv['skip-cert-verify'] = 'true'
  } else return null

  return done(host, port)
}

// 分享链接里的 name 常有非法转义，decodeURIComponent 会整条抛掉
function safeDecode(s) {
  try { return decodeURIComponent(String(s || '')) } catch (e) { return String(s || '') }
}

const indentOf = l => l.length - l.replace(/^[ \t]+/, '').length

// 映射键后面的冒号：必须跟空白或在行尾（`url: http://x`、`server: 2001:db8::1` 里后面那些不算）
function keyColon(t) {
  let i = 0
  if (t[0] === '"' || t[0] === "'") {
    for (i = 1; i < t.length; i++) { if (t[0] === '"' && t[i] === '\\') { i++; continue } if (t[i] === t[0]) break }
    i++
  }
  for (; i < t.length; i++) if (t[i] === ':' && (i + 1 === t.length || /\s/.test(t[i + 1]))) return i
  return -1
}

// 去掉行尾注释：引号外、前面是空白的 #。以前注释会跟着值一起进 kv，密码后面挂一截「# 备用」
function stripComment(v) {
  let q = '', prev = ''
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (q) {
      if (q === '"' && c === '\\') { i++; continue }
      if (c === q) { if (q === "'" && v[i + 1] === "'") { i++; continue } q = ''; prev = c }
      continue
    }
    if ((c === '"' || c === "'") && (prev === '' || /[:,[{]/.test(prev))) { q = c; continue }
    if (c === '#' && i > 0 && /\s/.test(v[i - 1])) return v.slice(0, i).trimEnd()
    if (!/\s/.test(c)) prev = c
  }
  return v
}

// 块写法里的标量挪进 flow 写法：引号串、flow 集合原样；plain 标量只有带了 , [ ] { } 才要加引号
// （块里它们是普通字符，flow 里是结构符）。类型保持不变 —— 2048 还是数字，true 还是布尔。
function flowScalar(v) {
  if (/^["'[{]/.test(v)) return v
  return /[,[\]{}]/.test(v) ? `'${v.replace(/'/g, "''")}'` : v
}

// 缩进块 → flow 字符串。块式 YAML 里 ws-opts / reality-opts 是多层缩进，
// 收成 flow 后与单行格式的值形状一致，下游读法就只有一种。
// 值也可能是列表：yaml.v2 / PyYAML 默认把列表项写得和父键同缩进（`alpn:` 下一行就是同缩进的
// `- h2`），以前把它当成「下一个节点」，这个节点后面的 tls / servername / reality-opts 全丢了。
function collectFlow(lines, i, base, mapOnly) {
  const skip = l => !l.trim() || /^\s*#/.test(l)
  let j = i
  while (j < lines.length && skip(lines[j])) j++
  if (j >= lines.length) return { flow: '', next: j }
  const ind0 = indentOf(lines[j]), t0 = lines[j].trim()
  const isItem = t => t === '-' || t.startsWith('- ')
  if (!mapOnly && isItem(t0) && ind0 >= base) {
    const items = []
    while (j < lines.length) {
      const l = lines[j]
      if (skip(l)) { j++; continue }
      const ind = indentOf(l), t = l.trim()
      if (ind < ind0 || (ind === ind0 && !isItem(t))) break
      if (ind > ind0) { j++; continue }
      const body = stripComment(t.slice(1).trim())
      const ci = /^["'[{]/.test(body) ? -1 : keyColon(body)
      if (ci > 0) {
        // 映射形式的列表项：`- k: v`，后面缩进更深的行是同一项的其它键
        // （只收映射：同缩进的下一个 `- ` 是兄弟项，不能被当成这一项的子列表）
        const sub = collectFlow(lines, j + 1, ind, true)
        const v = stripComment(body.slice(ci + 1).trim())
        const own = v ? `${body.slice(0, ci).trim()}: ${flowScalar(v)}` : ''
        const rest = sub.flow.startsWith('{') ? sub.flow.slice(2, -2) : ''
        items.push(`{ ${[own, rest].filter(Boolean).join(', ')} }`)
        j = sub.next
      } else {
        if (body) items.push(flowScalar(body))
        j++
      }
    }
    return { flow: items.length ? `[${items.join(', ')}]` : '', next: j }
  }
  const parts = []
  while (j < lines.length) {
    const l = lines[j]
    if (skip(l)) { j++; continue }
    const ind = indentOf(l)
    if (ind <= base) break
    const t = l.trim()
    const ci = keyColon(t)
    if (ci < 0 || isItem(t)) { j++; continue }
    const k = t.slice(0, ci).trim(), v = stripComment(t.slice(ci + 1).trim())
    if (v) { parts.push(`${k}: ${flowScalar(v)}`); j++ }
    else {
      const sub = collectFlow(lines, j + 1, ind)
      if (sub.flow) parts.push(`${k}: ${sub.flow}`)
      j = sub.next
    }
  }
  return { flow: parts.length ? `{ ${parts.join(', ')} }` : '', next: j }
}

// 块式节点：`- name: x` 起头，后续更深缩进的行都属于它。v2board 系常见这种。
function parseBlockNode(lines, i) {
  const head = lines[i]
  const base = indentOf(head)
  const first = head.replace(/^[ \t]*-[ \t]*/, '')
  const fi = keyColon(first)
  if (fi < 0) return { node: null, next: i + 1 }
  const obj = {}
  const v0 = stripComment(first.slice(fi + 1).trim())
  let j = i + 1
  if (v0) obj[unquote(first.slice(0, fi).trim())] = v0
  else { const sub = collectFlow(lines, j, base + (head.length - base - first.length)); if (sub.flow) obj[unquote(first.slice(0, fi).trim())] = sub.flow; j = sub.next }
  while (j < lines.length) {
    const l = lines[j]
    if (!l.trim() || /^\s*#/.test(l)) { j++; continue }
    const ind = indentOf(l)
    if (ind <= base) break                       // 同级或更浅 → 本块结束（下一个节点、下一个顶层键）
    const t = l.trim()
    const ci = keyColon(t)
    // 更深缩进的 `- xxx` 只可能是某个字段的列表项，已经在 collectFlow 里收走了；
    // 孤立出现的（上一个键没接住）跳过，不能当成节点结束
    if (ci < 0 || t === '-' || t.startsWith('- ')) { j++; continue }
    const k = unquote(t.slice(0, ci).trim()), v = stripComment(t.slice(ci + 1).trim())
    if (v) { obj[k] = v; j++ }
    else { const sub = collectFlow(lines, j + 1, ind); if (sub.flow) obj[k] = sub.flow; j = sub.next }
  }
  if (!obj.name || !obj.type) return { node: null, next: j }
  obj._name = unquote(obj.name)
  return { node: obj, next: j }
}

// ---------- 机场元信息解析（流量 / 到期）----------
// 各家机场给法不一：多数走 Subscription-Userinfo 头，也有只把信息塞进节点名当公告的，
// 还有两者都给但单位、日期格式各异。这里三路都认，头优先、公告兜底。

const SZ = { b:1, kb:1024, mb:1048576, gb:1073741824, tb:1099511627776, pb:1125899906842624 }
function toBytes(n, unit) {
  const u = String(unit || 'gb').toLowerCase().replace(/i?b?$/, '') + 'b'
  return Math.round(Number(n) * (SZ[u] || SZ.gb))
}

// 有的机场无视 clash UA，直接吐 base64 分享链接列表
function looksBase64(s) {
  const t = String(s).replace(/\s/g, '')
  return t.length > 32 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(t)
}
function b64decode(s) {
  try {
    const bin = atob(String(s).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/'))
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))
  } catch (e) { return '' }
}

// 诊断样本要给人看，但订阅原文里全是密钥，先抹掉再回显
function scrub(line) {
  return String(line)
    .replace(/([?&](?:token|password|uuid|auth|key|secret|obfs-password)=)[^&\s"']+/gi, '$1***')
    .replace(/\b((?:password|uuid|auth-?str|psk|token|secret|private-key|obfs-password)\s*[:=]\s*)["']?[\w.@:+/=-]{6,}/gi, '$1***')
    .replace(/(\/\/)[^@\s/]{8,}(@)/g, '$1***$2')
    .slice(0, 200)
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

// 一条已解析出的 kv 该收进节点还是公告
// Reality 的公钥必须是 32 字节的 base64url（恰好 43 位、不带 =），short-id 是至多 16 位、
// 位数为偶数的十六进制 —— mihomo 与 sing-box 都这么解码。格式不对的节点只要有一个，
// mihomo 就拒绝加载整份配置（invalid REALITY public key），不是跳过那一个。
function realityOk(pk, sid) {
  return /^[A-Za-z0-9_-]{43}$/.test(String(pk || '')) && /^([0-9a-fA-F]{2}){0,8}$/.test(String(sid || ''))
}

function takeNode(p, nodes, notes) {
  if (/^(select|url-test|fallback|load-balance|relay)$/.test(unquote(p.type || ''))) return   // proxy-group
  // 公告条目不是节点，但流量/到期常藏在里面，先留作兜底解析
  if (JUNK.test(p._name) || unquote(p.server || '') === '127.0.0.1') { notes.push(p._name); return }
  // 机场给了一个公钥写坏的 Reality 节点：留着它整份订阅都加载不了，少它一个还能用
  if (!nodeUsable(p)) return
  nodes.push(p)
}
function nodeUsable(kv) {
  if (!kv || kv['reality-opts'] === undefined) return true
  const r = parseFlow(kv['reality-opts'])
  return realityOk(r['public-key'], r['short-id'])
}

// 把订阅原文切成「节点行」与「公告行」。正式拉取与诊断共用，
// 否则两边各写一遍，诊断说能解析、实际拉取却是空的，白折腾。
//
// 三种入站格式在这里汇合：单行 flow YAML、块式 YAML、分享链接列表。
// 机场按 UA 给哪种是它的自由，我们不能只认一种 —— 只认一种的后果是
// 换个 UA 重试、粘贴导入这些退路全都走不通。
function splitFeed(text) {
  const nodes = [], notes = []
  const lines = text.split('\n')
  let inProxies = false, seenYamlKey = false, seenProxies = false, skipping = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 顶层键：proxies 段之外的 YAML 段落里没有节点。
    // 负向断言不能省 —— `vless://…` 这样的分享链接同样是「字母 + 冒号」开头，
    // 少了它整份 base64 订阅会被逐行当成 YAML 段名跳过，一个节点都解析不出来。
    if (/^[a-zA-Z"'][\w"'-]*\s*:(?!\/\/)/.test(line)) {
      seenYamlKey = true
      // rules 通常有上万行，既没有节点也没有公告。免费版 Workers 单次请求
      // 只有 10ms CPU，白扫这一段就能把预算耗光。
      // 但只有 proxies 段已经读过才能停：proxy-providers / rule-providers / listeners
      // 排在 proxies 前面的配置并不少见，以前扫到它们就停，节点一个都没解析出来。
      // 还没读到 proxies 时这几段整段跳过，不逐行过公告正则。
      const big = /^(rules|rule-providers|proxy-providers|sub-rules|listeners)\s*:/.test(line)
      if (big && seenProxies) break
      skipping = big
      inProxies = /^proxies\s*:/.test(line)
      if (inProxies) seenProxies = true
      i++
      continue
    }
    if (skipping) { i++; continue }
    const t0 = line.trim()
    // 分享链接列表：整份订阅可能一行一个，也可能混在 YAML 注释里
    if (t0.includes('://') && !/^[#;]/.test(t0)) {
      const s = parseShareLine(t0)
      if (s) { takeNode(s, nodes, notes); i++; continue }
    }
    if (inProxies || !seenYamlKey) {
      const p = parseProxyLine(line)
      if (p) { takeNode(p, nodes, notes); i++; continue }
      // 块式：`- name: x` 起头，字段分散在后续缩进行里
      if (/^[ \t]*-[ \t]*[\w"']/.test(line)) {
        const b = parseBlockNode(lines, i)
        if (b.node) { takeNode(b.node, nodes, notes); i = b.next; continue }
        if (b.next > i + 1) { i = b.next; continue }   // 是个块但缺 name/type，整块跳过
      }
    }
    // 公告不一定是节点行。有的机场写成 YAML 注释（# 剩余流量：xxx），
    // 有的直接是裸文本行 —— 这些 parseProxyLine 一律返回 null，
    // 以前连同真正的垃圾行一起丢掉，用量与到期就此丢失。
    const t = line.replace(/^\s*[#;]+\s*/, '').replace(/^\s*-\s*/, '').trim()
    if (t && t.length < 120 && JUNK.test(t)) notes.push(t)
    i++
  }
  return { nodes, notes }
}

// 单次拉取。只带一个 User-Agent 的裸请求在不少 WAF 眼里就是脚本，
// 常见头补齐能少挨一部分拦截。Accept-Encoding 不设 —— Workers 平台自己管压缩，
// 手工指定会被忽略。
async function fetchRaw(url, ua, ms) {
  const headers = { 'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
  if (ua) headers['User-Agent'] = ua
  const opt = { headers, redirect: 'follow', cf: { cacheTtl: 0 } }
  // 机场超时不能拖死整个请求：Workers 免费版壁钟也有限
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(ms || UP_TIMEOUT)
  return await fetch(url, opt)
}

// 诊断用：这份原文是什么格式。判断顺序要先看解码后的内容，
// 否则纯 base64 的 Clash YAML 会被认成分享链接列表。
function feedFormat(raw, decoded) {
  return /^\s*(proxies:|port:|mixed-port:|mode:)/m.test(decoded) ? 'Clash YAML'
       : /"outbounds"\s*:/.test(decoded) ? 'sing-box JSON'
       : looksBase64(raw) ? 'base64 分享链接'
       : /:\/\//.test(decoded) ? '明文分享链接' : '未识别'
}

// 订阅原文 → 节点与元信息。拉取与粘贴导入共用这一套，
// 否则两边解析能力不一致，粘进来的东西反而解不出来。
function feedParse(raw, userinfoHeader, u) {
  const text = looksBase64(raw) ? b64decode(raw) : raw   // 有的机场无视 UA 直接吐 base64
  const { nodes, notes } = splitFeed(text)
  const out = nodes.map(p => ({
    up: u.id, upName: u.name, raw: p._name, kv: p,
    region: regionOf(p._name)
  }))
  return { nodes: out, info: mergeMeta(parseUserinfo(userinfoHeader), parseNotes(notes)) }
}

// 拦截页的正文往往写着到底是谁拦的（Cloudflare 的 1020、机场自己的限流提示）。
// 只把状态码抛出去的话，用户拿到一个光秃秃的 403，无从判断下一步该做什么。
async function errBody(r) {
  try {
    const t = await r.text()
    return scrub(t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 160)
  } catch (e) { return '' }
}

function triesMsg(tries) {
  if (!tries.length) return '未发起请求'
  if (tries.every(t => t.status >= 200 && t.status < 300))
    return `换了 ${tries.length} 种客户端身份都能访问，但都没解析出节点`
  const seen = new Set(), parts = []
  for (const t of tries) {
    const k = t.err || ('HTTP ' + t.status)
    if (seen.has(k)) continue
    seen.add(k)
    parts.push(t.body ? `${k}（${t.body}）` : k)
  }
  return parts.join('；')
}

// 分享链接 → 自有节点的表单字段。复用 parseShareLine，避免前后端各写一套解析：
// 那样迟早出现「订阅里能认、手动添加却认不出」这种自相矛盾。
function shareToOwn(link) {
  const kv = parseShareLine(String(link || '').trim())
  if (!kv) return null
  const v = k => kv[k] === undefined ? '' : unquote(kv[k])
  const t = v('type')
  if (t !== 'vless' && t !== 'hysteria2')
    return { err: `这条链接是 ${t} 协议，自有节点目前只支持 VLESS Reality 与 Hysteria2` }
  const o = { name: kv._name || '', type: t, s: v('server'), p: v('port') }
  if (t === 'vless') {
    o.u = v('uuid')
    o.sni = v('servername') || v('sni')
    const ro = parseFlow(v('reality-opts'))
    o.pk = ro['public-key'] || ''
    o.sid = ro['short-id'] || ''
    const net = v('network')
    // WebSocket + TLS（常见的套 CDN 方案）也是自有节点支持的形态；以前一律当成 tcp，
    // 导进来就变成一个要 Reality 公钥、根本连不上的节点
    o.net = net === 'xhttp' ? 'xhttp' : net === 'ws' && !o.pk ? 'ws' : 'tcp'
    o.flow = o.net === 'tcp' ? (v('flow') || 'xtls-rprx-vision') : ''
    if (o.net === 'ws') {
      const w = parseFlow(v('ws-opts'))
      o.path = w.path || '/'
      o.host = (w.headers && (w.headers.Host || w.headers.host)) || ''
    } else if (!o.pk) o.warn = '这条链接里没有 Reality 公钥（pbk），保存前要手动补上'
  } else {
    o.u = v('password')
    o.sni = v('sni') || v('servername')
    o.obfs = v('obfs') || ''
    o.opwd = v('obfs-password') || ''
    o.ports = v('ports') || ''
  }
  return { node: o }
}

// 人工粘贴进来的订阅原文。和网络拉取共用 feedParse —— 两边各写一套解析的话，
// 迟早出现「诊断说能解析、粘进来却是空的」这种自相矛盾。
// 少的只是 subscription-userinfo 响应头，用量与到期只能从公告文本里捡。
function parsePasted(text, u) {
  const t = String(text || '').trim()
  if (!t) return { err: '粘贴的内容是空的' }
  const got = feedParse(t, null, u)
  if (!got.nodes.length)
    return { err: '粘贴的内容里没解析出任何节点 —— 确认复制的是订阅内容本身（一大段 base64 或 YAML），不是机场的网页' }
  return { got }
}

// 拉一个机场，返回原始节点（未重命名）与订阅元信息。
// 逐个 UA 试，取第一个「能访问且真的解析出节点」的结果 —— 只看 2xx 不够，
// 机场对不同 UA 回的格式不同，有的那一份里根本没有节点。
async function fetchUpstream(u) {
  // 粘贴导入的源没有可重拉的链接，平时靠快照供节点。快照万一没了也别去 fetch 空串。
  if (!/^https?:\/\//.test(u.url || '')) throw new Error('这个源没有订阅链接，只有粘贴导入的快照')
  const tries = []
  // 单个机场的总预算：一个挂掉的机场挨个 UA 等超时，会把整轮刷新拖过 waitUntil 的上限
  const end = Date.now() + UP_BUDGET
  let cut = 0
  for (const ua of UPSTREAM_UAS) {
    const left = end - Date.now()
    if (left < 1000) { cut = UPSTREAM_UAS.length - tries.length; break }
    let r = null
    try {
      r = await fetchRaw(u.url, ua, Math.min(UP_TIMEOUT, left))
      if (!r.ok) { tries.push({ ua, status: r.status, body: await errBody(r) }); continue }
      const raw = await r.text()
      const got = feedParse(raw, r.headers.get('subscription-userinfo'), u)
      tries.push({ ua, status: r.status, n: got.nodes.length })
      if (got.nodes.length) return { ...got, tries }
    } catch (e) { tries.push({ ua, err: String(e && e.message || e) }) }
  }
  throw new Error(triesMsg(tries) + (cut ? `；超出单个机场 ${UP_BUDGET / 1000} 秒的时间预算，其余 ${cut} 种客户端身份没有再试` : ''))
}

// 每个源单独留一份最后成功拉取的快照。
// 两个用处：一次性链接（有效期几分钟的那种）平时就靠它供节点；
// 普通源临时抽风时也用它兜底，不至于节点凭空消失。
async function saveSnap(id, r, event) {
  if (!hasKV) return
  const p = CONF.put('snap:' + id, JSON.stringify({ at: Date.now(), nodes: r.nodes, info: r.info }))
  if (event && event.waitUntil) event.waitUntil(p); else await p
}

// 拉全部启用的机场，写缓存；失败退回快照或 stale
async function loadNodes(force, event) {
  const cached = await kvGet('cache:nodes', null)
  if (!force && cached && Date.now() - cached.at < FRESH_TTL * 1000) return cached

  const ups = (await kvGet('upstreams', [])).filter(u => u.enabled !== false)
  if (!ups.length) return { at: Date.now(), nodes: [], errors: [] }

  // 各机场并行拉。以前逐个机场、逐个 UA 串行，每次 15 秒超时，后台刷新会被 waitUntil
  // 的 30 秒上限截断，排在后面的机场永远刷不到。每个机场的结果先各自收好，
  // 最后按订阅源顺序拼 —— 节点顺序是订阅源顺序，不是谁先拉完
  const pull = async u => {
    const got = { nodes: [], errors: [], meta: null, snap: 0 }
    const useSnap = async why => {
      const s = await kvGet('snap:' + u.id, null)
      if (!s || !s.nodes || !s.nodes.length) return false
      // 快照里的 region 是抓取当时算的。地区表更新后必须重算，
      // 否则老快照会把节点永远钉死在旧分类上（改了识别规则也不生效）。
      got.nodes = s.nodes.map(n => ({ ...n, region: regionOf(n.raw) }))
      if (s.info) got.meta = s.info
      got.snap = s.at
      if (why) got.errors.push({ id: u.id, up: u.name, msg: why + ' — 已沿用快照' })
      return true
    }
    // 一次性链接反复拉必然失败，平时根本不该去请求它
    // （还没有快照就仍拉一次，否则这个源永远是空的）
    if (u.auto === false && await useSnap('')) return got
    try {
      const r = await fetchUpstream(u)
      if (!r.nodes.length) { got.errors.push({ id: u.id, up: u.name, msg: '解析结果为空' }); return got }
      got.nodes = r.nodes
      if (r.info) got.meta = r.info
      await saveSnap(u.id, r, event)
    } catch (e) {
      if (!await useSnap(String(e.message || e))) got.errors.push({ id: u.id, up: u.name, msg: String(e.message || e) })
    }
    return got
  }
  const all = await Promise.all(ups.map(pull))
  const nodes = [], errors = [], meta = {}, snaps = {}
  ups.forEach((u, i) => {
    nodes.push(...all[i].nodes)
    errors.push(...all[i].errors)
    if (all[i].meta) meta[u.id] = all[i].meta
    if (all[i].snap) snaps[u.id] = all[i].snap
  })

  // 全部失败且有旧缓存时，宁可用旧的也不下发空订阅
  if (!nodes.length && cached && cached.nodes.length) {
    return { ...cached, errors, stale: true }
  }

  const data = { at: Date.now(), nodes, errors, meta, snaps }
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

// 两个源起了同一个名字时，节点名会撞车 —— Clash 要求 proxies 名唯一，
// 重名会让客户端只认其中一个。按出现顺序给重名的机场补个序号区分。
function upLabels(nodes) {
  const ids = {}
  for (const n of nodes) {
    const nm = String(n.upName || '')
    const list = ids[nm] || (ids[nm] = [])
    if (!list.includes(n.up)) list.push(n.up)
  }
  const out = {}
  for (const nm of Object.keys(ids)) {
    ids[nm].forEach((id, i) => { out[id] = ids[nm].length > 1 ? `${nm} ${i + 1}` : nm })
  }
  return out
}

function applyNaming(nodes, overrides) {
  // 旧版解析器存下的缓存、一次性链接的快照里，可能还躺着 takeNode 如今会剔掉的节点 ——
  // 快照可能几个月都不刷新，所以取出来用的时候再过一道
  nodes = nodes.filter(n => nodeUsable(n.kv))
  const seq = {}
  const label = upLabels(nodes)
  const out = nodes.map(n => {
    const k = nodeKey(n)
    const ov = overrides[k] || {}
    const r = REGIONS.find(x => x.key === n.region) || REGIONS[REGIONS.length - 1]
    // 序号按「机场 + 地区」各排各的，而不是全地区连号：
    // 一眼看得出某家机场在某个地区有几个节点，加了源、删了源也不会牵动别家的编号。
    const sk = `${n.up}::${n.region}`
    seq[sk] = (seq[sk] || 0) + 1
    const src = label[n.up] || n.upName || ''
    const auto = `${r.flag} ${r.cn} ${String(seq[sk]).padStart(2, '0')}${src ? ' · ' + src : ''}`
    return { ...n, key: k, name: ov.name || auto, auto, custom: !!ov.name, off: !!ov.off }
  })
  // 最终名字必须全局唯一：同一机场里两条原名相同的节点，覆盖名是按「机场::原名」记的，
  // 会一起改成同一个名字；自定义名也可能撞上别的节点。Clash / sing-box 遇到重名直接拒绝整份配置。
  // 按出现顺序，第二个起补「 2」「 3」…；停用的节点不下发，不占名字。
  const used = new Set()
  for (const n of out) {
    if (n.off) continue
    let nm = n.name
    for (let i = 2; used.has(nm); i++) nm = `${n.name} ${i}`
    used.add(nm)
    n.name = nm
  }
  return out
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

// 显式 fmt 优先，否则按 UA 猜。sr/shadowrocket 下发原生 conf；v2rayN 仍走 Clash。
function detectFmt(ua, fmtParam, flagParam) {
  let fmt = String(fmtParam || '').toLowerCase().trim()
  if (!fmt) fmt = String(flagParam || '').toLowerCase().trim()
  const u = String(ua || '').toLowerCase()
  if (fmt === 'sr' || fmt === 'shadowrocket') return 'shadowrocket'
  if (fmt === 'v2rayn') return 'clash'
  if (fmt === 'base64' || fmt === 'v2ray' || fmt === 'link') return 'share'
  if (fmt === 'sing-box') fmt = 'singbox'
  if (fmt) return fmt
  if (u.includes('shadowrocket')) return 'shadowrocket'
  if (/singbox|sing-box/.test(u)) return 'singbox'
  // Shadowrocket（尤其 Mac 更新配置）经常只带 CFNetwork/Darwin，不带 App 名。
  // 带 Mozilla 的是浏览器；Clash Verge / sing-box / v2rayN 有自己的 UA。
  if (u.includes('cfnetwork') && u.includes('darwin')
      && !u.includes('mozilla')
      && !/clash|verge|stash|sing-box|singbox|v2ray|surge/.test(u)) {
    return 'shadowrocket'
  }
  return 'clash'
}

// 订阅里的机场用量合计：流量相加，到期取最早的一家。
// 以前这里写死「1000GB、永不过期」—— 客户端上的数字和机场实际情况毫无关系，
// 机场快到期了在客户端里也看不出来。一家都拿不到用量时不给这个头，不编数字。
function usageOf(prof, ups, meta) {
  let up = 0, down = 0, total = 0, expire = 0, any = false
  for (const u of ups || []) {
    if (u.enabled === false) continue
    if (!(prof.ups === 'all' || (Array.isArray(prof.ups) && prof.ups.includes(u.id)))) continue
    const m = (meta || {})[u.id]
    if (!m) continue
    if (m.total > 0) { any = true; up += m.up || 0; down += m.down || 0; total += m.total }
    if (m.expire > 0) { any = true; expire = expire ? Math.min(expire, m.expire) : m.expire }
  }
  return any ? `upload=${Math.round(up)}; download=${Math.round(down)}; total=${Math.round(total)}; expire=${expire}` : ''
}

// 一份订阅的完整内容。订阅端点与管理端「预览」「规则测试」共用这一条路径 ——
// 各写一套的话，预览里看着对，客户端拿到的却是另一份，预览就没有意义了。
async function renderSub(prof, fmt, opts, event) {
  opts = opts || {}
  // upstream=false：应急开关，只下发自有节点
  const d = opts.upstream === false ? { all: [], meta: {} } : await swrNodes(event)
  const up = (d.all || []).filter(n => !n.off)
  const [rawOwn, rawPol, lib, set, chains, ups] = await Promise.all([loadOwn(), loadPolicies(), loadLib(), loadSettings(), loadChains(), kvGet('upstreams', [])])
  const f = applyProfile(prof, rawOwn, up, rawPol.filter(p => p.enabled !== false))
  // URL 上的 mode 优先，其次用档案自己的设定
  const black = (opts.mode || prof.mode || 'whitelist') === 'blacklist'
  const out = { fmt, usage: usageOf(prof, ups, d.meta), ext: '', nodes: Object.keys(f.own).length + f.up.length, policies: f.policies.length }
  // 链式节点是 Clash / sing-box 专有能力，分享链接格式里没有对应表达，
  // 只能整条略过 —— 硬塞一个落地节点进去会变成不带中转的直连，出口 IP 全变。
  if (fmt === 'share') return { ...out, body: genShare(f.up, f.own, set), type: 'text/plain; charset=utf-8' }
  if (fmt === 'singbox') return { ...out, body: genSB(f.up, f.policies, lib, f.own, set, chains, up), type: 'application/json; charset=utf-8', ext: 'json' }
  if (fmt === 'shadowrocket') return { ...out, body: genSR(black, f.up, f.policies, lib, f.own, set, chains, up), type: 'text/plain; charset=utf-8', ext: 'conf' }
  return { ...out, fmt: 'clash', body: genClash(black, f.up, f.policies, lib, f.own, set, chains, up), type: 'text/yaml; charset=utf-8', ext: 'yaml' }
}

// 谁在拉这份订阅。token 一旦外泄，这里会冒出不认识的 IP 或客户端 —— 管理端能看到。
// 免费版 KV 每天只有 1000 次写入：同一客户端半小时内只记一次，每份订阅每天最多写 60 次，
// 否则外泄的 token 被人狂刷，会把配额耗光，连管理端保存都跟着失败。
const HIT_GAP = 1800e3
const HIT_DAY_MAX = 60
const HIT_LOCK = new Map()  // 订阅 → 本 isolate 里排着队的那条记录任务
// KV 里的「当天已写几次」是读出来再加一：并发涌进来的一批请求读到的是同一个数，
// 每日上限就形同虚设（实测并发 300 个不同客户端写了 300 次）。同一份订阅的记录在
// isolate 内排队一个个来，读到的总是上一次写完的数
function recordHit(prof, req, fmt) {
  if (!hasKV || !prof.id) return Promise.resolve()
  const run = (HIT_LOCK.get(prof.id) || Promise.resolve()).then(() => recordHitNow(prof, req, fmt)).catch(() => {})
  HIT_LOCK.set(prof.id, run)
  if (HIT_LOCK.size > 500) HIT_LOCK.clear()
  return run
}
async function recordHitNow(prof, req, fmt) {
  const k = 'hits:' + prof.id
  const h = await kvGet(k, null)
  const rec = h && Array.isArray(h.list) ? h : { day: '', writes: 0, list: [] }
  const ua = String(req.headers.get('User-Agent') || '').slice(0, 200)
  const ip = clientIP(req)
  const now = Date.now()
  const same = rec.list.find(x => x.ua === ua && x.ip === ip)
  if (same && now - same.at < HIT_GAP) return
  const day = new Date(now).toISOString().slice(0, 10)
  if (rec.day !== day) { rec.day = day; rec.writes = 0 }
  if (rec.writes >= HIT_DAY_MAX) return
  rec.writes++
  const cf = req.cf || {}
  const entry = { ua, ip, fmt, at: now, first: same ? same.first : now, country: cf.country || '', city: cf.city || '' }
  rec.list = [entry, ...rec.list.filter(x => x !== same)].slice(0, 12)
  await kvPut(k, rec)
}

async function handle(req, event) {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/admin' || path.startsWith('/admin/')) return adminRoute(req, url)
  if (path.startsWith('/api/')) return apiRoute(req, url, event)
  // 浏览器打开管理端时会顺手要图标，爬虫会要 robots —— 以前它们都掉进订阅逻辑，
  // 白读一次 KV 再吃个 403
  if (path === '/favicon.ico') return new Response(null, { status: 204, headers: { 'Cache-Control': 'public, max-age=86400' } })
  if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

  // 订阅输出：token 决定用哪份档案。
  // 太短的 token 直接拒：手动部署没注入 SETUP_TOKEN 时，默认档案的 token 是空串，
  // 不拦的话 /?token= 就能拿到完整订阅。
  const tk = url.searchParams.get('token') || ''
  if (tk.length < 16) return new Response('x', { status: 403 })
  const profiles = await loadProfiles()
  const prof = profiles.find(p => p.enabled !== false && typeof p.token === 'string' && safeEq(p.token, tk))
  if (!prof) return new Response('x', { status: 403 })

  // 格式判定：显式 fmt 优先，否则按 UA 猜。
  // Shadowrocket 要原生 INI-like .conf，不能再并进 Clash YAML
  // （fake-ip / GEOSITE / PROCESS-NAME / Reality YAML 在 iOS 上对不齐）。
  // v2rayN 继续 Clash YAML；明确要 base64 节点列表时才走 share。
  const ua = req.headers.get('User-Agent') || ''
  // 路径强制 conf：Mac 小火箭「导入/更新」常用浏览器 UA，query 还可能被丢掉。
  const pathForce = (path === '/sr' || path === '/shadowrocket' || /\.conf$/i.test(path)) ? 'shadowrocket' : ''
  const fmt = pathForce || detectFmt(ua, url.searchParams.get('fmt'), url.searchParams.get('flag'))

  const r = await renderSub(prof, fmt, {
    upstream: url.searchParams.get('upstream') !== '0',
    mode: url.searchParams.get('mode') || ''
  }, event)
  if (event && event.waitUntil) event.waitUntil(recordHit(prof, req, r.fmt).catch(() => {}))

  const h = {
    'Content-Type': r.type,
    'Profile-Update-Interval': '12',
    'Cache-Control': 'no-cache',
    // 客户端拿这个头当配置名显示。不给的话它只能从 URL 路径猜，
    // 于是每一份订阅在客户端里都叫「sub」，多开几份根本分不出谁是谁。
    'Content-Disposition': contentDisposition(prof.name, r.fmt === 'shadowrocket' ? 'conf' : '')
  }
  if (r.usage) h['Subscription-Userinfo'] = r.usage
  return new Response(r.body, { headers: h })
}

// ---------- 管理端路由 ----------

function json(o, s = 200, extra) {
  return new Response(JSON.stringify(o), { status: s, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    // 接口返回的是订阅 token、节点密钥这类东西，不能让任何一层缓存留一份
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extra || {})
  } })
}

// 管理端页面的安全头。
// CSP 里只能留 'unsafe-inline'（页面是单文件内联脚本加内联事件），但 connect-src 'self'
// 仍然有用：就算哪天漏了转义让脚本注进来，它也没法把配置 fetch 到外面去。
// frame-ancestors 防点击劫持；no-referrer 防订阅地址里的 token 经 Referer 漏给外站。
const ADMIN_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
}

// 写操作只接受本站页面发起的请求。cookie 是 SameSite=Lax，跨站 POST 本来就带不上它，
// 这里再核一次 Origin，算第二道门。没带 Origin 的（curl、老浏览器）不拦。
function crossSite(req, url) {
  if (req.method === 'GET' || req.method === 'HEAD') return false
  const o = req.headers.get('Origin')
  if (o && o !== url.origin) return true
  // 写操作只收 JSON。跨站的 <form> 只发得出 urlencoded / multipart / text/plain，
  // 想发 application/json 就得先过 CORS 预检 —— 而这里不回任何 CORS 头，预检必败。
  // 这样即便请求没带 Origin（老浏览器、某些扩展），也伪造不了一次写操作。
  return !/^application\/json\b/i.test(req.headers.get('Content-Type') || '')
}

async function adminRoute(req, url) {
  if (url.pathname === '/admin/login' && req.method === 'POST') {
    if (!hasKV) return json({ ok: false, msg: 'KV 未绑定' }, 500)
    if (crossSite(req, url)) return json({ ok: false, msg: '拒绝跨站请求' }, 403)
    const gate = await loginGate(req)
    if (gate.wait) return json({ ok: false, msg: `尝试次数过多，请 ${Math.ceil(gate.wait / 60)} 分钟后再试` }, 429)
    const { password, initToken } = await req.json().catch(() => ({}))
    const stored = await kvGet('auth:password', null)

    // 首次初始化：必须出示初始化令牌，避免管理端在设密码前裸奔
    if (!stored) {
      // 未注入 SETUP_TOKEN 时（例如手动部署）允许直接设密码，否则必须出示它
      if (INIT_TOKEN && !safeEq(String(initToken || ''), INIT_TOKEN)) {
        await gate.done(false)
        return json({ ok: false, msg: '初始化令牌不正确' }, 403)
      }
      await gate.done(true)
      if (!password || String(password).length < 8) return json({ ok: false, msg: '密码至少 8 位' }, 400)
      await kvPut('auth:password', await hashPassword(password))
    } else {
      const v = await verifyPassword(password || '', stored)
      const left = await gate.done(v.ok)
      if (!v.ok) return json({ ok: false, msg: left > 0 ? `密码错误，还可再试 ${left} 次` : '密码错误次数过多，已锁定 15 分钟' }, 401)
      // 老的无盐哈希趁这次登录换掉，用户无感
      if (v.legacy) await kvPut('auth:password', await hashPassword(password))
    }
    return json({ ok: true }, 200, { 'Set-Cookie': sessCookie(await makeCookie(), req) })
  }

  // 登出只收本站页面发来的 POST：GET 登出、跨站表单都能被别的网站用来把管理员踢下线
  if (url.pathname === '/admin/logout') {
    if (req.method !== 'POST') return new Response(null, { status: 302, headers: { Location: '/admin' } })
    if (crossSite(req, url)) return json({ ok: false, msg: '拒绝跨站请求' }, 403)
    return new Response(null, { status: 204, headers: { 'Set-Cookie': sessCookie('', req), 'Cache-Control': 'no-store' } })
  }

  const authed = await checkCookie(req)
  const inited = !!(await kvGet('auth:password', null))
  // 手动部署没注入 SETUP_TOKEN 时，初始化不需要令牌，页面上也就不该要人去填
  return new Response(adminHTML(authed, inited, !!INIT_TOKEN), { headers: ADMIN_HEADERS })
}

async function apiRoute(req, url, event) {
  if (!hasKV) return json({ ok: false, msg: 'KV 未绑定，无法读写配置' }, 500)
  if (!await checkCookie(req)) return json({ ok: false, msg: '未登录' }, 401)
  if (crossSite(req, url)) return json({ ok: false, msg: '拒绝跨站请求' }, 403)
  const p = url.pathname

  // 改密码。以前只有首次初始化那一次机会，之后想换只能去 KV 里删 auth:password，
  // 而那会让管理端在重设之前一直处于无密码状态 —— 公网上开着的后台，不该这么干。
  if (p === '/api/password' && req.method === 'POST') {
    const { oldPassword, newPassword } = await req.json().catch(() => ({}))
    const stored = await kvGet('auth:password', null)
    if (!stored) return json({ ok: false, msg: '尚未设置过密码' }, 400)
    // 登录态不能替代当前密码：cookie 被借走时，改密码等于把号让出去。
    // 猜旧密码同样计入限速，否则拿到 cookie 的人可以在这里无限次试
    const gate = await loginGate(req)
    if (gate.wait) return json({ ok: false, msg: `尝试次数过多，请 ${Math.ceil(gate.wait / 60)} 分钟后再试` }, 429)
    const okOld = (await verifyPassword(String(oldPassword || ''), stored)).ok
    await gate.done(okOld)
    if (!okOld) return json({ ok: false, msg: '当前密码不正确' }, 401)
    const np = String(newPassword || '')
    if (np.length < 8) return json({ ok: false, msg: '新密码至少 8 位' }, 400)
    if (np === String(oldPassword)) return json({ ok: false, msg: '新密码与当前密码相同' }, 400)
    await kvPut('auth:password', await hashPassword(np))
    // 换了密码，别处已经登上的会话就该作废，否则改了等于没改。
    // 轮换签名密钥即可让所有旧 cookie 失效；当前这台重新签一张，
    // 免得刚改完就把正在操作的人自己踢下线。
    return json({ ok: true }, 200, { 'Set-Cookie': sessCookie(await rotateSecret(), req) })
  }

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
      meta: d.meta || {}, bySrc, snaps: d.snaps || {},
      regions: REGIONS.filter(r => byRegion[r.key]).map(r => ({
        key: r.key, flag: r.flag, cn: r.cn,
        nodes: byRegion[r.key].map(n => ({ key: n.key, name: n.name, auto: n.auto, raw: n.raw, upName: n.upName, custom: n.custom, off: n.off, type: unquote(String((n.kv || {}).type || '')) }))
      }))
    })
  }

  if (p === '/api/upstreams' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const ups = await kvGet('upstreams', [])
    let added = null, addedN = 0
    if (body.act === 'add') {
      const pasted = String(body.text || '').trim()
      if (!pasted && !/^https?:\/\//.test(body.url || '')) return json({ ok: false, msg: '链接需以 http(s):// 开头' }, 400)
      // 没填名称时从链接里捡：多数机场的订阅 URL 自带 ?name= 或 ?remarks=
      let nm = String(body.name || '').trim()
      if (!nm) {
        const q = (String(body.url || '').split('?')[1] || '')
        for (const seg of q.split('&')) {
          const [k, v] = seg.split('=')
          if (/^(name|remarks|title|flag)$/i.test(k || '') && v) {
            try { nm = decodeURIComponent(v).slice(0, 30) } catch (e) { nm = v.slice(0, 30) }
            break
          }
        }
      }
      added = { id: randHex(6), name: nm || '未命名机场', url: String(body.url || ''), enabled: true }
      if (pasted) {
        // 机场挡住 Worker（403/1020）时的退路：内容由浏览器取、人工贴进来。
        // 浏览器是从用户自己的网络访问机场的，不经过我们这边的出口。
        const r = parsePasted(pasted, added)
        if (r.err) return json({ ok: false, msg: r.err }, 400)
        added.auto = false          // 内容是手工给的，没有能自动重拉的来源
        addedN = r.got.nodes.length
        await saveSnap(added.id, r.got, event)
      } else if (!body.force) {
        // 先试拉一次再落库。死链接静默收下的话，用户以为加成功了，
        // 实际每次聚合都白等它超时，还得自己去猜哪一条坏了。
        let probe = null, err = ''
        try { probe = await fetchUpstream(added) }
        catch (e) { err = String(e && e.message || e) }
        if (err) return json({ ok: false, msg: '拉取失败：' + err, canForce: true, canPaste: true }, 400)
        if (!probe.nodes.length) return json({ ok: false, msg: '链接能访问，但没解析出任何节点', canForce: true, canPaste: true }, 400)
        addedN = probe.nodes.length   // 只回给前端做提示，不落库
        // 立刻存快照：一次性链接就指望这一下，过几分钟再拉就是 403 了
        await saveSnap(added.id, probe, event)
      }
      ups.push(added)
    } else if (body.act === 'del') {
      const i = ups.findIndex(u => u.id === body.id)
      if (i >= 0) {
        ups.splice(i, 1)
        if (hasKV) await CONF.delete('snap:' + body.id)   // 快照跟着源一起走
      }
    } else if (body.act === 'toggle') {
      const u = ups.find(u => u.id === body.id)
      if (u) u.enabled = !u.enabled
    } else if (body.act === 'sort') {
      // 数组顺序就是拉取顺序，也就是节点在订阅里的先后
      const ids = Array.isArray(body.ids) ? body.ids : []
      const seen = new Set()
      const next = []
      for (const id of ids) {
        const u = ups.find(x => x.id === id)
        if (u && !seen.has(id)) { seen.add(id); next.push(u) }
      }
      // 另一个标签页刚加的源不在这份 ids 里，别把它弄丢
      for (const u of ups) if (!seen.has(u.id)) next.push(u)
      if (next.length !== ups.length) return json({ ok: false, msg: '顺序数据不完整' }, 400)
      ups.length = 0
      ups.push(...next)
    } else if (body.act === 'edit') {
      const u = ups.find(x => x.id === body.id)
      if (!u) return json({ ok: false, msg: '订阅源不存在' }, 404)
      if (body.name !== undefined) u.name = String(body.name).trim().slice(0, 30) || u.name
      if (body.auto !== undefined) u.auto = !!body.auto
      const pasted = String(body.text || '').trim()
      if (pasted) {
        // 粘贴优先于换链接：既然内容已经在手上，就不必再赌一次能不能拉通
        const r = parsePasted(pasted, u)
        if (r.err) return json({ ok: false, msg: r.err }, 400)
        if (body.url && /^https?:\/\//.test(body.url)) u.url = body.url
        u.auto = false
        addedN = r.got.nodes.length
        await saveSnap(u.id, r.got, event)
      } else if (body.url && body.url !== u.url) {
        if (!/^https?:\/\//.test(body.url)) return json({ ok: false, msg: '链接需以 http(s):// 开头' }, 400)
        // 换链接就立刻拉一次并刷新快照。一次性链接的整个使用方式就是
        // 「去机场复制新链接 → 贴进来 → 趁有效期内抓一份快照」。
        let probe = null, err = ''
        try { probe = await fetchUpstream({ ...u, url: body.url }) }
        catch (e) { err = String(e && e.message || e) }
        if (!body.force) {
          if (err) return json({ ok: false, msg: '新链接拉取失败：' + err, canForce: true, canPaste: true }, 400)
          if (!probe.nodes.length) return json({ ok: false, msg: '新链接没解析出任何节点', canForce: true, canPaste: true }, 400)
        }
        u.url = body.url
        if (probe && probe.nodes.length) { await saveSnap(u.id, probe, event); addedN = probe.nodes.length }
      }
      added = u
    } else return json({ ok: false, msg: '未知操作' }, 400)

    await kvPut('upstreams', ups)
    if (body.act === 'sort') {
      // 排序没改变任何节点的内容，作废缓存等于让用户干等一轮全量重拉。
      // 直接把缓存里的节点按新顺序重排即可 —— sort 是稳定的，
      // 同一机场内部的节点相对顺序不受影响。
      const c = await kvGet('cache:nodes', null)
      if (c && Array.isArray(c.nodes)) {
        const rank = {}
        ups.forEach((u, i) => { rank[u.id] = i })
        const at = n => rank[n.up] === undefined ? ups.length : rank[n.up]
        c.nodes.sort((a, b) => at(a) - at(b))
        if (hasKV) await CONF.put('cache:nodes', JSON.stringify(c), { expirationTtl: STALE_TTL })
      }
    } else {
      await CONF.delete('cache:nodes')   // 配置变了，缓存立即作废
    }
    // 前端据此增量插入一行，不必整页重拉
    return json({ ok: true, up: added ? { ...added, n: addedN } : null })
  }

  // 单个订阅源的抓取诊断：机场到底给没给用量信息、我们又解析出了什么。
  // 元信息缺失时光看 UI 分不清是「机场没提供」还是「我们没解析出来」，
  // 这个接口把两者分开，省得靠猜。
  if (p === '/api/probe' && req.method === 'POST') {
    const { id } = await req.json().catch(() => ({}))
    const u = (await kvGet('upstreams', [])).find(x => x.id === id)
    if (!u) return json({ ok: false, msg: '订阅源不存在' }, 404)
    const snap = await kvGet('snap:' + id, null)
    const snapInfo = snap && snap.nodes ? { at: snap.at, n: snap.nodes.length } : null
    // 每种客户端身份都试一遍并把结果摊开：机场是拒绝了我们，还是给了一份
    // 我们解析不了的格式，这两件事在 UI 上长得一样，不摊开就只能靠猜。
    const tries = []
    let win = null
    for (const ua of UPSTREAM_UAS) {
      let r = null
      try { r = await fetchRaw(u.url, ua) }
      catch (e) { tries.push({ ua, err: String(e && e.message || e) }); continue }
      if (!r.ok) { tries.push({ ua, status: r.status, body: await errBody(r) }); continue }
      const raw = await r.text()
      const decoded = looksBase64(raw) ? b64decode(raw) : raw
      const { nodes, notes } = splitFeed(decoded)
      tries.push({ ua, status: r.status, bytes: raw.length, fmt: feedFormat(raw, decoded), n: nodes.length })
      if (nodes.length) { win = { r, raw, decoded, nodes, notes, ua }; break }
    }
    if (!win) return json({ ok: true, name: u.name, http: 0, tries, snap: snapInfo, err: triesMsg(tries) })

    const hdrs = {}
    for (const k of ['subscription-userinfo', 'content-type', 'content-disposition', 'profile-update-interval', 'profile-web-page-url'])
      if (win.r.headers.get(k)) hdrs[k] = win.r.headers.get(k)
    const head = parseUserinfo(win.r.headers.get('subscription-userinfo'))
    const note = parseNotes(win.notes)
    return json({
      ok: true, name: u.name, http: win.r.status, bytes: win.raw.length,
      fmt: feedFormat(win.raw, win.decoded), ua: win.ua, tries, snap: snapInfo,
      headers: hdrs, hasUserinfo: !!win.r.headers.get('subscription-userinfo'),
      nodes: win.nodes.length, notes: win.notes, head, note, meta: mergeMeta(head, note),
      // 前若干行原文，用于识别没见过的格式；顺带抹掉密钥字段
      sample: win.decoded.split('\n').filter(l => l.trim()).slice(0, 14).map(scrub)
    })
  }

  if (p === '/api/node' && req.method === 'POST') {
    const { key, name, off } = await req.json().catch(() => ({}))
    if (!key || typeof key !== 'string') return json({ ok: false, msg: '缺少 key' }, 400)
    // key 要直接当对象属性名用。__proto__ 这类名字一写，改的就是整个 isolate 的
    // Object.prototype —— 之后生成的每份订阅都可能凭空多出字段、少了节点
    if (BAD_KEYS.has(key) || key.length > 400) return json({ ok: false, msg: 'key 不合法' }, 400)
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
        // 一行填了好几个（`a.com, b.com`）、写成 `*.x.com`、粘了整条网址的，都在这里拆开洗干净
        domains: [...new Set((x.domains || []).flatMap(splitDomains))].slice(0, 2000),
        keywords: (x.keywords || []).map(String).filter(Boolean).slice(0, 100),
        processes: (x.processes || []).map(String).filter(Boolean).slice(0, 100)
      }))
      // 策略名会原样出现在 Clash 规则行末尾（`DOMAIN-SUFFIX,x.com,策略名`），规则按英文逗号切分
      const comma = clean.find(x => x.name.includes(','))
      if (comma) return json({ ok: false, msg: `策略名「${comma.name}」里有英文逗号。Clash 的规则按逗号切分字段，这个名字会让规则错位，请换成中文逗号「，」或别的符号` }, 400)
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
    const kvLib = await kvGet('lib', {})
    return json({
      ok: true,
      policies: cur ? profilePolicies(cur, globals) : globals,
      inherit: cur ? !Array.isArray(cur.policies) : true,
      profiles: profs.map(x => ({ id: x.id, name: x.name, own: Array.isArray(x.policies) })),
      pf: pfId,
      lib: await loadLib(),
      // 域名库页要分清：内置（可恢复）/ 改过的内置 / 自定义（可删），以及谁在引用
      builtin: Object.keys(PRESETS),
      custom: Object.keys(kvLib && typeof kvLib === 'object' ? kvLib : {}),
      refs: libRefs(globals, profs),
      targets: [
        { v: 'all', label: '🚀 节点选择（全部）' },
        ...Object.entries(await loadOwn()).map(([k, n]) => ({ v: 'own:' + k, label: n.name + '（自有）' })),
        // 链式排在地区组前面：会用到它的多半是 AI 这类专门指定出口的策略
        ...(await loadChains()).filter(c => c.enabled !== false).map(c => ({ v: 'chain:' + c.id, label: c.name + '（链式）' })),
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
      if (b.act === 'reset') {
        const old = await kvGet('profiles', [])
        const def = defaultProfiles()
        await kvPut('profiles', def)
        for (const x of Array.isArray(old) ? old : []) if (!def.some(y => y.id === x.id)) await CONF.delete('hits:' + x.id)
        return json({ ok: true, profiles: def })
      }
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

      // 删掉的订阅，拉取记录跟着清掉
      const before = await loadProfiles()
      await kvPut('profiles', clean)
      for (const x of before) if (x.id && !clean.some(y => y.id === x.id)) await CONF.delete('hits:' + x.id)
      return json({ ok: true, profiles: clean })
    }

    // 返回可选项供前端做筛选，避免前端猜有哪些 id
    const liveRegions = [...new Set((await cachedNodes()).map(n => n.region))]
    let profs = await loadProfiles()
    // 手动部署没注入 SETUP_TOKEN 时，默认订阅的 token 是空串，这个地址永远 403。
    // 第一次打开订阅页就给它生成一个并落库，页面上显示的才是能用的地址
    if (profs.some(x => !x.token || x.token.length < 16) && !(await kvGet('profiles', null))) {
      profs = profs.map(x => ({ ...x, token: x.token && x.token.length >= 16 ? x.token : randHex(16) }))
      await kvPut('profiles', profs)
    }
    const hits = {}
    for (const x of profs) {
      const h = await kvGet('hits:' + x.id, null)
      if (h && Array.isArray(h.list)) hits[x.id] = h.list
    }
    const globals = await loadPolicies()
    const lost = {}
    for (const x of profs) { const l = strictLost(x, globals); if (l.length) lost[x.id] = l }
    return json({
      ok: true,
      profiles: profs,
      hits,
      lost,
      newToken: randHex(16),
      opts: {
        own: Object.entries(await loadOwn()).map(([k, n]) => ({ v: k, label: n.name })),
        ups: (await kvGet('upstreams', [])).map(u => ({ v: u.id, label: u.name })),
        // 订阅勾过、但眼下没有节点的地区也要列出来（机场维护时常见）：编辑器里没有这个选项的话，
        // 用户随手保存一次，这个勾选就被悄悄丢了
        regions: REGIONS.filter(r => liveRegions.includes(r.key) || profs.some(x => Array.isArray(x.regions) && x.regions.includes(r.key)))
          .map(r => ({ v: r.key, label: `${r.flag} ${r.cn}` + (liveRegions.includes(r.key) ? '' : '（当前无节点）') })),
        // 停用的策略也列出来（标明已停用），理由同上：否则停用期间保存一次订阅，勾选就丢了
        pols: (await loadPolicies()).map(x => ({ v: x.id, label: x.name + (x.enabled === false ? '（已停用）' : '') }))
      }
    })
  }
  // 链式代理：先连中转、再从中转连落地，出口 IP 是落地的
  if (p === '/api/chains' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const chains = await loadChains()
    if (body.act === 'save') {
      const name = String(body.name || '').trim().slice(0, 30)
      const via = String(body.via || '').trim()
      const out = String(body.out || '').trim()
      if (!name) return json({ ok: false, msg: '给这条链起个名字' }, 400)
      if (!via || !out) return json({ ok: false, msg: '中转和落地都要选' }, 400)
      const i = chains.findIndex(c => c.id === body.id)
      // 名字要唯一：它会直接变成客户端里的节点名，重名等于互相覆盖
      if (chains.some((c, j) => j !== i && c.name === name)) return json({ ok: false, msg: '已有同名的链' }, 400)
      const rec = { id: body.id || randHex(6), name, via, out, enabled: i >= 0 ? chains[i].enabled !== false : true }
      if (i >= 0) chains[i] = rec; else chains.push(rec)
    } else if (body.act === 'del') {
      const i = chains.findIndex(c => c.id === body.id)
      if (i >= 0) chains.splice(i, 1)
    } else if (body.act === 'toggle') {
      const c = chains.find(x => x.id === body.id)
      if (c) c.enabled = c.enabled === false
    } else return json({ ok: false, msg: '未知操作' }, 400)
    await kvPut('chains', chains)
    return json({ ok: true, chains })
  }

  if (p === '/api/chains') {
    const [chains, own, d] = await Promise.all([loadChains(), loadOwn(), swrNodes(event)])
    const up = (d.all || []).filter(n => !n.off)
    const liveKeys = REGIONS.filter(r => up.some(n => n.region === r.key)).map(r => r.key)
    const byKey = {}
    for (const n of up) byKey[n.key] = n
    // 落地节点可能已经不在了（机场改名/下线），把状态一并回给前端，
    // 否则界面上是一条看着正常、实际不生成任何东西的链
    return json({
      ok: true,
      chains: chains.map(c => {
        const land = byKey[c.out]
        return {
          ...c,
          landName: land ? land.name : '',
          landGone: !land,
          viaName: resolveTarget(c.via, liveKeys, own, null),
          warn: land ? chainLandingWarn(land.kv) : ''
        }
      }),
      // 可选的中转与落地清单
      vias: [
        ...Object.entries(own).map(([k, n]) => ({ v: 'own:' + k, label: n.name + '（自有）' })),
        ...REGIONS.filter(r => liveKeys.includes(r.key)).map(r => ({ v: 'region:' + r.key, label: `${r.flag} ${r.cn}（机场）` }))
      ],
      lands: up.map(n => ({ v: n.key, label: n.name, warn: chainLandingWarn(n.kv) }))
    })
  }

  // 站点设置：本站域名与额外直连规则，代码里不硬编码任何站点信息
  if (p === '/api/settings') {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}))
      // 粘完整 URL 是常事，剥到域名为止。
      // 开头的 `*.` 与 `.` 也要剥掉：DOMAIN-SUFFIX 本身就含所有子域名，
      // 写成 `*.example.com` 会生成一条永远匹配不上的规则 —— 不报错、静默不生效，
      // 等发现时早就绕远路跑了半天。
      const host = x => String(x).trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/[\/:?#].*$/, '').replace(/^\*?\./, '')
      const cur = await loadSettings()
      const clean = {
        domain: host(b.domain || ''),
        directDomains: (b.directDomains || []).map(host).filter(Boolean).slice(0, 200),
        directIPs: (b.directIPs || []).map(x => String(x).trim())
          .filter(x => /^(\d{1,3}\.){3}\d{1,3}$/.test(x)).slice(0, 100),
        proxyDomains: (b.proxyDomains || []).map(host).filter(Boolean).slice(0, 200),
        dns: cur.dns
      }
      if (b.dns && typeof b.dns === 'object') {
        const d = { ...cur.dns }
        // DoH 地址或纯 IP，别的形式（比如漏了 https://）会让客户端直接起不来
        const srv = x => String(x).trim()
        const okSrv = v => /^https:\/\/[^\s"']+$/.test(v) || /^(\d{1,3}\.){3}\d{1,3}$/.test(v) ||
                           /^tls:\/\/[^\s"']+$/.test(v) || /^quic:\/\/[^\s"']+$/.test(v) || /^[0-9a-fA-F:]+$/.test(v)
        for (const g of DNS_GROUPS) {
          if (!Array.isArray(b.dns[g.k])) continue
          const list = b.dns[g.k].map(srv).filter(okSrv).slice(0, 8)
          if (!list.length) return json({ ok: false, msg: `${g.label}至少要有一个有效地址（https:// 开头的 DoH，或纯 IP）` }, 400)
          // 引导 DNS 只能是纯 IP：它的职责就是解析别的 DoH 域名，自己再依赖域名就成了死循环
          if (g.k === 'bootstrap' && list.some(v => !/^(\d{1,3}\.){3}\d{1,3}$/.test(v)))
            return json({ ok: false, msg: '引导 DNS 必须是纯 IP —— 它负责解析其它 DoH 的域名，自己不能再依赖域名解析' }, 400)
          d[g.k] = list
        }
        if (DNS_GROUPS.some(g => g.k === b.dns.selfGroup)) d.selfGroup = b.dns.selfGroup
        if (typeof b.dns.remoteViaProxy === 'boolean') d.remoteViaProxy = b.dns.remoteViaProxy
        if (typeof b.dns.fakeIp === 'boolean') d.fakeIp = b.dns.fakeIp
        if (typeof b.dns.ipv6 === 'boolean') d.ipv6 = b.dns.ipv6
        if (Array.isArray(b.dns.policies)) {
          d.policies = b.dns.policies
            .map(x => ({ domain: String((x && x.domain) || '').trim().toLowerCase(), group: String((x && x.group) || '') }))
            .filter(x => x.domain && DNS_GROUPS.some(g => g.k === x.group)).slice(0, 100)
        }
        if (Array.isArray(b.dns.extraFilter)) {
          d.extraFilter = b.dns.extraFilter.map(x => String(x).trim()).filter(Boolean).slice(0, 100)
        }
        clean.dns = d
      }
      await kvPut('settings', clean)
      return json({ ok: true, settings: clean })
    }
    return json({ ok: true, settings: await loadSettings(), dnsGroups: DNS_GROUPS })
  }

  // 分享链接解析：手动添加自有节点时，粘一条链接自动填好表单
  if (p === '/api/parse-share' && req.method === 'POST') {
    const { link } = await req.json().catch(() => ({}))
    if (!String(link || '').trim()) return json({ ok: false, msg: '请先粘贴链接' }, 400)
    const r = shareToOwn(link)
    if (!r) return json({ ok: false, msg: '认不出这条链接 —— 需要 vless:// 或 hysteria2:// 开头的完整分享链接' }, 400)
    if (r.err) return json({ ok: false, msg: r.err }, 400)
    return json({ ok: true, node: r.node })
  }

  // 自有节点：BWG 上自建的节点，与机场订阅无关，独立存 KV
  if (p === '/api/own') {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}))
      // 「恢复默认」就是清空。以前它直接删 KV，绕过了下面的悬空引用检查 ——
      // 策略还指着某个自有节点，节点却没了，订阅里那组就静默回落到「节点选择」
      if (b.act === 'reset') b.own = {}
      if (!b.own || typeof b.own !== 'object' || Array.isArray(b.own)) return json({ ok: false, msg: '数据格式错误' }, 400)

      const clean = {}
      for (const [k, v] of Object.entries(b.own)) {
        if (!v || typeof v !== 'object') return json({ ok: false, msg: '数据格式错误' }, 400)
        const key = String(k).replace(/[^\w-]/g, '').slice(0, 24)
        if (!key) return json({ ok: false, msg: '节点标识只能是字母数字和连字符' }, 400)
        const name = String(v.name || '').trim().slice(0, 32)
        const type = v.type === 'hysteria2' ? 'hysteria2' : 'vless'
        if (!name) return json({ ok: false, msg: '节点名称不能为空' }, 400)
        if (!v.s || !v.p || !v.u) return json({ ok: false, msg: `「${name}」缺少服务器/端口/密钥` }, 400)
        const n = { name, type, s: String(v.s).trim(), p: parseInt(v.p, 10) || 443, u: String(v.u).trim(), sni: String(v.sni || '').trim() }
        if (type === 'vless') {
          const net = (v.net === 'xhttp' || v.net === 'ws') ? v.net : 'tcp'
          n.net = net
          if (net === 'ws') {
            n.path = String(v.path || '/').trim() || '/'
            if (v.host) n.host = String(v.host).trim()
            n.flow = ''
          } else {
            // Reality 缺公钥会让客户端握手失败，报错信息又极难定位，提前挡住
            if (!v.pk || !v.sid) return json({ ok: false, msg: `「${name}」是 VLESS Reality，必须填公钥与 ShortId` }, 400)
            n.pk = String(v.pk).trim(); n.sid = String(v.sid).trim()
            // 手输的公钥错一个字符，客户端就拒绝加载整份订阅，所以这里就挡住
            if (!/^[A-Za-z0-9_-]{43}$/.test(n.pk)) return json({ ok: false, msg: `「${name}」的 Reality 公钥格式不对：应是 43 位的 base64url（xray x25519 输出的 Public key），现在是 ${n.pk.length} 位` }, 400)
            if (!/^([0-9a-fA-F]{2}){0,8}$/.test(n.sid)) return json({ ok: false, msg: `「${name}」的 ShortId 格式不对：应是十六进制、位数为偶数、最多 16 位` }, 400)
            n.flow = net === 'tcp' ? (v.flow || 'xtls-rprx-vision') : ''
          }
        } else {
          if (v.ports) n.ports = String(v.ports).trim()
          // 空就是不混淆。以前把空值兜底成 salamander，配上空密码，mihomo 直接拒绝整份配置
          n.obfs = String(v.obfs || '').trim()
          n.opwd = String(v.opwd || '').trim()
        }
        clean[key] = n
      }
      // 自有节点可以一个都没有：只用机场的人本来就不需要它。
      // 以前这里要求至少留一个，结果最后一个节点怎么都删不掉
      const names = Object.values(clean).map(n => n.name)
      if (new Set(names).size !== names.length) return json({ ok: false, msg: '节点名称重复，客户端会拒绝加载' }, 400)

      // 被删掉的节点若仍被策略指向会产生悬空引用，挡在保存前。
      // target 可能是字符串（老数据）或数组（多选目标）；必须用 targetList，
      // 不能 String(target)：['own:a','region:us'] 会变成 'own:a,region:us'，
      // 既误判悬空，也会让「只是在添加节点」的保存全部失败。
      const refd = []
      const note = (polName, key) => { if (!refd.some(x => x.key === key)) refd.push({ name: polName, key }) }
      for (const pol of await loadPolicies()) {
        for (const tg of targetList(pol)) {
          if (String(tg).startsWith('own:')) note(pol.name, String(tg).slice(4))
        }
      }
      for (const prof of await loadProfiles()) {
        if (!Array.isArray(prof.policies)) continue
        for (const pol of prof.policies) {
          for (const tg of targetList(pol)) {
            if (String(tg).startsWith('own:')) note(`${prof.name || '订阅'}/${pol.name}`, String(tg).slice(4))
          }
        }
      }
      const orphan = refd.find(x => !clean[x.key])
      if (orphan) return json({ ok: false, msg: `策略「${orphan.name}」仍引用自有节点「${orphan.key}」，请先改它的分流目标，或保留该节点后再保存` }, 400)

      await kvPut('nodes', clean)
      return json({ ok: true, own: clean })
    }
    // 顺带给每个节点一条分享链接：单独导入某个自建节点时不必去服务器上翻配置
    const own = await loadOwn()
    const links = {}
    for (const [k, n] of Object.entries(own)) { try { links[k] = shareLink({ name: n.name, own: true, o: n }) || '' } catch (e) {} }
    return json({ ok: true, own, links })
  }
  // 订阅预览：某份订阅在某种客户端格式下的完整内容。
  // 走的是订阅端点同一个 renderSub，这里看到的就是客户端拿到的。
  if (p === '/api/preview') {
    const prof = (await loadProfiles()).find(x => x.id === (url.searchParams.get('pf') || ''))
    if (!prof) return json({ ok: false, msg: '订阅不存在' }, 404)
    const r = await renderSub(prof, detectFmt('', url.searchParams.get('fmt') || 'clash', ''), {}, event)
    return json({
      ok: true, fmt: r.fmt, body: r.body, bytes: enc.encode(r.body).length,
      usage: r.usage, nodes: r.nodes, policies: r.policies,
      filename: (prof.name || 'subscription') + '.' + (r.ext || 'txt')
    })
  }

  // 规则测试：某个域名 / IP 会命中哪条规则、落到哪个分组、组里有哪些节点。
  // 直接拿生成好的 Clash 配置逐条比对 —— 和客户端里的规则顺序、写法完全一致；
  // 另写一套匹配逻辑的话，迟早和真实规则对不上。
  if (p === '/api/match' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}))
    if (!String(b.q || '').trim()) return json({ ok: false, msg: '输入一个域名或 IP' }, 400)
    let prof = null
    if (b.pf) {
      prof = (await loadProfiles()).find(x => x.id === String(b.pf))
      if (!prof) return json({ ok: false, msg: '订阅不存在' }, 404)
    } else {
      // 全局视角：全部节点、全部全局策略
      prof = { id: '', own: 'all', ups: 'all', regions: 'all', pols: 'all', policies: 'inherit', mode: 'whitelist' }
    }
    if (!matchHost(b.q)) return json({ ok: false, msg: '没认出主机名，输入域名、网址或 IP' }, 400)
    const r = await renderSub(prof, 'clash', {}, event)
    const m = matchRules(r.body, b.q)
    if (m.target) m.members = groupMembers(r.body, m.target)
    m.src = await ruleSource(m, prof)
    return json({ ok: true, ...m })
  }

  // 备份与恢复。KV 里的配置没有别的副本，误删、误操作、换账号迁移都只能靠它。
  // 登录凭据（auth:*）不进备份：备份文件流转到哪里都不该顺带交出后台。
  if (p === '/api/backup') {
    const data = {}
    for (const k of BACKUP_KEYS) { const v = await kvGet(k, null); if (v !== null) data[k] = v }
    // 从没保存过的订阅不在 KV 里，它的 token 来自这次部署的 SETUP_TOKEN —— 换个账号恢复就对不上了。
    // 订阅按实际生效的值导出，恢复后原来的地址照样能用
    data.profiles = await loadProfiles()
    // 一次性链接和粘贴导入的源只活在快照里，不带上的话恢复后就是空的
    const snaps = {}
    for (const u of (Array.isArray(data.upstreams) ? data.upstreams : [])) {
      const s = await kvGet('snap:' + u.id, null)
      if (s) snaps[u.id] = s
    }
    return json({ ok: true, backup: { app: 'cf-sub-worker', version: 1, at: Date.now(), data, snaps } })
  }
  if (p === '/api/restore' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}))
    const bk = b.backup
    if (!bk || bk.app !== 'cf-sub-worker' || !bk.data || typeof bk.data !== 'object') return json({ ok: false, msg: '这不是本服务导出的备份文件' }, 400)
    if (bk.version !== 1) return json({ ok: false, msg: `备份格式版本（${bk.version}）不认识，请用同一版本导出的文件` }, 400)
    const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
    const shape = { settings: isObj, nodes: isObj, upstreams: Array.isArray, overrides: isObj, profiles: Array.isArray, policies: Array.isArray, lib: isObj, chains: Array.isArray }
    for (const k of Object.keys(bk.data)) {
      // hasOwnProperty 而不是 shape[k]：键名是 __proto__、toString 时 shape[k] 会取到原型上的东西
      if (!Object.prototype.hasOwnProperty.call(shape, k)) return json({ ok: false, msg: `备份里有不认识的项「${k}」` }, 400)
      if (!shape[k](bk.data[k])) return json({ ok: false, msg: `备份里的「${k}」格式不对` }, 400)
    }
    const profs = bk.data.profiles
    // 没有订阅的备份一律不收：恢复会删掉现有订阅，所有客户端当场掉线
    if (!profs || !profs.some(x => x && x.enabled !== false && /^[A-Za-z0-9_-]{16,64}$/.test(String(x.token || ''))))
      return json({ ok: false, msg: '备份里没有一份可用的订阅，恢复后所有客户端都会掉线' }, 400)
    const snaps = Object.entries(isObj(bk.snaps) ? bk.snaps : {})
      .filter(([id, v]) => /^[\w-]{1,32}$/.test(id) && isObj(v) && Array.isArray(v.nodes))
    // 以备份为准：备份里没有的项（当时用的是默认值）这边也删掉，恢复出来才是原样。
    // KV 没有事务，中途写失败（比如当天写入额度用完）就把已经写的改回去，不留半新半旧的配置
    const before = {}
    for (const k of BACKUP_KEYS) before[k] = await kvGet(k, null)
    const done = []
    try {
      for (const k of BACKUP_KEYS) {
        if (k in bk.data) await kvPut(k, bk.data[k]); else await CONF.delete(k)
        done.push(k)
      }
    } catch (e) {
      for (const k of done) { try { before[k] === null ? await CONF.delete(k) : await kvPut(k, before[k]) } catch (_) {} }
      return json({ ok: false, msg: '恢复中途写入失败，已改回原来的配置：' + String(e && e.message || e) }, 500)
    }
    let snapN = 0
    for (const [id, v] of snaps) { try { await kvPut('snap:' + id, v); snapN++ } catch (e) {} }
    await CONF.delete('cache:nodes')
    return json({ ok: true, snaps: snapN })
  }

  // 让其它设备全部下线：轮换签名密钥，旧 cookie 一律作废；当前这台重签一张
  if (p === '/api/sessions' && req.method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': sessCookie(await rotateSecret(), req) })
  }

  // 域名库：保存单个集合，域名去重后小写存储
  if (p === '/api/lib' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}))
    if (!b.key) return json({ ok: false, msg: '缺少 key' }, 400)
    if (!/^[\w-]{1,32}$/.test(String(b.key)) || BAD_KEYS.has(b.key)) return json({ ok: false, msg: 'key 只能是字母数字' }, 400)
    const lib = await kvGet('lib', {})
    if (b.act === 'del') {
      // 内置集合删的只是 KV 里的改动，等于恢复内置；自定义集合是真删，
      // 被策略引用着就不能删 —— 否则那条策略悄悄少了一批域名，没人会发现
      if (!PRESETS[b.key]) {
        const refs = libRefs(await loadPolicies(), await loadProfiles())[b.key] || []
        if (refs.length) return json({ ok: false, msg: `还有策略在引用它：${refs.slice(0, 3).join('、')}${refs.length > 3 ? ` 等 ${refs.length} 条` : ''}。先在这些策略里取消勾选` }, 400)
      }
      delete lib[b.key]
    } else {
      const doms = [...new Set((b.domains || []).map(d => String(d).trim().toLowerCase()).filter(Boolean))]
      lib[b.key] = { name: String(b.name || b.key).slice(0, 24), hint: String(b.hint || '').slice(0, 60), domains: doms.slice(0, 3000) }
    }
    await kvPut('lib', lib)
    return json({ ok: true, lib: { ...PRESETS, ...lib }, custom: Object.keys(lib) })
  }

  return json({ ok: false, msg: '404' }, 404)
}

// ---------- 订阅生成 ----------

function pick(up, key, fb) {
  const n = up.filter(x => x.region === key).map(x => x.name)
  return n.length ? n : fb
}

// 名字一律按 JSON 字符串写进 YAML：机场名、覆盖名、节点名里出现 " \ # 或「: 」
// 都会让整份配置解析失败。groupMembers 按这个格式读回，两边要一致。
function q(a) { return a.map(n => JSON.stringify(String(n))).join(', ') }

// 策略名要原样出现在规则行末尾（`- DOMAIN-SUFFIX,x.com,名字`）。规则行不加引号、按逗号切分，
// 整行又是一个 YAML 纯量 —— 名字里的英文逗号会被当成字段分隔，「: 」让整行变成映射，
// 「 #」之后被当注释吃掉，首尾空白被 YAML 去掉。保存时已拦住逗号，这里给老数据兜底，
// 换成全角。组名和规则目标必须走同一个转换，否则引用对不上。
function ruleName(s) {
  const t = String(s || '').replace(/[\x00-\x1f\x7f\u0085\u2028\u2029\ufeff]+/g, ' ')
    .replace(/,/g, '，').replace(/:(?=\s|$)/g, '：').replace(/(\s)#/g, '$1＃').trim()
  return t || '未命名'
}
// 规则里的关键词 / 进程名：同样不能有逗号这些，改写会改变匹配语义，只能丢掉
const ruleVal = x => { const s = String(x || '').trim(); return s && !/[,\x00-\x1f\x7f\u0085\u2028\u2029]|:\s|:$|\s#/.test(s) ? s : '' }

// 把策略的 target 解析成客户端里真实存在的组名 / 节点名。
// 指向的地区若当前没有节点，退回 🚀 节点选择，避免产生悬空引用让客户端拒绝整份配置。
function resolveTarget(t, liveKeys, own, chains) {
  if (t === 'direct') return 'DIRECT'
  if (t === 'reject') return 'REJECT'
  if (t === 'all') return '🚀 节点选择'
  if (String(t).startsWith('chain:')) {
    const c = (chains || []).find(x => x.id === String(t).slice(6))
    return c ? c.name : '🚀 节点选择'      // 链被删了就回落，别留个悬空引用
  }
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
function resolveTargets(p, liveKeys, own, chains) {
  const out = []
  for (const t of targetList(p)) {
    const r = resolveTarget(t, liveKeys, own, chains)
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

function looksIP(s) {
  s = String(s || '')
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) || s.includes(':')
}

// DoH 地址里有冒号和斜杠，写进 YAML 流式列表要带引号；纯 IP 不用
function dnsQ(x) {
  const v = String(x).trim()
  return /^[\d.]+$/.test(v) ? v : JSON.stringify(v)
}
const dnsFlow = arr => (arr || []).map(dnsQ).join(', ')
const sbDnsTag = g => g === 'domestic' ? 'dns-direct' : g === 'bootstrap' ? 'dns-resolver' : 'dns-remote'
const dnsList = arr => (arr || []).map(x => `    - ${dnsQ(x)}`)

// 语义上一定是字符串的字段。缓存和快照里的值是旧版解析器写的，没加引号（*Abc、0888 原样），
// 一次性链接的快照永远不会重新解析；机场自己的 YAML 偶尔也这么写。输出时凡是会被 YAML
// 读成别的东西（别名、锚点、注释、数字、布尔）的，补上引号 —— 字符串内容不变。
const KV_STR = new Set(['server', 'uuid', 'password', 'cipher', 'servername', 'sni', 'flow', 'client-fingerprint',
  'obfs', 'obfs-password', 'ports', 'auth-str', 'auth', 'username', 'private-key', 'public-key', 'pre-shared-key',
  'short-id', 'path', 'Host', 'host', 'grpc-service-name', 'congestion-controller', 'udp-relay-mode', 'mode'])
const kvStr = v => (v && !/^["'[{]/.test(v) && flowVal(v) !== v) ? JSON.stringify(v) : v
function kvOut(k, v) {
  v = String(v === undefined || v === null ? '' : v)
  if (KV_STR.has(k)) return kvStr(v)
  // 嵌套的 *-opts：只动字符串字段的叶子，数字、布尔、列表原样
  if (/-opts$/.test(k) && v.startsWith('{') && v.endsWith('}')) return requoteFlow(v)
  return v
}
function requoteFlow(t) {
  const parts = splitTop(t.slice(1, -1)).map(pair => {
    const i = pair.indexOf(':')
    if (i < 0) return pair.trim()
    const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim()
    if (v.startsWith('{') && v.endsWith('}')) return `${k}: ${requoteFlow(v)}`
    return `${k}: ${KV_STR.has(unquote(k)) ? kvStr(v) : v}`
  }).filter(Boolean)
  return parts.length ? `{ ${parts.join(', ')} }` : '{}'
}

function genClash(blacklist, up, policies, lib, own, st, chains, pool) {
  const SET = { ...DEFAULT_SETTINGS, ...(st || {}) }
  const D = { ...DEFAULT_DNS, ...(SET.dns || {}) }
  const Y = JSON.stringify
  // 站点设置里的域名同样要能安全地拼进规则行：拆开一行多个的、剥掉通配符前缀、丢掉不像域名的
  const dl = a => [...new Set((a || []).flatMap(splitDomains))]
  const FORCED = dl(SET.proxyDomains)
  const SELF = cleanDomain(SET.domain)
  const ownN = Object.values(own).map(n => n.name)
  const upN = up.map(n => n.name)
  const liveR = REGIONS.filter(r => up.some(n => n.region === r.key))
  const liveKeys = liveR.map(r => r.key)
  const ch = resolveChains(chains, pool || up, own, liveKeys)
  const allN = [...ownN, ...upN, ...ch.map(c => c.name)]
  const regionNames = liveR.map(r => `${r.flag} ${r.cn}`)
  const act = (policies || []).filter(p => p.enabled !== false)
  // 策略组名就是规则目标，两处必须是同一个字符串；清洗后撞名的，后来者补序号
  const pName = new Map(), usedP = new Set()
  for (const p of act) {
    let nm = ruleName(p.name)
    for (let k = 2; usedP.has(nm); k++) nm = `${ruleName(p.name)} ${k}`
    usedP.add(nm); pName.set(p, nm)
  }

  // 自有节点的字符串值全部 JSON 引号：short-id 0888 会被读成数字（mihomo 报 invalid REALITY short ID），
  // 以 * & # 开头的密码会被当成别名、锚点、注释
  let pl = ''
  Object.values(own).forEach(n => {
    const L = [`  - name: ${Y(n.name)}`]
    if (n.type === 'vless') {
      L.push(`    type: vless`, `    server: ${Y(String(n.s))}`, `    port: ${n.p}`, `    uuid: ${Y(String(n.u))}`, `    tls: true`)
      if (n.net === 'ws') {
        const host = n.host || n.sni || n.s
        L.push(
          `    servername: ${Y(String(n.sni || n.s))}`,
          `    client-fingerprint: chrome`,
          `    network: ws`,
          `    ws-opts:`,
          `      path: ${Y(String(n.path || '/'))}`,
          `      headers:`,
          `        Host: ${Y(String(host))}`,
          `      max-early-data: 2048`,
          `      early-data-header-name: Sec-WebSocket-Protocol`)
      } else {
        L.push(
          `    servername: ${Y(String(n.sni || ''))}`,
          `    reality-opts:`,
          `      public-key: ${Y(String(n.pk || ''))}`,
          `      short-id: ${Y(String(n.sid || ''))}`,
          `    client-fingerprint: chrome`,
          ...(n.net === 'tcp'
            ? [`    flow: ${Y(String(n.flow || ''))}`, `    network: tcp`]
            : [`    network: xhttp`, `    xhttp-opts:`, `      path: /`, `      mode: auto`]))
      }
      L.push(`    udp: true`)
    } else {
      L.push(
        `    type: hysteria2`,
        `    server: ${Y(String(n.s))}`,
        `    port: ${n.p}`,
        ...(n.ports ? [`    ports: ${Y(String(n.ports))}`] : []),
        `    password: ${Y(String(n.u))}`,
        `    sni: ${Y(String(n.sni || ''))}`,
        `    skip-cert-verify: true`,
        `    udp: true`,
        // 类型和密码缺一个就不写混淆：obfs 有值、obfs-password 为空时 mihomo 拒绝加载整份配置
        ...(n.obfs && n.opwd ? [`    obfs: ${Y(String(n.obfs))}`, `    obfs-password: ${Y(String(n.opwd))}`] : []))
    }
    pl += L.join('\n') + '\n\n'
  })

  // 机场 / 落地节点的字段原样透传。hysteria2 只写了混淆类型没给密码的，
  // 这一个节点就能让 mihomo 拒绝整份配置 —— 当作没有混淆
  const passKv = (kv, lines, skip) => {
    const noObfs = unquote(kv.type || '') === 'hysteria2' && !unquote(kv['obfs-password'] || '')
    for (const k of Object.keys(kv)) {
      if (k === 'name' || k.startsWith('_') || (skip && skip(k))) continue
      if (noObfs && (k === 'obfs' || k === 'obfs-password')) continue
      lines.push(`    ${k}: ${kvOut(k, kv[k])}`)
    }
    return lines
  }

  // 机场节点：原样透传上游字段，只把 name 换成我们生成的
  up.forEach(n => {
    pl += passKv(n.kv, [`  - name: ${Y(n.name)}`]).join('\n') + '\n\n'
  })

  // 链式节点：把落地节点整份复制一遍，加 dialer-proxy 指向中转。
  // 必须是副本而不是改原节点 —— 原节点还要照常出现在地区组里直连用。
  ch.forEach(c => {
    const lines = passKv(c.land.kv, [`  - name: ${Y(c.name)}`], k => k === 'dialer-proxy')
    lines.push(`    dialer-proxy: ${Y(c.via)}`)
    pl += lines.join('\n') + '\n\n'
  })

  // 策略组 —— 每条启用的策略一个 select 组
  const polGroups = act.map(p => {
    const t = resolveTargets(p, liveKeys, own, ch)
    return [
      `  - name: ${Y(pName.get(p))}`,
      `    type: select`,
      `    proxies: [${q(policyMembers(p, t, allN, regionNames))}]`
    ].join('\n')
  }).join('\n')

  const regionGroups = liveR.map(r => [
    `  - name: ${Y(`${r.flag} ${r.cn}`)}`,
    `    type: url-test`,
    `    proxies: [${q(up.filter(n => n.region === r.key).map(n => n.name))}]`,
    `    url: http://www.gstatic.com/generate_204`,
    `    interval: 300`,
    `    tolerance: 50`
  ].join('\n')).join('\n')

  // 策略规则 —— 数组顺序即匹配优先级，管理端拖拽排序改的就是它
  const polRules = act.map(p => {
    const rs = [], nm = pName.get(p)
    policyDomains(p, lib).forEach(d => rs.push(`  - DOMAIN-SUFFIX,${d},${nm}`))
    ;(p.keywords || []).map(ruleVal).filter(Boolean).forEach(k => rs.push(`  - DOMAIN-KEYWORD,${k},${nm}`))
    ;(p.processes || []).map(ruleVal).filter(Boolean).forEach(x => rs.push(`  - PROCESS-NAME,${x},${nm}`))
    return rs.join('\n')
  }).filter(Boolean).join('\n')

  const tail = blacklist
    ? [`  - GEOSITE,cn,DIRECT`, `  - GEOIP,CN,DIRECT`, `  - MATCH,DIRECT`]
    : [`  - GEOSITE,cn,DIRECT`, `  - GEOIP,CN,DIRECT`, `  - MATCH,🚀 节点选择`]

  return [
    `# 订阅由 Cloudflare Worker 生成（${blacklist ? '黑名单模式' : '白名单模式'}）`,
    `# 自有 ${ownN.length} 节点 / 机场 ${upN.length} 节点 / ${act.length} 条分流策略`,
    // 只留一个 mixed 端口。以前 port 与 socks-port 都是 7890，裸内核起 SOCKS 监听时 bind 失败
    `mixed-port: 7890`,
    `ipv6: true`,
    `mode: rule`,
    `log-level: warning`,
    // 图形客户端都用自己的设置覆盖它，只有裸内核会用到 —— 裸内核开着局域网又不设认证，
    // 在公共 Wi-Fi 上就是一台谁都能用的开放代理
    `allow-lan: false`,
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
    // 顶层保持 false（官方默认）。设成 true 会让 TLS 连接也「用嗅探到的域名
    // 重新解析、覆盖目标地址」—— 客户端本来已经解析对了，再解析一次反而可能
    // 拿到被污染的结果，连过去就是别人的服务器：证书不匹配、跳转到搜索引擎。
    // 嗅探本身照常进行，规则匹配仍然拿得到域名，分流不受影响。
    `  override-destination: false`,
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
    `    - "+.bing.com"`,
    // 本站域名跳过嗅探：它已经走真实解析、也已经是直连，再嗅探一道没有意义
    ...(SELF ? [`    - ${Y('+.' + SELF)}`] : []),
    ``,
    // DNS 防泄漏要点：
    //   respect-rules  代理域名的 DNS 查询跟随规则走代理出口，不在本地明文发出
    //   proxy-server-nameserver  解析节点域名，必须直连，否则与 respect-rules 循环依赖
    //   default-nameserver  仅用于解析上面那些 DoH 服务器自身的域名
    `dns:`,
    `  enable: true`,
    `  ipv6: ${D.ipv6 !== false}`,
    `  enhanced-mode: ${D.fakeIp === false ? 'redir-host' : 'fake-ip'}`,
    ...(D.fakeIp === false ? [] : [
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
      ...(SELF ? [`    - ${Y('+.' + SELF)}`] : []),
      // 自有节点的服务器域名必须走真实解析。拿到 fake IP 就永远拨不通，
      // 而且几个节点会一起 timeout —— 看着像服务器挂了，其实是解析问题。
      ...[...new Set(Object.values(own).map(n => n.s).filter(x => x && !looksIP(x)))].map(h => `    - ${Y(String(h))}`),
      ...(D.extraFilter || []).map(f => `    - ${Y(String(f))}`)
    ]),
    `  default-nameserver:`,
    ...dnsList(D.bootstrap),
    // 解析节点服务器地址必须直连：走代理就和 respect-rules 成了循环依赖
    `  proxy-server-nameserver:`,
    ...dnsList(D.domestic),
    `  direct-nameserver:`,
    ...dnsList(D.domestic),
    `  nameserver:`,
    ...dnsList(D.remoteViaProxy === false ? D.remote : D.remote.map(x => x + '#🚀 节点选择')),
    // 关掉会让代理域名的 DNS 查询在本地明文发出，等于白建隧道
    `  respect-rules: true`,
    `  nameserver-policy:`,
    // 本站域名交给国内 DNS 是个陷阱：它多半托管在 Cloudflare、服务器也常在境外，
    // 国内 DNS 对这类域名的返回可能是被污染的 —— 实测所有子域名会解析到同一个
    // 无关 IP，配上「本站域名直连」这条规则，直连过去拿到的就是别人的证书，
    // 浏览器报 ERR_CERT_COMMON_NAME_INVALID，而手机不挂代理反而正常。
    // 用可信 DoH 拿真实地址；拿到之后照样直连，不影响「直连」这件事本身。
    ...(SELF ? [
      `    ${Y('+.' + SELF)}: [${dnsFlow(D[D.selfGroup] || D.remote)}]`,
      `    ${Y(SELF)}: [${dnsFlow(D[D.selfGroup] || D.remote)}]`
    ] : []),
    ...(D.policies || []).filter(p => p && p.domain && D[p.group])
      .map(p => `    ${Y(String(p.domain))}: [${dnsFlow(D[p.group])}]`),
    ``,
    `proxies:`,
    pl,
    `proxy-groups:`,
    `  - name: "🚀 节点选择"`,
    `    type: select`,
    `    proxies: [${q([...allN, ...regionNames, 'DIRECT'])}]`,
    // 一个节点都没有时不能生成：空的 url-test 组会让 mihomo 报 use or proxies missing
    ...(allN.length ? [
      `  - name: "♻️ 自动选择"`,
      `    type: url-test`,
      `    proxies: [${q(allN)}]`,
      `    url: http://www.gstatic.com/generate_204`,
      `    interval: 300`,
      `    tolerance: 50`
    ] : []),
    polGroups,
    regionGroups,
    ``,
    `rules:`,
    `  - IP-CIDR,127.0.0.1/32,DIRECT,no-resolve`,
    `  - IP-CIDR,::1/128,DIRECT,no-resolve`,
    // 节点服务器 IP 必须直连：程序若直接用 IP 连接（SSH、节点探测）匹配不到下面的域名规则，
    // 会被 MATCH 兜底送进代理绕一圈回来，既慢又可能触发 Reality 握手失败。
    ...(SET.directIPs || []).filter(ip => /^(\d{1,3}\.){3}\d{1,3}$/.test(String(ip))).map(ip => `  - IP-CIDR,${ip}/32,DIRECT,no-resolve`),
    // 强制代理必须排在所有直连规则之前，否则永远轮不到它。
    // 同名的直连规则一并去掉：留着也永远匹配不到，只会让人以为它还在生效。
    ...FORCED.map(d => `  - DOMAIN-SUFFIX,${d},🚀 节点选择`),
    ...(SELF && !FORCED.includes(SELF) ? [`  - DOMAIN-SUFFIX,${SELF},DIRECT`] : []),
    ...dl(SET.directDomains).filter(d => !FORCED.includes(d)).map(d => `  - DOMAIN-SUFFIX,${d},DIRECT`),
    polRules,
    tail.join('\n')
  ].filter(x => x !== '').join('\n')
}

// ---------- 规则测试 ----------
// 输入可能是整条网址、带端口的主机名、IPv6 字面量，统一剥成主机名
function matchHost(input) {
  let h = String(input || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  h = h.replace(/^[^@/?#]*@/, '').replace(/[/?#].*$/, '')
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined)
  else if ((h.match(/:/g) || []).length === 1) h = h.split(':')[0]
  return h.replace(/\.+$/, '')
}
function ip4num(ip) {
  const p = ip.split('.').map(Number)
  return p.length === 4 && p.every(x => x >= 0 && x <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : -1
}
function inCidr4(ip, cidr) {
  const [base, bits] = String(cidr).split('/')
  const n = bits === undefined ? 32 : Number(bits)
  const a = ip4num(ip), b = ip4num(base)
  if (a < 0 || b < 0 || !(n >= 0 && n <= 32)) return false
  const mask = n === 0 ? 0 : (0xFFFFFFFF << (32 - n)) >>> 0
  return ((a & mask) >>> 0) === ((b & mask) >>> 0)
}
// 逐条走生成好的 Clash 规则，返回第一条命中的。
// 进程名、GEOSITE、GEOIP 这里判断不了（要么看发起连接的程序，要么要客户端的地理库），
// 排在命中项之前的这类规则一并列出来，免得用户以为结果是板上钉钉。
function matchRules(yamlText, input) {
  const host = matchHost(input)
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  const v6 = !v4 && host.includes(':')
  const isDomain = !v4 && !v6
  const at = yamlText.indexOf('\nrules:\n')
  const rules = at < 0 ? [] : yamlText.slice(at + 8).split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
  const unsure = []
  for (let i = 0; i < rules.length; i++) {
    const parts = rules[i].split(',')
    const type = parts[0].trim().toUpperCase()
    const val = (parts[1] || '').trim()
    const target = (type === 'MATCH' ? parts[1] : parts[2] || '').trim()
    let hit = false
    if (type === 'DOMAIN-SUFFIX') hit = isDomain && (host === val || host.endsWith('.' + val))
    else if (type === 'DOMAIN') hit = isDomain && host === val
    else if (type === 'DOMAIN-KEYWORD') hit = isDomain && host.includes(val.toLowerCase())   // mihomo 把关键词转小写再比
    else if (type === 'IP-CIDR') hit = v4 ? inCidr4(host, val) : v6 && val.toLowerCase() === host + '/128'
    else if (type === 'MATCH') hit = true
    else { unsure.push({ index: i, rule: rules[i], type }); continue }
    if (hit) return { q: host, kind: isDomain ? 'domain' : 'ip', index: i, total: rules.length, rule: rules[i], type, value: type === 'MATCH' ? '' : val, target, unsure }
  }
  return { q: host, kind: isDomain ? 'domain' : 'ip', index: -1, total: rules.length, rule: '', type: '', value: '', target: '', unsure }
}
// 命中的这条规则是从哪来的：站点设置里的直连 / 强制代理 / 本站域名，还是某条策略
// （引用的哪个域名集、额外域名、关键词）。规则测试页拿它告诉用户「要改去哪改」
async function ruleSource(m, prof) {
  if (!m.type || m.type === 'MATCH') return { kind: 'match' }
  const set = await loadSettings()
  const v = String(m.value || '').toLowerCase()
  if (m.type === 'IP-CIDR') return { kind: (set.directIPs || []).some(ip => v === ip + '/32') ? 'directIP' : 'builtin' }
  if (m.target === 'DIRECT' && v === set.domain) return { kind: 'self' }
  if (m.target === 'DIRECT' && (set.directDomains || []).includes(v)) return { kind: 'direct' }
  if (m.target === '🚀 节点选择' && (set.proxyDomains || []).includes(v)) return { kind: 'proxy' }
  const [pols, lib] = await Promise.all([loadPolicies(), loadLib()])
  const act = profilePolicies(prof, pols).filter(p => p.enabled !== false)
  const p = act.find(x => x.name === m.target || ruleName(x.name) === m.target)
  if (!p) return { kind: 'builtin' }
  if (m.type === 'DOMAIN-KEYWORD') return { kind: 'policy', policy: p.name, keyword: true }
  if (m.type === 'PROCESS-NAME') return { kind: 'policy', policy: p.name, process: true }
  const sets = (p.presets || []).filter(k => ((lib[k] || {}).domains || []).some(d => cleanDomain(d) === v || String(d).toLowerCase() === v)).map(k => (lib[k] || {}).name || k)
  return { kind: 'policy', policy: p.name, sets, extra: !sets.length }
}

// 生成好的配置里某个分组的成员，第一个是客户端里的默认选中项
function groupMembers(yamlText, name) {
  if (name === 'DIRECT' || name === 'REJECT') return []
  const lines = yamlText.split('\n')
  const unq = s => { s = s.trim(); try { return s.startsWith('"') ? JSON.parse(s) : s } catch (e) { return s.replace(/^"|"$/g, '') } }
  const from = lines.indexOf('proxy-groups:')
  for (let i = from + 1; i > 0 && i < lines.length && !/^\S/.test(lines[i]); i++) {
    const m = lines[i].match(/^ {2}- name: (.+)$/)
    if (!m || unq(m[1]) !== name) continue
    for (let j = i + 1; j < lines.length && !/^ {2}- /.test(lines[j]) && !/^\S/.test(lines[j]); j++) {
      const pm = lines[j].match(/^ {4}proxies: \[(.*)\]$/)
      if (!pm) continue
      try { return JSON.parse('[' + pm[1] + ']') } catch (e) { return pm[1].split(',').map(unq) }
    }
  }
  return []
}

// Clash 的 network + *-opts → sing-box transport。tcp 返回 null，走 sing-box 默认。
// sing-box 没有的传输（xhttp、tcp 上的 HTTP 伪装、kcp 等）返回 false，调用方整个节点剔除：
// 当成 tcp 硬连只会一直超时，而写一个它不认识的 type 会让整份配置加载失败。
function sbTransport(net, v) {
  net = String(net || '').toLowerCase()
  if (!net || net === 'tcp' || net === 'raw') return null
  if (net === 'ws') {
    const w = parseFlow(v('ws-opts'))
    const host = w.headers && (w.headers.Host || w.headers.host)
    // mihomo 把 httpupgrade 写成 ws 加 v2ray-http-upgrade 开关，sing-box 里是独立的传输
    if (String(w['v2ray-http-upgrade']) === 'true') {
      const t = { type: 'httpupgrade', path: w.path || '/' }
      if (host) t.host = host
      return t
    }
    const t = { type: 'ws', path: w.path || '/' }
    if (host) t.headers = { Host: host }
    return t
  }
  if (net === 'grpc') return { type: 'grpc', service_name: parseFlow(v('grpc-opts'))['grpc-service-name'] || '' }
  if (net === 'h2') {
    const h = parseFlow(v('h2-opts'))
    const t = { type: 'http' }
    if (h.path) t.path = Array.isArray(h.path) ? h.path[0] : h.path
    const hosts = [].concat(h.host || []).flatMap(x => String(x).replace(/^\[|\]$/g, '').split(',')).map(s => unquote(s.trim())).filter(Boolean)
    if (hosts.length) t.host = hosts
    return t
  }
  return false
}

// Clash 的 ports（`443,20000-30000`，也有人用 / 分隔）→ sing-box server_ports（`["443:443","20000:30000"]`）
function sbPorts(s) {
  const out = []
  for (const part of String(s || '').split(/[,/]/)) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/)
    if (!m) continue
    const a = +m[1], b = m[2] === undefined ? a : +m[2]
    if (a >= 1 && b <= 65535 && a <= b) out.push(`${a}:${b}`)
  }
  return out
}

// sing-box 认得的取值。认不出的值 sing-box 不是跳过，而是拒绝加载整份配置
const SB_UTLS = new Set(['chrome', 'chrome_psk', 'chrome_psk_shuffle', 'chrome_padding_psk_shuffle', 'chrome_pq', 'chrome_pq_psk', 'firefox', 'edge', 'safari', '360', 'qq', 'ios', 'android', 'random', 'randomized'])
const SB_SS = new Set(['aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb', 'rc4-md5', 'chacha20-ietf', 'xchacha20', 'none'])
const SB_SS_ALIAS = { 'chacha20-poly1305': 'chacha20-ietf-poly1305', 'xchacha20-poly1305': 'xchacha20-ietf-poly1305', dummy: 'none', plain: 'none' }
const SB_VMESS = new Set(['auto', 'none', 'zero', 'aes-128-cfb', 'aes-128-gcm', 'chacha20-poly1305'])

// Clash 的 ss 插件 → sing-box 的 plugin + plugin_opts（SIP003 串，; = \ 要转义）。
// sing-box 只内置 obfs-local 与 v2ray-plugin；shadow-tls / restls / kcptun 等返回 null，节点剔除。
function sbPlugin(name, o) {
  const esc = x => String(x).replace(/[\\;=]/g, '\\$&')
  const join = a => a.filter(Boolean).join(';')
  name = String(name || '').toLowerCase()
  if (name === 'obfs' || name === 'obfs-local' || name === 'simple-obfs') {
    const mode = String(o.mode || 'http').toLowerCase()
    if (mode !== 'http' && mode !== 'tls') return null
    return { plugin: 'obfs-local', plugin_opts: join(['obfs=' + mode, o.host ? 'obfs-host=' + esc(o.host) : '']) }
  }
  if (name === 'v2ray-plugin') {
    if (String(o.mode || 'websocket').toLowerCase() !== 'websocket') return null
    return { plugin: 'v2ray-plugin', plugin_opts: join(['mode=websocket', String(o.tls) === 'true' ? 'tls' : '',
      o.host ? 'host=' + esc(o.host) : '', o.path ? 'path=' + esc(o.path) : '', String(o.mux) === 'true' ? 'mux=1' : '']) }
  }
  return null
}

// Clash 节点 → sing-box outbound。认不出的协议返回 null，
// 调用方必须连带把这个节点从所有分组里剔掉（见 genSB 开头）。
function toSB(n) {
  const v = k => n.kv[k] === undefined ? undefined : unquote(n.kv[k])
  const t = v('type')
  const base = { tag: n.name, server: v('server'), server_port: parseInt(v('port'), 10) }
  if (!base.server || !(base.server_port > 0 && base.server_port < 65536)) return null

  // sni 与 servername 两个字段名都要认：Clash 里 trojan/hysteria2 写 sni，
  // vless 写 servername，机场给哪个取决于它用的是哪个生成器
  const sni = v('sni') || v('servername')
  const ro = parseFlow(v('reality-opts'))
  const tls = { enabled: true, insecure: v('skip-cert-verify') === 'true' }
  if (sni) tls.server_name = sni
  // mihomo 的 client-fingerprint 还可以是 none（不用 uTLS），也可能是 sing-box 不认的名字
  let fp = String(v('client-fingerprint') || '').toLowerCase()
  if (fp === 'none') fp = ''
  if (fp && !SB_UTLS.has(fp)) fp = 'chrome'
  if (fp) tls.utls = { enabled: true, fingerprint: fp }
  if (ro['public-key']) {
    tls.reality = { enabled: true, public_key: ro['public-key'], short_id: ro['short-id'] || '' }
    // Reality 客户端必须走 uTLS：机场没给 client-fingerprint 时 sing-box 报 uTLS is required by reality client
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: 'chrome' }
  }

  if (t === 'anytls') return { type: 'anytls', ...base, password: v('password'), tls }
  if (t === 'hysteria2') {
    const o = { type: 'hysteria2', ...base, password: v('password'), tls }
    // 类型和密码缺一不可（缺密码 sing-box 报 missing obfs password）；1.12 起只认 salamander
    if (v('obfs') && v('obfs-password')) {
      if (v('obfs') !== 'salamander') return null
      o.obfs = { type: 'salamander', password: v('obfs-password') }
    }
    const sp = sbPorts(v('ports'))           // 端口跳跃
    if (sp.length) o.server_ports = sp
    return o
  }
  const tr = sbTransport(v('network'), v)
  if (tr === false) return null
  if (t === 'trojan') {
    const o = { type: 'trojan', ...base, password: v('password'), tls }
    if (tr) o.transport = tr
    return o
  }
  if (t === 'vmess') {
    // TLS 与 transport 以前都没带过。机场的 vmess 十有八九是 ws+tls，
    // 缺了这两样 outbound 生成得出来却连不上，比直接丢掉更难排查。
    const security = String(v('cipher') || 'auto').toLowerCase()
    if (!SB_VMESS.has(security)) return null
    const o = { type: 'vmess', ...base, uuid: v('uuid'), security, alter_id: parseInt(v('alterId') || '0', 10) || 0 }
    if (v('tls') === 'true') o.tls = tls
    if (tr) o.transport = tr
    return o
  }
  if (t === 'vless') {
    // sing-box 的流控只有 xtls-rprx-vision。udp443 变体只是多放行 UDP 443，归一过去；
    // 别的流控它不认，写进去整份配置加载失败，只能剔除
    let flow = v('flow') || ''
    if (flow === 'xtls-rprx-vision-udp443') flow = 'xtls-rprx-vision'
    if (flow && flow !== 'xtls-rprx-vision') return null
    const o = { type: 'vless', ...base, uuid: v('uuid'), packet_encoding: 'xudp' }
    if (flow) o.flow = flow
    if (v('tls') === 'true' || tls.reality || sni) o.tls = tls
    if (tr) o.transport = tr
    return o
  }
  if (t === 'ss') {
    const raw = String(v('cipher') || '').toLowerCase()
    const method = SB_SS_ALIAS[raw] || raw
    if (!SB_SS.has(method)) return null
    const o = { type: 'shadowsocks', ...base, method, password: v('password') }
    if (v('plugin')) {
      const p = sbPlugin(v('plugin'), parseFlow(v('plugin-opts')))
      if (!p) return null
      Object.assign(o, p)
    }
    return o
  }
  return null
}

// 自有节点 → sing-box outbound；转不出的返回 null（调用方连同分组引用一起剔除）
function ownToSB(n) {
  if (n.type === 'vless') {
    if (n.net === 'ws') {
      const host = n.host || n.sni || n.s
      return { type: 'vless', tag: n.name, server: n.s, server_port: n.p, uuid: n.u, packet_encoding: 'xudp', tls: { enabled: true, server_name: n.sni || n.s, utls: { enabled: true, fingerprint: 'chrome' } }, transport: { type: 'ws', path: n.path || '/', headers: { Host: host }, max_early_data: 2048, early_data_header_name: 'Sec-WebSocket-Protocol' } }
    }
    // xhttp：sing-box 没有这个传输，写 {type:'xhttp'} 整份配置加载失败 —— 剔除
    if (n.net !== 'tcp') return null
    let flow = n.flow || ''
    if (flow === 'xtls-rprx-vision-udp443') flow = 'xtls-rprx-vision'
    if (flow && flow !== 'xtls-rprx-vision') return null
    // tcp 不写 transport：sing-box 没有叫 tcp 的 transport，写了报 unknown transport type
    const o = { type: 'vless', tag: n.name, server: n.s, server_port: n.p, uuid: n.u, packet_encoding: 'xudp', tls: { enabled: true, server_name: n.sni, utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: n.pk, short_id: n.sid } } }
    if (flow) o.flow = flow
    return o
  }
  const o = { type: 'hysteria2', tag: n.name, server: n.s, server_port: n.p, password: n.u, tls: { enabled: true, server_name: n.sni, insecure: true } }
  if (n.obfs && n.opwd) {
    if (n.obfs !== 'salamander') return null
    o.obfs = { type: 'salamander', password: n.opwd }
  }
  const sp = sbPorts(n.ports)
  if (sp.length) o.server_ports = sp
  return o
}

// DNS 地址（与 Clash 共用的那套写法）→ sing-box 1.12 起的 DNS server。
// 旧写法 address / address_resolver / strategy 在 1.14 已移除，整份配置直接加载不了。
// 服务器是域名时要用 domain_resolver 指定谁来解析它。
function sbDnsServer(tag, addr, resolver) {
  const a = String(addr || '').trim()
  const m = a.match(/^([a-z0-9]+):\/\/(.+)$/i)
  let o
  if (!m) o = { type: 'udp', server: bareHost(a) }
  else {
    const type = { https: 'https', tls: 'tls', quic: 'quic', h3: 'h3', tcp: 'tcp', udp: 'udp' }[m[1].toLowerCase()]
    let u = null
    try { u = new URL('http://' + m[2]) } catch (e) {}
    if (!type || !u || !u.hostname) return { tag, type: 'local' }
    o = { type, server: bareHost(u.hostname) }
    if (u.port) o.server_port = +u.port
    if ((type === 'https' || type === 'h3') && u.pathname && u.pathname !== '/' && u.pathname !== '/dns-query') o.path = u.pathname
  }
  if (resolver && o.server && !looksIP(o.server)) o.domain_resolver = resolver
  return { tag, ...o }
}

// 官方规则集（SagerNet 的 rule-set 分支），替代 1.12 移除的 geoip / geosite 数据库
const sbRuleSet = (tag, repo) => ({
  tag, type: 'remote', format: 'binary',
  url: 'https://raw.githubusercontent.com/SagerNet/' + repo + '/rule-set/' + tag + '.srs',
  download_detour: '🚀 节点选择'
})

// 目标 sing-box 1.12+（anytls 本身就要 1.12），兼容到 1.14：
// DNS 用新格式、geoip/geosite 换规则集、嗅探与 DNS 劫持用规则动作、必须有 default_domain_resolver
function genSB(up, policies, lib, own, st, chains, pool) {
  const SET = { ...DEFAULT_SETTINGS, ...(st || {}) }
  const D = { ...DEFAULT_DNS, ...(SET.dns || {}) }
  // 转不出 outbound 的节点必须在这里就整个剔掉，后面所有分组都基于过滤后的 up。
  // 只 filter(Boolean) 掉 outbound、却让地区组继续按全量节点取名字，
  // 就会引用一堆不存在的 tag —— sing-box 是拒绝加载整份配置，不是跳过那几个。
  // 少几个节点还能用，配置非法是一点都不能用。
  const conv = up.map(n => ({ n, o: toSB(n) })).filter(x => x.o)
  up = conv.map(x => x.n)
  const upOut = conv.map(x => x.o)
  // 自有节点同理（xhttp 在 sing-box 里没有对应传输）。之后解析策略目标、DNS 出口都只看转出来的，
  // 被剔除的节点在 strict 策略里照旧回落到「🚀 节点选择」，不留悬空引用
  const ownOut = [], ownKept = {}
  for (const [k, n] of Object.entries(own || {})) { const o = ownToSB(n); if (o) { ownOut.push(o); ownKept[k] = n } }
  const ownN = Object.values(ownKept).map(n => n.name)
  const liveR = REGIONS.filter(r => up.some(n => n.region === r.key))
  const liveKeys = liveR.map(r => r.key)
  // 链式 outbound：复制落地节点的 outbound，改 tag，加 detour 指向中转。
  // 落地本身转不出 outbound（协议不认识）时整条链跳过，绝不留悬空引用。
  const chOut = []
  for (const c of resolveChains(chains, pool || up, ownKept, liveKeys)) {
    const o = toSB({ ...c.land, name: c.name })
    if (!o) continue
    o.detour = c.via === 'DIRECT' ? 'direct-out' : c.via === 'REJECT' ? 'block-out' : c.via
    chOut.push(o)
  }
  const ch = chOut.map(o => ({ id: (chains || []).find(x => x.name === o.tag)?.id, name: o.tag }))
  const allN = [...ownN, ...upOut.map(o => o.tag), ...chOut.map(o => o.tag)]
  const regionNames = liveR.map(r => `${r.flag} ${r.cn}`)
  const act = (policies || []).filter(p => p.enabled !== false)

  // Clash 里的 DIRECT / REJECT 在 sing-box 中是具名 outbound
  const mapTag = t => t === 'DIRECT' ? 'direct-out' : t === 'REJECT' ? 'block-out' : t

  const outbounds = [
    { type: 'direct', tag: 'direct-out' },
    { type: 'block', tag: 'block-out' },
    ...ownOut,
    ...upOut,
    ...chOut
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
    const t = resolveTargets(p, liveKeys, ownKept, ch)
    outbounds.push({
      type: 'selector', tag: p.name,
      outbounds: policyMembers(p, t, allN, regionNames).map(mapTag)
    })
  })

  const dl = a => [...new Set((a || []).flatMap(splitDomains))]
  const SELF = cleanDomain(SET.domain)
  const forced = dl(SET.proxyDomains)
  const direct = [...(SELF ? [SELF] : []), ...dl(SET.directDomains)].filter(d => !forced.includes(d))
  const directIPs = (SET.directIPs || []).filter(ip => /^(\d{1,3}\.){3}\d{1,3}$/.test(String(ip)))
  const rules = [
    // 入站上的 sniff 在 1.13 起报错。嗅探与 DNS 劫持都改成规则动作，必须排在最前：
    // 后面的域名规则要靠嗅探拿到域名，hijack-dns 要靠嗅探认出 DNS 流量
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },
    // tun 接管了整台设备，本机与局域网地址必须直连（Clash 那边的 127.0.0.1 / ::1 直连同理）
    { ip_is_private: true, outbound: 'direct-out' }
  ]
  // 与 Clash 那边一致：强制代理排在所有直连规则之前
  if (forced.length) rules.push({ domain_suffix: forced, outbound: '🚀 节点选择' })
  if (direct.length) rules.push({ domain_suffix: direct, outbound: 'direct-out' })
  if (directIPs.length) rules.push({ ip_cidr: directIPs.map(x => x + '/32'), outbound: 'direct-out' })
  act.forEach(p => {
    const doms = policyDomains(p, lib)
    if (doms.length) rules.push({ domain_suffix: doms, outbound: p.name })
    const kw = (p.keywords || []).map(x => String(x).trim()).filter(Boolean)
    if (kw.length) rules.push({ domain_keyword: kw, outbound: p.name })
    const ps = (p.processes || []).map(x => String(x).trim()).filter(Boolean)
    if (ps.length) rules.push({ process_name: ps, outbound: p.name })
  })
  // geoip / geosite 数据库在 1.12 移除，换成官方远程规则集
  rules.push({ rule_set: ['geosite-cn', 'geoip-cn'], outbound: 'direct-out' })

  const fake = D.fakeIp !== false
  // 引导 DNS 只能是纯 IP：它负责解析其它 DNS 服务器和节点的域名，自己再依赖解析就成了死循环
  const bootIP = (D.bootstrap || []).map(x => String(x).trim()).find(x => /^(\d{1,3}\.){3}\d{1,3}$/.test(x) || /^[0-9a-f]*:[0-9a-f:]*$/i.test(x)) || '223.5.5.5'
  // 境外 DNS 的查询走代理（与 Clash 的 #🚀 节点选择 后缀同一个开关）；关掉就直连。
  // 新格式的 DNS server 默认直连，不能再写 detour: direct-out（报 detour to an empty direct outbound）
  const remote = sbDnsServer('dns-remote', (D.remote || [])[0], 'dns-resolver')
  if (D.remoteViaProxy !== false) remote.detour = aiPrimary(ownKept)

  return JSON.stringify({
    log: { level: 'warn' },
    // DNS 防泄漏：dns-remote 经代理出口查询；dns-resolver 仅直连解析节点域名，
    // 其余交给 fakeip，真实解析在代理节点侧完成。
    // 与 Clash 共用同一份 DNS 设置，字段名在这里做映射：
    // remote→dns-remote、domestic→dns-direct、bootstrap→dns-resolver
    dns: {
      servers: [
        remote,
        sbDnsServer('dns-direct', (D.domestic || [])[0], 'dns-resolver'),
        { tag: 'dns-resolver', type: 'udp', server: bootIP },
        // 关掉 fake-ip 时连 server 带规则一起不写，不留一个没人用、也没人能解释的 fakeip
        ...(fake ? [{ tag: 'dns-fake', type: 'fakeip', inet4_range: '198.18.0.0/15', inet6_range: 'fc00::/18' }] : [])
      ],
      rules: [
        // 本站域名以前写死走 dns-resolver（国内明文），和 Clash 那边是同一个坑
        ...(SELF ? [{ domain_suffix: [SELF], server: sbDnsTag(D.selfGroup) }] : []),
        ...(D.policies || []).filter(p => p && p.domain && D[p.group] && cleanDomain(p.domain)).map(p => ({
          domain_suffix: [cleanDomain(p.domain)],
          server: sbDnsTag(p.group)
        })),
        ...(fake ? [{ query_type: ['A', 'AAAA'], server: 'dns-fake' }] : [])
      ],
      final: 'dns-remote',
      strategy: 'prefer_ipv4'
    },
    inbounds: [
      // 官方图形客户端（SFI / SFA / SFM）靠 tun 接管设备流量，只有一个 mixed 监听它们什么也接管不了
      { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'], auto_route: true, strict_route: true, stack: 'mixed' },
      { type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: 2080 }
    ],
    outbounds,
    route: {
      rules,
      rule_set: [sbRuleSet('geosite-cn', 'sing-geosite'), sbRuleSet('geoip-cn', 'sing-geoip')],
      final: '🚀 节点选择',
      auto_detect_interface: true,
      // 节点服务器域名、直连目标的解析。1.14 起缺了它直接报错（以前靠 DNS 规则里的 outbound: any，1.14 已移除）
      default_domain_resolver: 'dns-resolver'
    },
    // 远程规则集要落盘缓存，否则每次启动都得重新下载；fake-ip 的映射也存下来，
    // 重启后应用手里还攥着旧的 fake IP，查不到映射就连不上（missing fakeip record）
    experimental: { cache_file: { enabled: true, ...(fake ? { store_fakeip: true } : {}) } }
  }, null, 2)
}

// ---------- Shadowrocket 原生 conf ----------
// iOS 吃 INI-like .conf，不吃 Clash YAML：fake-ip / GEOSITE / PROCESS-NAME /
// Reality 块字段对不齐，硬并进 clash 分支会让小火箭表现为「订阅能下、规则全失效」。
function srName(s) {
  return String(s || '').replace(/,/g, '，').replace(/=/g, '＝').trim()
}
function srParam(k, v) {
  if (v === undefined || v === null || v === '') return null
  const s = String(v)
  if (/[\n,]/.test(s)) return `${k}="${s.replace(/"/g, '')}"`
  return `${k}=${s}`
}
function srLine(name, type, server, port, params) {
  if (!type || server === undefined || server === null || server === '' || port === undefined || port === null || port === '') return null
  return `${srName(name)} = ${[type, String(server), String(port), ...(params || []).filter(Boolean)].join(', ')}`
}
function srNetOk(net) {
  const n = String(net || 'tcp').toLowerCase()
  return n === 'tcp' || n === 'ws' || n === 'none' || n === ''
}
function srWsParams(net, ws) {
  if (String(net || '').toLowerCase() !== 'ws') return []
  const host = (ws && ws.headers && (ws.headers.Host || ws.headers.host)) || ''
  const path = (ws && ws.path) || ''
  return ['obfs=ws', path ? srParam('obfs-path', path) : null, host ? srParam('obfs-header', host) : null]
}

function ownToSR(n) {
  if (!n) return null
  if (n.type === 'vless') {
    if (!srNetOk(n.net)) return null
    if (!n.u || !n.s || !n.p) return null
    const params = [
      srParam('password', n.u),
      'udp=true',
      'tls=true',
      n.sni ? srParam('peer', n.sni) : null,
      n.pk ? srParam('public-key', n.pk) : null,
      n.sid ? srParam('short-id', n.sid) : null,
      n.flow ? srParam('flow', n.flow) : null,
      ...srWsParams(n.net, { path: n.path, headers: n.host ? { Host: n.host } : undefined })
    ]
    return srLine(n.name, 'vless', n.s, n.p, params)
  }
  if (n.type === 'hysteria2' || n.type === 'hy2') {
    if (!n.u || !n.s || !n.p) return null
    const params = [
      srParam('auth', n.u),
      n.sni ? srParam('peer', n.sni) : null,
      'insecure=true',
      'udp=true',
      // 混淆类型与密码缺一不可，只有一半等于配错
      n.obfs && n.opwd ? srParam('obfs', n.obfs) : null,
      n.obfs && n.opwd ? srParam('obfs-password', n.opwd) : null,
      n.ports ? srParam('mport', n.ports) : null
    ]
    return srLine(n.name, 'hysteria2', n.s, n.p, params)
  }
  return null
}

function airportToSR(n) {
  if (!n || !n.kv) return null
  const v = k => n.kv[k] === undefined ? undefined : unquote(n.kv[k])
  const t = v('type')
  const server = v('server')
  const port = v('port')
  const sni = v('sni') || v('servername')
  const insecure = v('skip-cert-verify') === 'true'
  const net = v('network') || 'tcp'
  const ws = parseFlow(v('ws-opts'))
  // mihomo 把 httpupgrade 写成 ws 加开关；Shadowrocket 按 ws 握手连不上，和以前一样跳过
  if (String(ws['v2ray-http-upgrade']) === 'true') return null
  const ro = parseFlow(v('reality-opts'))
  const udp = v('udp') !== 'false'

  if (t === 'ss') {
    const plugin = v('plugin') || v('obfs')
    if (plugin && plugin !== 'none' && plugin !== 'plain') return null
    if (!v('cipher') || !v('password')) return null
    return srLine(n.name, 'ss', server, port, [
      srParam('encrypt-method', v('cipher')),
      srParam('password', v('password')),
      udp ? 'udp=true' : null
    ])
  }
  if (t === 'vmess') {
    if (!srNetOk(net)) return null
    if (!v('uuid')) return null
    const tls = v('tls') === 'true' || !!sni
    return srLine(n.name, 'vmess', server, port, [
      srParam('username', v('uuid')),
      tls ? 'tls=true' : 'tls=false',
      sni ? srParam('peer', sni) : null,
      ...(String(net).toLowerCase() === 'ws' ? srWsParams(net, ws) : ['obfs=none']),
      udp ? 'udp=true' : null
    ])
  }
  if (t === 'vless') {
    if (!srNetOk(net)) return null
    if (!v('uuid')) return null
    const isReality = !!ro['public-key']
    const tls = v('tls') === 'true' || isReality || !!sni
    return srLine(n.name, 'vless', server, port, [
      srParam('password', v('uuid')),
      udp ? 'udp=true' : null,
      tls ? 'tls=true' : null,
      sni ? srParam('peer', sni) : null,
      ro['public-key'] ? srParam('public-key', ro['public-key']) : null,
      ro['short-id'] ? srParam('short-id', ro['short-id']) : null,
      v('flow') ? srParam('flow', v('flow')) : null,
      ...srWsParams(net, ws)
    ])
  }
  if (t === 'trojan') {
    if (!srNetOk(net)) return null
    if (!v('password')) return null
    return srLine(n.name, 'trojan', server, port, [
      srParam('password', v('password')),
      'tls=true',
      sni ? srParam('peer', sni) : null,
      insecure ? 'insecure=true' : null,
      udp ? 'udp=true' : null,
      ...srWsParams(net, ws)
    ])
  }
  if (t === 'hysteria2' || t === 'hy2') {
    const pwd = v('password') || v('auth')
    if (!pwd) return null
    return srLine(n.name, 'hysteria2', server, port, [
      srParam('auth', pwd),
      sni ? srParam('peer', sni) : null,
      insecure ? 'insecure=true' : null,
      'udp=true',
      v('obfs') && v('obfs-password') ? srParam('obfs', v('obfs')) : null,
      v('obfs') && v('obfs-password') ? srParam('obfs-password', v('obfs-password')) : null,
      v('ports') ? srParam('mport', v('ports')) : null
    ])
  }
  if (t === 'anytls') {
    // Shadowrocket 2.2.65+ 认 anytls；参数齐才能写，缺 password/server 就跳过，绝不半成品。
    if (!v('password')) return null
    return srLine(n.name, 'anytls', server, port, [
      srParam('password', v('password')),
      sni ? srParam('sni', sni) : null,
      insecure ? 'insecure=true' : null,
      udp ? 'udp=true' : null
    ])
  }
  return null
}

function genSR(blacklist, up, policies, lib, own, st, chains, pool) {
  const SET = { ...DEFAULT_SETTINGS, ...(st || {}) }
  const D = { ...DEFAULT_DNS, ...(SET.dns || {}) }
  const FORCED = SET.proxyDomains || []
  // 链式在 SR 里没有忠实的 Relay 映射：硬塞落地会变成不带中转的直连、出口 IP 全变，故整条略过（同 genShare）。
  void chains
  void pool

  const ownSR = {}
  for (const [k, n] of Object.entries(own || {})) ownSR[k] = { ...n, name: srName(n.name) }

  // 只有真的写进 [Proxy] 的自有节点才能被分组引用。以前 xhttp 这类转不出来的节点
  // 不在 [Proxy] 里，策略组却照样指向它 —— 悬空引用
  const ownLines = [], ownNames = [], ownKept = {}
  for (const [k, n] of Object.entries(ownSR)) {
    const line = ownToSR(n)
    if (!line) continue
    ownLines.push(line)
    ownNames.push(n.name)
    ownKept[k] = n
  }

  const upLines = [], upKept = []
  for (const n of (up || [])) {
    const line = airportToSR(n)
    if (!line) continue
    const nn = { ...n, name: srName(n.name) }
    // 名字被清洗后要让行内的 NAME 对得上分组引用
    const reline = airportToSR(nn)
    upLines.push(reline || line)
    upKept.push(nn)
  }

  const liveR = REGIONS.filter(r => upKept.some(n => n.region === r.key))
  const liveKeys = liveR.map(r => r.key)
  const regionNames = liveR.map(r => `${r.flag} ${r.cn}`)
  const allN = [...ownNames, ...upKept.map(n => n.name)]
  const act = (policies || []).filter(p => p.enabled !== false)

  // Shadowrocket 的 dns-server 只认 IP / system。把 Clash 的 DoH URL 塞进去会让解析全挂，表现为「完全没网」。
  const dnsIP = [...(D.bootstrap || []), ...(D.domestic || []), ...(D.remote || []), '1.1.1.1', '8.8.8.8']
    .map(x => String(x).trim())
    .filter(x => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(x))
  const dnsServer = [...new Set(dnsIP.length ? dnsIP : ['223.5.5.5', '1.1.1.1', '8.8.8.8']), 'system'].join(', ')

  const groups = []
  // 默认选中列表第一项。地区 url-test（尤其日本机场）经常超时，放首位会让整机没网。
  // 自有节点在前，DIRECT 保底，机场地区组放后面。
  const selectMembers = [...ownNames, 'DIRECT', ...regionNames, ...upKept.map(n => n.name)].filter((x, i, a) => x && a.indexOf(x) === i)
  groups.push(`🚀 节点选择 = select, ${selectMembers.join(', ')}`)
  if (allN.length) {
    groups.push(`♻️ 自动选择 = url-test, ${allN.join(', ')}, url=http://www.gstatic.com/generate_204, interval=300, tolerance=50`)
  }
  for (const r of liveR) {
    const ns = upKept.filter(n => n.region === r.key).map(n => n.name)
    if (!ns.length) continue
    groups.push(`${r.flag} ${r.cn} = url-test, ${ns.join(', ')}, url=http://www.gstatic.com/generate_204, interval=300, tolerance=50`)
  }
  for (const p of act) {
    const t = resolveTargets(p, liveKeys, ownKept, null).map(srName)
    // 不要用 policyMembers：Clash 非严格组会塞进每一个节点，SR 组保持小。
    const mem = []
    const add = x => { if (x && !mem.includes(x)) mem.push(x) }
    t.forEach(add)
    if (!p.strict) { add('🚀 节点选择'); add('DIRECT') }
    groups.push(`${srName(p.name)} = select, ${mem.join(', ')}`)
  }

  const rules = []
  rules.push('IP-CIDR,127.0.0.1/32,DIRECT,no-resolve')
  rules.push('IP-CIDR,::1/128,DIRECT,no-resolve')
  for (const ip of (SET.directIPs || [])) {
    const cidr = String(ip).includes('/') ? ip : `${ip}/32`
    rules.push(`IP-CIDR,${cidr},DIRECT,no-resolve`)
  }
  for (const d of FORCED) rules.push(`DOMAIN-SUFFIX,${d},🚀 节点选择`)
  if (SET.domain && !FORCED.includes(SET.domain)) rules.push(`DOMAIN-SUFFIX,${SET.domain},DIRECT`)
  for (const d of (SET.directDomains || []).filter(d => !FORCED.includes(d))) rules.push(`DOMAIN-SUFFIX,${d},DIRECT`)
  for (const p of act) {
    const name = srName(p.name)
    policyDomains(p, lib).forEach(d => rules.push(`DOMAIN-SUFFIX,${d},${name}`))
    // 规则按逗号切字段，带逗号的关键词会让整条规则错位
    ;(p.keywords || []).map(ruleVal).filter(Boolean).forEach(k => rules.push(`DOMAIN-KEYWORD,${k},${name}`))
    // iOS 没有进程名匹配，不写 PROCESS-NAME
  }
  rules.push('GEOIP,CN,DIRECT')
  rules.push(blacklist ? 'FINAL,DIRECT' : 'FINAL,🚀 节点选择')

  return [
    `# 订阅由 Cloudflare Worker 生成（${blacklist ? '黑名单模式' : '白名单模式'}）`,
    `# 自有 ${ownNames.length} 节点 / 机场 ${upKept.length} 节点 / ${act.length} 条分流策略`,
    `[General]`,
    `bypass-system = true`,
    `skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local, captive.apple.com`,
    `tun-excluded-routes = 10.0.0.0/8, 127.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16`,
    `dns-server = ${dnsServer}`,
    `fallback-dns-server = system`,
    `ipv6 = false`,
    ``,
    `[Proxy]`,
    ...ownLines,
    ...upLines,
    ``,
    `[Proxy Group]`,
    ...groups,
    ``,
    `[Rule]`,
    ...rules
  ].join('\n')
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
      const qs = new URLSearchParams({ encryption: 'none' })
      if (o.net === 'ws') {
        // ws 节点走的是普通 TLS，不是 Reality。以前这里一律按 Reality 导出，
        // 带着 pbk=undefined、type=xhttp，导进任何客户端都连不上
        qs.set('security', 'tls'); qs.set('sni', o.sni || o.s); qs.set('fp', 'chrome')
        qs.set('type', 'ws'); qs.set('path', o.path || '/'); qs.set('host', o.host || o.sni || o.s)
      } else {
        qs.set('security', 'reality'); qs.set('sni', o.sni || ''); qs.set('fp', 'chrome')
        qs.set('pbk', o.pk || ''); qs.set('sid', o.sid || '')
        if (o.net === 'tcp') { qs.set('type', 'tcp'); if (o.flow) qs.set('flow', o.flow) }
        else { qs.set('type', 'xhttp'); qs.set('path', '/'); qs.set('mode', 'auto') }
      }
      return `vless://${encodeURIComponent(o.u)}@${hostPart(o.s)}:${o.p}?${qs}#${tag}`
    }
    const qs = new URLSearchParams({ sni: o.sni || '', insecure: '1' })
    if (o.obfs && o.opwd) { qs.set('obfs', o.obfs); qs.set('obfs-password', o.opwd) }
    if (o.ports) qs.set('mport', o.ports)
    return `hysteria2://${encodeURIComponent(o.u)}@${hostPart(o.s)}:${o.p}?${qs}#${tag}`
  }
  // 上游节点：这里是 parseShareLine 的逆运算，两边字段映射必须对得上，
  // 否则「订阅进来能用、导出去连不上」。
  const v = k => n.kv[k] === undefined ? undefined : unquote(n.kv[k])
  const t = v('type'), host = v('server'), port = v('port'), pwd = v('password')
  const sni = v('sni') || v('servername')
  const net = v('network') || 'tcp'
  const ws = parseFlow(v('ws-opts')), ro = parseFlow(v('reality-opts'))
  const wsHost = ws.headers && ws.headers.Host
  const upgrade = String(ws['v2ray-http-upgrade']) === 'true'
  const h2 = parseFlow(v('h2-opts')), xh = parseFlow(v('xhttp-opts')), ho = parseFlow(v('http-opts'))
  const grpcName = parseFlow(v('grpc-opts'))['grpc-service-name']
  const list = x => [].concat(x === undefined ? [] : x).map(String).filter(Boolean)
  const hoHost = list(ho.headers && (ho.headers.Host || ho.headers.host))

  const qs = new URLSearchParams()
  if (sni) qs.set('sni', sni)
  if (v('skip-cert-verify') === 'true') { qs.set('insecure', '1'); qs.set('allowInsecure', '1') }
  // 传输层参数不带上，ws / grpc / h2 / xhttp 节点导进客户端照样连不上
  const addTransport = () => {
    if (net === 'ws') {
      qs.set('type', upgrade ? 'httpupgrade' : 'ws')
      if (ws.path) qs.set('path', ws.path)
      if (wsHost) qs.set('host', wsHost)
    } else if (net === 'grpc') {
      qs.set('type', 'grpc')
      if (grpcName) qs.set('serviceName', grpcName)
    } else if (net === 'h2') {
      qs.set('type', 'h2')
      if (list(h2.path)[0]) qs.set('path', list(h2.path)[0])
      if (list(h2.host).length) qs.set('host', list(h2.host).join(','))
    } else if (net === 'xhttp') {
      qs.set('type', 'xhttp')
      if (xh.path) qs.set('path', xh.path)
      if (xh.host) qs.set('host', xh.host)
      if (xh.mode) qs.set('mode', xh.mode)
    } else if (net === 'http') {
      // tcp 上的 HTTP 伪装
      qs.set('type', 'tcp'); qs.set('headerType', 'http')
      if (list(ho.path).length) qs.set('path', list(ho.path).join(','))
      if (hoHost.length) qs.set('host', hoHost.join(','))
    } else if (net !== 'tcp') qs.set('type', net)
  }

  if (t === 'anytls')    return `anytls://${encodeURIComponent(pwd)}@${hostPart(host)}:${port}?${qs}#${tag}`
  if (t === 'trojan')    { addTransport(); return `trojan://${encodeURIComponent(pwd)}@${hostPart(host)}:${port}?${qs}#${tag}` }
  if (t === 'ss') {
    // SIP002：userinfo 用 URL 安全的 base64、不带 padding。标准 base64 里的 / 会截断主机部分
    const ui = b64utf8(v('cipher') + ':' + pwd).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    let plug = ''
    if (v('plugin')) {
      // 插件参数丢了，导出去的节点必然连不上；认不出的插件干脆不导出
      const p = sbPlugin(v('plugin'), parseFlow(v('plugin-opts')))
      if (!p) return null
      plug = '/?plugin=' + encodeURIComponent(p.plugin + (p.plugin_opts ? ';' + p.plugin_opts : ''))
    }
    return `ss://${ui}@${hostPart(host)}:${port}${plug}#${tag}`
  }
  if (t === 'hysteria2') {
    if (v('obfs') && v('obfs-password')) { qs.set('obfs', v('obfs')); qs.set('obfs-password', v('obfs-password')) }
    if (v('ports')) qs.set('mport', v('ports'))      // 端口跳跃
    return `hysteria2://${encodeURIComponent(pwd)}@${hostPart(host)}:${port}?${qs}#${tag}`
  }
  if (t === 'vless') {
    if (!v('uuid')) return null
    qs.set('encryption', 'none')
    qs.set('security', ro['public-key'] ? 'reality' : (v('tls') === 'true' ? 'tls' : 'none'))
    if (v('flow')) qs.set('flow', v('flow'))
    if (v('client-fingerprint')) qs.set('fp', v('client-fingerprint'))
    if (ro['public-key']) {
      qs.set('pbk', ro['public-key'])
      if (ro['short-id']) qs.set('sid', ro['short-id'])
    }
    addTransport()
    return `vless://${v('uuid')}@${hostPart(host)}:${port}?${qs}#${tag}`
  }
  if (t === 'vmess') {
    if (!v('uuid')) return null
    // v2rayN 的 JSON 约定：grpc 的 serviceName 放 path，h2 / HTTP 伪装的 host、path 各自放 host、path
    const j = { v: '2', ps: n.name, add: host, port: String(port), id: v('uuid'),
      aid: v('alterId') || '0', scy: v('cipher') || 'auto',
      net, type: 'none', host: wsHost || '', path: ws.path || '',
      tls: v('tls') === 'true' ? 'tls' : '', sni: sni || '' }
    if (net === 'ws' && upgrade) j.net = 'httpupgrade'
    else if (net === 'grpc') j.path = grpcName || ''
    else if (net === 'h2') { j.host = list(h2.host).join(','); j.path = list(h2.path)[0] || '' }
    else if (net === 'http') { j.net = 'tcp'; j.type = 'http'; j.host = hoHost.join(','); j.path = list(ho.path).join(',') }
    return 'vmess://' + b64utf8(JSON.stringify(j))
  }
  return null
}

function genShare(up, ownCfg, st) {
  const SET = { ...DEFAULT_SETTINGS, ...(st || {}) }
  const own = Object.values(ownCfg || {}).map(o => ({ name: o.name, own: true, o: { ...o, s: o.s } }))
  const links = [...own, ...up].map(shareLink).filter(Boolean)
  return b64utf8(links.join('\n'))
}

// ---------- 管理端页面 ----------

function adminHTML(authed, inited, needToken) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#faf9f7" id="tc">
<title>订阅聚合</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23b5532f'/%3E%3Cpath d='M9 10h6a4 4 0 0 1 4 4v8M9 22h6M23 10v12' stroke='%23fff' stroke-width='2.6' stroke-linecap='round' fill='none'/%3E%3C/svg%3E">
<script id="boot">
/* 主题在首帧之前定下来：放到页尾脚本里再切，暗色用户每次打开都会先闪一下白 */
(function(){var t='';try{t=localStorage.getItem('theme')||''}catch(e){}
var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.dataset.theme=d?'dark':'light'})()
</script>
<style>
:root{
  --bg:#faf9f7; --card:#fff; --bd:#e7e3dd; --bd2:#f0ede8;
  --tx:#1f1e1d; --tx2:#5f5b54; --tx3:#7b756d; --tx4:#aaa49b;
  --acc:#b5532f; --accH:#a0472a; --accBg:#fcf1ec; --accBd:#f0d6c9; --onAcc:#fff;
  --ok:#2f7a52; --okBg:#eef7f1; --okBd:#cfe6d8;
  --warn:#b03e2a; --warnBg:#fdf1ef; --warnBd:#f3d3cc;
  --hov:#f6f4f1; --sk:#efece7; --sel:#fcf1ec;
  --sh:0 1px 2px rgba(28,25,23,.04);
  --shM:0 16px 48px -12px rgba(28,25,23,.2),0 0 0 1px rgba(28,25,23,.05);
  --shT:0 8px 28px -8px rgba(28,25,23,.16),0 0 0 1px rgba(28,25,23,.06);
  --shP:0 10px 34px -10px rgba(28,25,23,.22),0 0 0 1px rgba(28,25,23,.07);
  --e:cubic-bezier(.16,1,.3,1);
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;
}
:root[data-theme="dark"]{
  --bg:#1b1a18; --card:#232220; --bd:#36332f; --bd2:#2c2a27;
  --tx:#efedea; --tx2:#b3ada4; --tx3:#948e85; --tx4:#6c675f;
  --acc:#e8896a; --accH:#f09a7d; --accBg:#33251f; --accBd:#4d3428; --onAcc:#1b1a18;
  --ok:#6cc08b; --okBg:#1f2b23; --okBd:#2d4234;
  --warn:#ef9480; --warnBg:#32211e; --warnBd:#4c2d27;
  --hov:#2a2825; --sk:#2c2a27; --sel:#3a2a23;
  --sh:0 1px 2px rgba(0,0,0,.2);
  --shM:0 16px 48px -12px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.07);
  --shT:0 8px 28px -8px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08);
  --shP:0 10px 34px -10px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.09);
  color-scheme:dark;
}
*{box-sizing:border-box;margin:0;padding:0}
[hidden]{display:none!important}
::selection{background:var(--sel);color:var(--acc)}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{background:var(--bg);color:var(--tx);font:15px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased;padding:34px max(24px,env(safe-area-inset-right)) 72px max(24px,env(safe-area-inset-left));min-height:100vh}
.wrap{max-width:880px;margin:0 auto}
.ic{width:15px;height:15px;flex-shrink:0;stroke-width:2;display:block}
.ic.s{width:13.5px;height:13.5px}
.ic.l{width:20px;height:20px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

.top{display:flex;align-items:flex-start;gap:16px;margin-bottom:4px}
.brand{display:flex;align-items:center;gap:11px;min-width:0}
.logo{width:34px;height:34px;border-radius:10px;background:var(--acc);color:var(--onAcc);display:grid;place-items:center;flex-shrink:0;box-shadow:0 4px 14px -6px var(--acc)}
.logo .ic{width:19px;height:19px;stroke-width:2.4}
h1{font-size:20px;font-weight:650;letter-spacing:-.015em;line-height:1.25}
.lede{color:var(--tx2);font-size:13px;margin-top:3px;display:flex;flex-wrap:wrap;gap:2px 0}
.lede b{color:var(--tx);font-weight:550;font-variant-numeric:tabular-nums}
.lede .sep{margin:0 7px;color:var(--tx4)}
.lede .bad{color:var(--warn);cursor:pointer;display:inline-flex;align-items:center;gap:4px;border-radius:5px}
.lede .bad:hover{text-decoration:underline;text-underline-offset:3px}
.top .sp{margin-left:auto;flex-shrink:0;display:flex;gap:2px}

/* Tab：窄屏上可以横向滑，不折行 */
.tabs{display:flex;gap:2px;margin-top:20px;border-bottom:1px solid var(--bd);overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.tabs::-webkit-scrollbar{display:none}
.tab{background:none;border:none;color:var(--tx3);font-size:13.5px;font-weight:500;padding:8px 13px 11px;border-radius:0;position:relative;cursor:pointer;transition:color .16s var(--e);flex-shrink:0}
.tab:hover{color:var(--tx);background:none}
.tab.on{color:var(--acc)}
.tab.on::after{content:'';position:absolute;left:11px;right:11px;bottom:-1px;height:2px;background:var(--acc);border-radius:2px 2px 0 0}
.tab:active{transform:none}
.tab .cnt{font-size:11px;color:var(--tx4);margin-left:4px;font-variant-numeric:tabular-nums;font-weight:500}
.tab.on .cnt{color:inherit;opacity:.7}
.tab .pip{position:absolute;top:8px;right:6px;width:6px;height:6px;border-radius:50%;background:var(--warn)}

.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:19px 21px;margin-top:16px;box-shadow:var(--sh)}
.card.danger{border-color:var(--warnBd)}
.ttl{display:flex;align-items:center;flex-wrap:wrap;gap:8px 9px;font-size:14px;font-weight:600;margin-bottom:14px;letter-spacing:-.005em;min-height:30px}
.ttl .sp{margin-left:auto;display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.ttl .sub{font-weight:400;font-size:12px;color:var(--tx3)}
.desc{color:var(--tx3);font-size:12.5px;margin:-8px 0 14px;line-height:1.7}
.desc b{color:var(--tx2);font-weight:550}

button{font:inherit;font-size:13.5px;font-weight:500;cursor:pointer;white-space:nowrap;border-radius:9px;padding:8px 15px;border:1px solid transparent;background:var(--acc);color:var(--onAcc);display:inline-flex;align-items:center;gap:6px;transition:background .16s var(--e),transform .12s var(--e),color .16s,border-color .16s,opacity .16s;-webkit-tap-highlight-color:transparent}
button:hover{background:var(--accH)}
button:active{transform:scale(.97)}
button:disabled{opacity:.5;cursor:default;transform:none}
button.g{background:var(--card);border-color:var(--bd);color:var(--tx2)}
button.g:hover{background:var(--hov);color:var(--tx);border-color:var(--tx4)}
button.dg{background:var(--warn);color:#fff}
button.dg:hover{background:var(--warn);opacity:.88}
:root[data-theme="dark"] button.dg{color:#1b1a18}
button.sm{padding:6px 11px;font-size:12.5px;border-radius:8px}
button.xs{padding:3px 8px;font-size:12px;border-radius:7px;gap:4px}
button:focus-visible,.chip:focus-visible,.rgh:focus-visible,.selo:focus-visible,.seg button:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.ib{width:30px;height:30px;padding:0;justify-content:center;border-radius:8px;background:transparent;border-color:transparent;color:var(--tx3)}
.ib:hover{background:var(--hov);color:var(--tx)}
.ib.dl:hover{background:var(--warnBg);color:var(--warn)}
.ib.on{color:var(--ok)}
.ib:active{transform:scale(.9)}
.spin{animation:spin .9s linear infinite}

/* 提示气泡：悬停与键盘聚焦都显示。纯 CSS，放在弹窗滚动区里会被裁，所以弹窗内不用它 */
[data-tip]{position:relative}
[data-tip]::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%) translateY(3px);background:var(--tx);color:var(--bg);font-size:11.5px;font-weight:500;line-height:1.35;padding:5px 8px;border-radius:6px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .16s var(--e),transform .16s var(--e);z-index:20}
[data-tip]:hover::after,[data-tip]:focus-visible::after{opacity:1;transform:translateX(-50%)}
[data-tip].tl::after{left:auto;right:0;transform:translateY(3px)}
[data-tip].tl:hover::after,[data-tip].tl:focus-visible::after{transform:none}
@media (hover:none){[data-tip]::after{display:none}}

input,textarea{font:inherit;font-size:13.5px;background:var(--card);color:var(--tx);border:1px solid var(--bd);border-radius:9px;padding:9px 12px;width:100%;outline:none;transition:border-color .16s var(--e),box-shadow .16s var(--e)}
textarea{resize:vertical;min-height:88px;line-height:1.7;font-family:var(--mono);font-size:12.5px}
input:hover,textarea:hover{border-color:var(--tx4)}
input:focus,textarea:focus{border-color:var(--acc);box-shadow:0 0 0 3.5px var(--accBg)}
input::placeholder,textarea::placeholder{color:var(--tx4)}
input:disabled{opacity:.55;cursor:not-allowed}
input.mono{font-family:var(--mono);font-size:12.5px}
.row{display:flex;gap:9px;align-items:center}
.lb{font-size:12px;font-weight:600;color:var(--tx2);margin-bottom:6px;display:block}
.lb .opt{font-weight:400;color:var(--tx3);margin-left:5px}

/* 搜索框 */
.search{position:relative;flex:1;min-width:150px;max-width:280px}
.search .ic{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--tx3);pointer-events:none}
.search input{padding:6px 28px 6px 31px;font-size:13px;border-radius:8px;height:32px}
.search .clr{position:absolute;right:3px;top:50%;transform:translateY(-50%);width:24px;height:24px}
.search input:placeholder-shown + .clr{display:none}

/* 分段选择 */
.seg{display:inline-flex;background:var(--bg);border:1px solid var(--bd2);border-radius:10px;padding:3px;gap:2px;max-width:100%;overflow-x:auto;scrollbar-width:none}
.seg::-webkit-scrollbar{display:none}
.seg button{background:none;border:0;color:var(--tx2);padding:5px 12px;font-size:12.5px;border-radius:7px;flex-shrink:0}
.seg button:hover{color:var(--tx);background:var(--hov)}
.seg button.on{background:var(--card);color:var(--tx);box-shadow:0 1px 3px rgba(28,25,23,.1),0 0 0 1px var(--bd2)}
.seg button:active{transform:none}

/* 自定义下拉 */
.sel{position:relative}
.selb{width:100%;justify-content:space-between;background:var(--card);border-color:var(--bd);color:var(--tx);font-weight:400;padding:9px 12px}
.selb > span{overflow:hidden;text-overflow:ellipsis}
.selb:hover{background:var(--card);border-color:var(--tx4);color:var(--tx)}
.selb .ic{color:var(--tx3);transition:transform .2s var(--e)}
.sel.open .selb{border-color:var(--acc);box-shadow:0 0 0 3.5px var(--accBg)}
.sel.open .selb .ic{transform:rotate(180deg)}
@keyframes popIn{from{opacity:0;transform:translateY(-5px) scale(.98)}to{opacity:1;transform:none}}
.selp{position:absolute;top:calc(100% + 5px);left:0;right:0;background:var(--card);border:1px solid var(--bd);border-radius:11px;box-shadow:var(--shP);padding:5px;z-index:30;max-height:250px;overflow:auto;animation:popIn .18s var(--e) both}
/* 打开时挪到 body 上，脱离弹窗的滚动裁剪区；位置由 JS 按触发器算 */
.selp.portal{position:fixed;top:auto;left:auto;right:auto;z-index:120}
.selo{padding:8px 10px;border-radius:7px;font-size:13.5px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background .12s}
.selo:hover,.selo.kb{background:var(--hov)}
.selo.on{color:var(--acc);font-weight:500}
/* 多选：左侧常驻复选框。只在选中时显示对勾的话，外观和单选毫无区别，
   用户根本看不出能多选。 */
.sel.multi .selo{position:relative;padding-left:11px}
.sel.multi .selo .ic{display:none}
.sel.multi .selo::before{content:'';flex-shrink:0;width:15px;height:15px;border-radius:4.5px;
  border:1.5px solid var(--bd);background:var(--card);transition:background .14s var(--e),border-color .14s var(--e)}
.sel.multi .selo::after{content:'';position:absolute;left:16px;top:50%;width:4px;height:8px;
  border:2px solid var(--onAcc);border-top:0;border-left:0;transform:translateY(-62%) rotate(45deg);
  opacity:0;transition:opacity .14s var(--e)}
.sel.multi .selo:hover::before{border-color:var(--tx4)}
.sel.multi .selo.on::before{background:var(--acc);border-color:var(--acc)}
.sel.multi .selo.on::after{opacity:1}
.sel.multi .selo.on{background:var(--accBg)}
.sel.multi .selp{padding-bottom:5px}
.selo .ic{opacity:0}
.selo.on .ic{opacity:1}

/* 多选 chips */
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid var(--bd);background:var(--card);color:var(--tx2);cursor:pointer;transition:all .14s var(--e);display:inline-flex;align-items:center;gap:5px;user-select:none}
.chip:hover{border-color:var(--tx4);color:var(--tx)}
.chip.on{background:var(--accBg);border-color:var(--accBd);color:var(--acc);font-weight:500}
.chip .n{opacity:.65;font-size:11px}

/* 策略行 */
.pol{display:flex;gap:11px;align-items:center;padding:11px 12px;border:1px solid var(--bd2);border-radius:11px;margin-bottom:7px;background:var(--card);transition:border-color .16s var(--e),background .16s var(--e),opacity .16s,box-shadow .16s var(--e)}
.pol:hover{border-color:var(--bd);background:var(--hov)}
/* 拖拽中：原行退成虚线空槽，作为落点指示。
   浏览器会另外渲染一张跟随鼠标的元素快照，原行若还留着淡淡的内容，
   两者叠在一起就是重影。用 opacity:0 抹掉内容但保留行高。 */
.pol.drag,.up.drag{background:var(--accBg);border:1.5px dashed var(--accBd);box-shadow:none}
.pol.drag > *,.up.drag > *{opacity:0}
.pol{cursor:default}
.pol[draggable="true"]{cursor:grabbing}
.pol.off{opacity:.5}
.grip{color:var(--tx4);cursor:grab;display:flex;padding:4px 2px;touch-action:none}
.grip:hover{color:var(--tx2)}
.grip:active{cursor:grabbing}
.pol .nm{font-weight:550;font-size:13.5px;min-width:112px}
.pol .meta{color:var(--tx3);font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pol .ord{font-size:11px;color:var(--tx4);font-variant-numeric:tabular-nums;width:16px;text-align:right;flex-shrink:0}
.arrow{color:var(--tx4);font-size:12px}
.tgt{font-size:12px;color:var(--tx2);background:var(--bg);border:1px solid var(--bd2);padding:2.5px 8px;border-radius:6px;white-space:nowrap}
.tgt.strict{background:var(--accBg);border-color:var(--accBd);color:var(--acc)}
.tgt.gone{background:var(--warnBg);border-color:var(--warnBd);color:var(--warn);text-decoration:line-through}
.tgt.okc{background:var(--okBg);border-color:var(--okBd);color:var(--ok)}
.tgts{display:flex;gap:4px;flex-wrap:wrap;min-width:0}

.sw{width:34px;height:20px;border-radius:11px;background:var(--bd);border:none;padding:0;position:relative;flex-shrink:0;transition:background .22s var(--e)}
.sw:hover{background:var(--tx4)}
.sw[data-on="1"]{background:var(--ok)}
.sw[data-on="1"]:hover{opacity:.85;background:var(--ok)}
.sw i{position:absolute;top:2.5px;left:2.5px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);transition:transform .22s var(--e)}
.sw[data-on="1"] i{transform:translateX(14px)}
.sw:active{transform:none}

.url{font:12.5px/1.6 var(--mono);background:var(--bg);border:1px solid var(--bd2);border-radius:9px;padding:11px 13px;color:var(--tx2);word-break:break-all}
.tips{color:var(--tx3);font-size:12.5px;margin-top:11px;display:flex;flex-wrap:wrap;gap:5px 14px}
.tips span{display:inline-flex;align-items:center;gap:6px}
code{background:var(--bg);border:1px solid var(--bd2);border-radius:5px;padding:1px 5px;font:11.5px var(--mono);color:var(--tx2)}

/* 列宽必须由父容器统一决定：每行各自 display:grid 时列宽只在行内计算，
   行与行之间不共享，于是名称长度一变，后面所有列就错开。
   subgrid 让每行沿用父容器的列轨道，多行才真正逐列对齐。 */
.uplist{display:grid;gap:7px}
.uplist.own{grid-template-columns:auto auto auto minmax(0,1fr) auto auto auto}
.uplist.src{grid-template-columns:auto auto auto minmax(0,1fr) auto auto auto auto auto auto}
.uplist.chain{grid-template-columns:auto auto minmax(0,1fr) auto auto auto auto}
.uplist.kv{grid-template-columns:auto minmax(0,1fr)}
.up.chain .hop{background:var(--bg);border:1px solid var(--bd2);border-radius:6px;padding:1.5px 7px;font-size:12px}
.up.chain .hop.gone{color:var(--warn);border-color:var(--warnBd);border-style:dashed}
.up.chain .arw{color:var(--tx4);margin:0 7px}
.uplist.lib{grid-template-columns:minmax(0,auto) minmax(0,1fr) auto auto auto}
.uplist > .blank,.uplist > .empty{grid-column:1/-1}
.pol.tdrag,.up.tdrag{box-shadow:var(--shP);background:var(--card);border-color:var(--accBd);position:relative;z-index:3}
.up{grid-column:1/-1;display:grid;grid-template-columns:subgrid;align-items:center;gap:11px;padding:10px 12px;border:1px solid var(--bd2);border-radius:10px;transition:border-color .16s var(--e),background .16s var(--e)}
.up:hover{border-color:var(--bd);background:var(--hov)}
.up .nm{font-weight:550;font-size:13.5px;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.up .u{color:var(--tx3);font:11.5px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.up .u.w{white-space:normal;word-break:break-all;font-family:inherit;font-size:12.5px;color:var(--tx2)}
.up .u.brk{white-space:normal;word-break:break-all;line-height:1.7}
.up .acts{display:flex;gap:1px;align-items:center}
.up.src .tgt{font-variant-numeric:tabular-nums;white-space:nowrap;justify-self:end}
.up.src .tgt.hot{background:var(--warnBg);border-color:var(--warnBd);color:var(--warn)}
.up.src .err{color:var(--warn);font:11.5px/1.5 inherit;margin-left:9px;white-space:nowrap}
/* 「手动」是状态说明不是强调，用中性色，跟 accent 色的「自定义」标签区分开 */
.tag.manual{background:var(--bg);color:var(--tx2);border-color:var(--bd2)}
.up.src .snap{margin-left:9px;color:var(--tx3);font-size:11.5px}
/* 用量拿不到时的占位，点进去看抓取诊断 */
.up.src .tgt.mute{color:var(--tx3);border-style:dashed;cursor:pointer;transition:color .15s,border-color .15s}
.up.src .tgt.mute:hover{color:var(--acc);border-color:var(--accBd)}
.up.src .tgt.lnk{cursor:pointer}
.up.src .tgt.lnk:hover{border-color:var(--tx4)}
/* 局部刷新期间给卡片一点反馈，但不换骨架屏——那会整块闪 */
#nodecard.busy,#chaincard.busy,.card.busy{opacity:.55;transition:opacity .2s;pointer-events:none}
.bar{height:4px;border-radius:2px;background:var(--bd2);overflow:hidden;width:46px;align-self:center}
.bar i{display:block;height:100%;background:var(--ok);border-radius:2px;transition:width .3s var(--e)}
.bar.hot i{background:var(--warn)}
.up.off .nm,.up.off .u{opacity:.45}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex-shrink:0;box-shadow:0 0 0 3px var(--okBg)}
.dot.bad{background:var(--warn);box-shadow:0 0 0 3px var(--warnBg)}
.up.off .dot{background:var(--tx4);box-shadow:none}

.rg{margin-bottom:17px}.rg:last-child{margin-bottom:0}
.rgh{display:flex;align-items:center;gap:8px;padding:6px 8px 8px;margin:0 -8px 3px;border-bottom:1px solid var(--bd2);cursor:pointer;user-select:none;border-radius:7px 7px 0 0;transition:background .14s var(--e)}
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
.nd .nm{font-size:13.5px;font-weight:500;min-width:124px;display:flex;align-items:center;min-width:0}
.nd .nm > span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nd .raw{color:var(--tx3);font-size:12.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.nd .proto{font:10.5px var(--mono);color:var(--tx3);background:var(--bg);border:1px solid var(--bd2);border-radius:5px;padding:0 5px;flex-shrink:0;text-transform:lowercase}
.nd .act{display:flex;gap:2px;align-items:center;opacity:0;transform:translateX(4px);transition:opacity .16s var(--e),transform .16s var(--e)}
.nd:hover .act,.nd:focus-within .act{opacity:1;transform:none}
/* 触屏没有悬停，操作按钮常驻，不然根本点不到 */
@media (hover:none){.nd .act{opacity:1;transform:none}}
.nd.off .nm,.nd.off .raw{opacity:.4}
.nd.off .act{opacity:1;transform:none}
.nd mark{background:var(--sel);color:inherit;border-radius:3px;padding:0 1px}
.tag{font-size:10.5px;padding:1.5px 6px;border-radius:5px;background:var(--accBg);color:var(--acc);border:1px solid var(--accBd);font-weight:500;margin-left:7px;white-space:nowrap;flex-shrink:0}
.tag.ok{background:var(--okBg);color:var(--ok);border-color:var(--okBd)}
.tag.warn{background:var(--warnBg);color:var(--warn);border-color:var(--warnBd)}
.tag.mute{background:var(--bg);color:var(--tx3);border-color:var(--bd2)}
.edit{width:170px;padding:3px 8px!important;font-size:13.5px!important;border-radius:6px!important}
.nfilter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:-4px 0 14px}
.nfilter .cnt{font-size:12px;color:var(--tx3);margin-left:auto}

.alert{background:var(--warnBg);border:1px solid var(--warnBd);color:var(--warn);padding:10px 14px;border-radius:10px;font-size:13px;margin-top:14px;display:flex;gap:8px;align-items:flex-start;line-height:1.6}
.alert .ic{margin-top:3px}
.alert.info{background:var(--bg);border-color:var(--bd2);color:var(--tx2)}
.alert.okc{background:var(--okBg);border-color:var(--okBd);color:var(--ok)}
.empty{color:var(--tx3);font-size:13px;padding:4px 0}
.blank{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:22px 12px 20px;color:var(--tx3);font-size:13px;border:1px dashed var(--bd);border-radius:11px}
.blank .ic{width:22px;height:22px;color:var(--tx4);margin-bottom:2px}
.blank b{color:var(--tx);font-weight:550;font-size:13.5px}
.blank button{margin-top:6px}
.hint{color:var(--tx3);font-size:12px;margin-top:7px;line-height:1.65}
.hint b{color:var(--tx2);font-weight:550}
.ferr{color:var(--warn);font-size:12px;margin-top:7px;line-height:1.6;font-weight:500}
input.bad,textarea.bad{border-color:var(--warnBd);background:var(--warnBg)}
input.bad:focus,textarea.bad:focus{border-color:var(--warn);box-shadow:0 0 0 3.5px var(--warnBg)}

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
.bd{position:fixed;inset:0;background:rgba(28,25,23,.34);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px;z-index:50;animation:bdIn .2s var(--e) both}
.bd.out{animation:bdOut .16s var(--e) both}
.md{background:var(--card);border-radius:15px;box-shadow:var(--shM);width:100%;max-width:400px;max-height:86vh;
  display:flex;flex-direction:column;overflow:hidden;animation:mdIn .26s var(--e) both}
.md.lg{max-width:540px}
.md.xl{max-width:760px}
/* 头尾 flex-shrink:0 固定，中间 min-height:0 才能真正滚动（flex 子项默认 min-height:auto 会撑破容器） */
.md .hd{padding:21px 23px 14px;flex-shrink:0;border-bottom:1px solid transparent;transition:border-color .18s var(--e);position:relative}
/* 右上角关闭。点遮罩不再关窗（见 modal 里的说明），这里是除「取消」外唯一的显式出口 */
.md .x{position:absolute;top:18px;right:16px}
.md .x.hint{background:var(--accBg);color:var(--acc)}
.md .ct{padding:0 23px;overflow-y:auto;flex:1;min-height:0;overscroll-behavior:contain}
.md.sc .hd{border-bottom-color:var(--bd2)}
.md.scb .ft{border-top-color:var(--bd2)}
.bd.out .md{animation:mdOut .16s var(--e) both}
.md h3{font-size:15.5px;font-weight:600;letter-spacing:-.01em;padding-right:34px}
.md p{color:var(--tx2);font-size:13.5px;margin-top:7px;line-height:1.6}
.md .bdy{padding:15px 0;display:flex;flex-direction:column;gap:9px}
.md .ft{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:14px 23px 20px;flex-shrink:0;border-top:1px solid transparent;transition:border-color .18s var(--e)}
.md .ft .left{margin-right:auto;display:flex;gap:6px}
.fg{margin-bottom:14px}.fg:last-child{margin-bottom:0}
.fsep{border:0;border-top:1px solid var(--bd2);margin:4px 0 18px}

/* 顶部居中 toast，位移动画放在 .toast 自身避免两层 transform 打架 */
.toasts{position:fixed;top:max(20px,env(safe-area-inset-top));left:12px;right:12px;z-index:160;display:flex;flex-direction:column;gap:9px;align-items:center;pointer-events:none}
@keyframes tIn{from{opacity:0;transform:translateY(-18px) scale(.94)}to{opacity:1;transform:none}}
@keyframes tOut{from{opacity:1;transform:none;max-height:60px;margin-bottom:0}to{opacity:0;transform:translateY(-14px) scale(.94);max-height:0;margin-bottom:-9px}}
.toast{display:flex;align-items:center;gap:8px;pointer-events:auto;background:var(--card);border:1px solid var(--bd);box-shadow:var(--shT);color:var(--tx);font-size:13px;font-weight:500;padding:9px 14px 9px 12px;border-radius:11px;max-width:380px;animation:tIn .32s var(--e) both;cursor:pointer}
.toast.out{animation:tOut .26s var(--e) both}
.toast .ic{color:var(--ok)}
.toast.err .ic{color:var(--warn)}

/* 订阅卡片 */
.prof{border:1px solid var(--bd2);border-radius:12px;padding:14px 15px;margin-bottom:9px;transition:border-color .16s var(--e),opacity .16s}
.prof:hover{border-color:var(--bd)}
.prof:last-child{margin-bottom:0}
.prof.off{opacity:.55}
.prof .hdr{display:flex;align-items:center;gap:8px;min-width:0}
.prof .hdr .nm{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prof .hdr .note{color:var(--tx3);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.prof .hdr .acts{margin-left:auto;display:flex;gap:1px;align-items:center;flex-shrink:0}
.prof .addr{display:flex;gap:6px;align-items:stretch;margin:10px 0 9px}
.prof .addr .url{flex:1;min-width:0;margin:0;padding:7px 10px;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:text;user-select:all}
.prof .addr button{flex-shrink:0}
.prof .sum{color:var(--tx3);font-size:12px;line-height:1.7}
.prof .sum b{color:var(--acc);font-weight:550}
.prof .seen{display:flex;align-items:center;gap:6px;color:var(--tx3);font-size:12px;margin-top:6px;flex-wrap:wrap}
.prof .seen .ic{color:var(--tx4)}
.prof .seen button{margin-left:-2px}
.prof .seen.warn{color:var(--warn);align-items:flex-start}
.prof .seen.warn .ic{color:var(--warn);margin-top:2px}
.prof .seen.warn > span{flex:1;min-width:0}
.clientbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:-2px 0 14px}
.clientbar .hint{margin:0}

/* 二维码必须深色码点压浅色底才好扫，暗色主题下也保持白底 */
.qr{background:#fff;border-radius:12px;padding:10px;width:min(260px,100%);margin:4px auto 0;box-shadow:0 0 0 1px var(--bd2)}
.qr svg{display:block;width:100%;height:auto}

/* 配置预览 */
.code{font:11.5px/1.65 var(--mono);background:var(--bg);border:1px solid var(--bd2);border-radius:10px;padding:12px 14px;white-space:pre;overflow:auto;max-height:52vh;color:var(--tx2);tab-size:2}
.code .cm{color:var(--tx4)}
.code .k{color:var(--acc)}
.stats{display:flex;flex-wrap:wrap;gap:6px}
.stats span{font-size:12px;color:var(--tx2);background:var(--bg);border:1px solid var(--bd2);border-radius:7px;padding:2px 8px;white-space:nowrap}
/* 预览：代码区与统计行都是固定尺寸，切格式时弹窗大小一丝不变（见 previewSub 的说明）。
   统计只占一行、放不下就横向滑，不折行 —— 折行与否会随内容变，高度就跟着变 */
.stats.pv{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;min-height:26px;align-items:center}
.stats.pv::-webkit-scrollbar{display:none}
.pvw{position:relative}
.code.pv{height:min(56vh,620px);max-height:none;transition:opacity .12s}
/* 等新内容时旧内容留着；只有等过 0.18 秒才变淡，快的切换一点痕迹都没有 */
.pvw.busy .code.pv{opacity:.45;transition:opacity .2s .18s}
.pvw .pvl{position:absolute;top:10px;right:14px;font-size:12px;color:var(--tx2);background:var(--card);border:1px solid var(--bd2);border-radius:7px;padding:2px 8px;opacity:0;pointer-events:none;transition:opacity .1s}
.pvw.busy .pvl{opacity:1;transition:opacity .2s .18s}

/* 规则测试 */
.probe{display:flex;gap:8px}
.probe input{flex:1}
.mres{margin-top:13px;border:1px solid var(--bd2);border-radius:11px;padding:13px 15px;font-size:13px}
.mres .path{display:flex;align-items:center;flex-wrap:wrap;gap:7px}
.mres .path .ic{color:var(--tx4)}
.mres .rule{font:12px var(--mono);color:var(--tx2);background:var(--bg);border:1px solid var(--bd2);border-radius:6px;padding:2px 7px;word-break:break-all}
.mres .mem{margin-top:10px;display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.mres .mem .first{background:var(--okBg);border-color:var(--okBd);color:var(--ok)}
.mres .note{color:var(--tx3);font-size:12px;margin-top:9px;line-height:1.65}
.mres .note b{color:var(--tx2);font-weight:550}
.samples{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px;align-items:center}
.samples .hint{margin:0 3px 0 0}

/* 上手引导 */
.steps{display:grid;gap:8px;counter-reset:st}
.step{display:flex;gap:11px;align-items:center;padding:10px 12px;border:1px solid var(--bd2);border-radius:10px;font-size:13px}
.step::before{counter-increment:st;content:counter(st);width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:600;background:var(--bg);border:1px solid var(--bd);color:var(--tx2);flex-shrink:0}
.step.done::before{content:'✓';background:var(--okBg);border-color:var(--okBd);color:var(--ok)}
.step.done .t{color:var(--tx3);text-decoration:line-through;text-decoration-color:var(--tx4)}
.step .t{flex:1;min-width:0}
.step .t small{display:block;color:var(--tx3);font-size:12px}

/* 访问记录 */
.hits{display:grid;gap:6px}
.hit{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 11px;align-items:center;padding:9px 11px;border:1px solid var(--bd2);border-radius:10px;font-size:12.5px}
.hit .who{font-weight:550}
.hit .ua{grid-column:2/-1;color:var(--tx3);font:11px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hit .when{color:var(--tx3);font-size:12px;white-space:nowrap}
.hit .flag{font-size:16px;line-height:1;grid-row:1/3}

.foot{text-align:center;margin-top:26px;color:var(--tx4);font-size:12px}
.login{max-width:360px;margin:12vh auto 0}
.login .card{padding:26px 26px 24px}
.login .logo{width:42px;height:42px;border-radius:12px;margin-bottom:16px}
.login .logo .ic{width:23px;height:23px}
.login h2{font-size:18px;font-weight:650;letter-spacing:-.01em}
.login p{color:var(--tx2);font-size:13.5px;margin:6px 0 20px;line-height:1.6}
.login .fg{margin-bottom:12px}
.pw{position:relative}
.pw input{padding-right:40px}
.pw .ib{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:30px;height:30px}
.msg{font-size:12.5px;margin-top:11px;min-height:18px;color:var(--warn);line-height:1.5}
.gap{height:9px}

/* ---- 窄屏：多列网格退成换行布局，弹窗改为底部抽屉 ---- */
@media (max-width:640px){
  body{padding:20px max(14px,env(safe-area-inset-right)) 56px max(14px,env(safe-area-inset-left));font-size:14.5px}
  .card{padding:15px 14px;border-radius:13px;margin-top:12px}
  .ttl{margin-bottom:12px}
  .desc{margin:-6px 0 12px}
  h1{font-size:18px}
  .logo{width:30px;height:30px;border-radius:9px}
  .tabs{margin:16px -14px 0;padding:0 8px}
  .tab{padding:8px 11px 11px}
  /* 行内元素分三层：名称与操作 / 地址 / 用量等次要信息。::after 充当强制换行 */
  .up{display:flex;flex-wrap:wrap;gap:6px 9px;padding:10px 11px}
  .up::after{content:'';order:4;flex-basis:100%;height:0;margin-top:-6px}
  .up .nm{flex:1 1 auto;white-space:normal;word-break:break-all}
  .up .u{order:5;flex-basis:100%;white-space:normal;word-break:break-all}
  .up .acts,.up .sw,.up .ib{order:2}
  .up .bar,.up .tgt{order:6}
  .up.own .tgt{order:5}
  .up.own .u{flex:1 1 auto;flex-basis:auto;min-width:0}
  .up > span:empty:not(.dot){display:none}
  .uplist.kv .up::after{display:none}
  .up.src .snap,.up.src .err{margin-left:0;display:block}
  .up.chain .u{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
  .up.chain .arw{margin:0 2px}
  .uplist.kv .up{display:grid;grid-template-columns:minmax(0,1fr)}
  .uplist.kv .up .nm{font-size:12px;color:var(--tx3);font-weight:500}
  .uplist.lib .up .u{order:5}
  .pol{flex-wrap:wrap;gap:7px 10px;padding:10px 11px}
  .pol .nm{min-width:0;flex:1 1 auto}
  .pol .tgts{order:4;flex-basis:100%;padding-left:26px}
  .pol .arrow{display:none}
  .pol .meta{order:5;flex-basis:100%;padding-left:26px;white-space:normal}
  .pol .ord{display:none}
  .nd{flex-wrap:wrap;gap:2px 9px;padding:7px 10px}
  .nd .nm{flex:1 1 60%;min-width:0}
  .nd .raw{order:3;flex-basis:100%;padding-left:0}
  .rgh .src{display:none}
  .search{max-width:none}
  .nfilter .cnt{flex-basis:100%;margin-left:0}
  .bd{align-items:flex-end;padding:0}
  .md,.md.lg,.md.xl{max-width:none;border-radius:16px 16px 0 0;max-height:92vh}
  .md .hd{padding:18px 18px 12px}
  .md .ct{padding:0 18px}
  .md .ft{padding:12px 18px max(16px,env(safe-area-inset-bottom))}
  .md .ft button{flex:1;justify-content:center}
  .md .ft .left{flex-basis:100%;margin:0 0 4px}
  .md .row{flex-wrap:wrap}
  .prof{padding:12px}
  .prof .hdr{flex-wrap:wrap}
  .prof .hdr .note{flex-basis:100%;order:5}
  .prof .addr{flex-wrap:wrap}
  .prof .addr .url{flex-basis:100%}
  .login{margin-top:8vh}
  .probe{flex-wrap:wrap}
  .probe button{flex:1;justify-content:center}
  .hit{grid-template-columns:auto minmax(0,1fr)}
  .hit .when{grid-column:2}
  .code.pv{height:50vh}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
</style></head><body>

<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<g id="i-copy" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M4.5 15.5A2.5 2.5 0 0 1 3 13.2V5.5A2.5 2.5 0 0 1 5.5 3h7.7a2.5 2.5 0 0 1 2.3 1.5"/></g>
<g id="i-check" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></g>
<g id="i-warn" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5M12 16.5h.01"/></g>
<g id="i-info" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v5.5M12 7.5h.01"/></g>
<g id="i-trash" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6h17M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6M18.5 6v13a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6"/></g>
<g id="i-edit" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.6 2.6 0 0 1 3.7 3.7L7.5 19.9 2.5 21.5l1.6-5Z"/></g>
<g id="i-refresh" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.7 9.7 0 0 1 6.7 2.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.7 9.7 0 0 1-6.7-2.7L3 16"/><path d="M8 16H3v5"/></g>
<g id="i-plus" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></g>
<g id="i-out" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 21H5.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 16.5 4.5-4.5L16 7.5"/><path d="M20.5 12H9.5"/></g>
<g id="i-down" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></g>
<g id="i-lock" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></g>
<g id="i-grip" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="15" cy="18" r="1.3"/></g>
<g id="i-undo" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.1-9.4L3 7"/></g>
<g id="i-fold" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m4 8 8 8 8-8"/></g>
<g id="i-x" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></g>
<g id="i-sun" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></g>
<g id="i-moon" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z"/></g>
<g id="i-auto" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/></g>
<g id="i-qr" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2"/><path d="M14 14h2.5v2.5M20.5 14v.01M14 20.5h.01M17.5 20.5h3v-3"/></g>
<g id="i-eye" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></g>
<g id="i-eyeoff" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.6A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-3 3.9M6.3 6.3A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></g>
<g id="i-dl" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v12M7 10.5l5 5 5-5M4 20.5h16"/></g>
<g id="i-ul" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5v-12M7 8.5l5-5 5 5M4 20.5h16"/></g>
<g id="i-search" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/></g>
<g id="i-open" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3.5h6.5V10M20.5 3.5 11 13M18 14v4.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10"/></g>
<g id="i-clock" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></g>
<g id="i-shield" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7.5-3.2 7.5-9.5V5.8L12 3 4.5 5.8v5.7C4.5 17.8 12 21 12 21Z"/></g>
<g id="i-route" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="5.5" r="2.5"/><path d="M8.5 18.5H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.5"/></g>
<g id="i-merge" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v4.5a5 5 0 0 0 5 5h3M6 20v-4.5a5 5 0 0 1 5-5"/><path d="m15.5 10 3.5 3.5-3.5 3.5"/></g>
<g id="i-link" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></g>
<g id="i-play" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m8 5 11 7-11 7Z"/></g>
<g id="i-arrow" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></g>
<g id="i-server" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/></g>
</defs></svg>

<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<div class="wrap" id="app"></div>

<script>
const authed = ${authed}, inited = ${inited}, needToken = ${needToken !== false}
const app = document.getElementById('app')
const tsBox = document.getElementById('toasts')
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
// 值要放进内联事件（onclick="f(...)"）的 JS 字符串里时用它：先 JSON 化成合法的
// JS 字符串字面量，再做 HTML 转义。只做 HTML 转义不够 —— 属性值被解析时 &#39;
// 会还原成单引号，正好把 JS 字符串闭合掉。机场节点名就是从这条路进来的：
// 一个叫 x');fetch(...);(' 的节点，足够在管理员的浏览器里读走全部配置。
const jsq = s => esc(JSON.stringify(String(s)))
// 服务端并不总是回 JSON：CPU 超限时 Cloudflare 直接塞一张 1102 错误页，
// 网关问题也是 HTML。裸 .json() 在这种时候抛 SyntaxError，把调用方的 await 链
// 整条掐断 —— 界面上什么都不发生，用户只知道「点了没反应」。
// 这里一律折成 {ok:false, msg}，保证任何失败都能弹出提示。
const api = async (p, b) => {
  let r
  try {
    r = await fetch(p, b ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)} : {})
  } catch (e) {
    return { ok:false, msg:'网络请求失败：' + (e && e.message || e) }
  }
  const raw = await r.text().catch(() => '')
  let d = null
  try { d = JSON.parse(raw) } catch (e) {}
  // 会话过期（7 天到了，或者别处改了密码）：别让每个操作都各报一句「未登录」
  if (r.status === 401 && d && d.msg === '未登录') { expired(); return { ok:false, msg:'登录已过期' } }
  if (d) return d
  if (r.status === 401 || r.status === 403) return { ok:false, msg:'登录已失效，请刷新页面重新登录' }
  const hint = r.status === 500 && /exceeded|limit|1102/i.test(raw) ? '服务端超出资源限制' : '服务端返回了非 JSON 响应'
  return { ok:false, msg:\`\${hint}（HTTP \${r.status}）\` }
}
const icon = (n, cls = '') => \`<svg class="ic \${cls}" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><use href="#i-\${n}"/></svg>\`
let TAB = 'node', ST = null, POL = null, OWN = null, PRF = null, PF = '', SET = null, CH = null
const TABS = [['node','节点'],['sub','订阅'],['pol','分流策略'],['lib','域名库'],['set','设置']]
// 当前 tab 记在地址栏的 # 上：刷新不跳回首页，也能直接把某一页的地址发给自己
const hashTab = () => { const h = location.hash.slice(1); return TABS.some(t => t[0] === h) ? h : '' }
TAB = hashTab() || 'node'
const store = {
  get(k, d){ try { const v = localStorage.getItem(k); return v === null ? d : v } catch (e) { return d } },
  set(k, v){ try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch (e) {} }
}

function toast(msg, err){
  const dup = [...tsBox.children].find(e => e.dataset.msg === msg && !e.dataset.x)
  if (dup) { clearTimeout(+dup.dataset.t); dup.dataset.t = setTimeout(() => dup.kill(), 2600); return }
  const el = document.createElement('div')
  el.className = 'toast' + (err ? ' err' : ''); el.dataset.msg = msg
  el.setAttribute('role', err ? 'alert' : 'status')
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
  // 出错的多停一会儿：错误信息往往要读完才知道下一步怎么办
  el.dataset.t = setTimeout(el.kill, err ? 4200 : 2600)
}

function modal({title, desc, html = '', fields = [], ok = '确定', danger = false, wide = false, xl = false, noCancel = false, foot = '', onMount, onSubmit}){
  return new Promise(resolve => {
    const bd = document.createElement('div')
    const opener = document.activeElement
    bd.className = 'bd'
    bd.innerHTML = \`<div class="md \${xl?'xl':wide?'lg':''}" role="dialog" aria-modal="true" aria-labelledby="mdt">
      <div class="hd"><h3 id="mdt">\${esc(title)}</h3>\${desc ? \`<p>\${esc(desc)}</p>\` : ''}
        <button type="button" class="ib x" data-close aria-label="关闭">\${icon('x')}</button></div>
      <div class="ct">
        \${html ? \`<div class="bdy">\${html}</div>\` : ''}
        \${fields.length ? \`<div class="bdy">\${fields.map((f,i)=>\`<input data-i="\${i}" placeholder="\${esc(f.ph||'')}" value="\${esc(f.val||'')}">\`).join('')}</div>\` : ''}
      </div>
      <div class="ft">\${foot ? \`<span class="left">\${foot}</span>\` : ''}\${noCancel?'':'<button class="g" data-x>取消</button>'}
        <button data-ok class="\${danger?'dg':''}">\${esc(ok)}</button></div>
    </div>\`
    document.body.appendChild(bd)
    const box = bd.querySelector('.md')
    const inputs = [...bd.querySelectorAll('.bdy input[data-i]')]
    setTimeout(() => (inputs[0] || bd.querySelector('.ct input:not([disabled]),.ct textarea') || bd.querySelector('[data-ok]')).focus(), 60)
    if (inputs[0]) inputs[0].select()
    if (onMount) onMount(box)
    // 名单类输入框按内容撑开（封顶约 12 行）：长名单不必在三行高的小框里上下翻，
    // 也就用不着去拖右下角的缩放手柄。只增不减，手动拖大的尺寸不会被打字打回去。
    const fit = ta => {
      if (!ta.offsetParent) return
      const need = Math.min(ta.scrollHeight + 2, 280)
      if (need > ta.offsetHeight) ta.style.height = need + 'px'
    }
    box.querySelectorAll('.ct textarea').forEach(ta => { fit(ta); ta.addEventListener('input', () => fit(ta)) })
    // 打开时给表单拍张快照，Esc 时比对：动过的表单不许一键关掉
    const state = () => JSON.stringify([
      [...box.querySelectorAll('.ct input, .ct textarea')].map(e => e.type === 'checkbox' ? e.checked : e.value),
      [...box.querySelectorAll('.ct .sel')].map(e => e.dataset.v),
      [...box.querySelectorAll('.ct .chip, .ct .sw')].map(e => e.classList.contains('on') || e.dataset.on === '1')
    ])
    const pristine = state()
    const dirty = () => state() !== pristine
    // 想关却没关成时的反馈：面板弹一下，右上角 × 亮一下，告诉用户出口在哪
    const xBtn = bd.querySelector('[data-close]')
    const hint = () => {
      if (box.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches)
        box.animate([{ transform:'none' }, { transform:'scale(1.012)' }, { transform:'none' }], { duration:280, easing:'cubic-bezier(.16,1,.3,1)' })
      xBtn.classList.add('hint')
      clearTimeout(xBtn._t)
      xBtn._t = setTimeout(() => xBtn.classList.remove('hint'), 900)
    }
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
      // 展开中的下拉面板此刻挂在 body 上，bd.remove() 带不走它，会留在页面上
      closeAllSel()
      const done = () => { bd.remove(); document.removeEventListener('keydown', onKey) }
      bd.classList.add('out')
      bd.addEventListener('animationend', done, { once: true })
      setTimeout(done, 400)
      // 焦点还给打开弹窗的那个按钮，键盘用户不至于被甩回页面顶端
      if (opener && opener.focus && document.body.contains(opener)) try { opener.focus({ preventScroll: true }) } catch (_) {}
      resolve(v)
    }
    // onSubmit 返回错误就把弹窗留住并把话说在出错的字段旁边。
    // 关掉弹窗再弹个 toast 让人重填，是这个表单以前最招人烦的地方 ——
    // 十几个字段填完，因为一处格式不对全部清空重来。
    const okBtn = bd.querySelector('[data-ok]')
    const submit = async () => {
      if (!onSubmit) return close(html ? box : (fields.length ? inputs.map(i => i.value.trim()) : true))
      if (okBtn.disabled) return
      box.querySelectorAll('.ferr').forEach(e => e.remove())
      box.querySelectorAll('.bad').forEach(e => e.classList.remove('bad'))
      okBtn.disabled = true
      const old = okBtn.textContent
      okBtn.textContent = '保存中…'
      let err = null
      try { err = await onSubmit(box) } catch (e) { err = String(e && e.message || e) }
      okBtn.disabled = false
      okBtn.textContent = old
      if (!err) return close(box)
      const msg = typeof err === 'string' ? err : err.msg
      const fid = typeof err === 'string' ? null : err.field
      const target = fid && box.querySelector('#' + fid)
      const holder = (target && target.closest('.fg')) || box.querySelector('.ct')
      if (target) {
        target.classList.add('bad')
        target.focus()
        if (target.select) try { target.select() } catch (_) {}
      }
      const tip = document.createElement('div')
      tip.className = 'ferr'
      tip.setAttribute('role', 'alert')
      tip.textContent = msg
      holder.appendChild(tip)
      tip.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    // 输入法组字时，Esc 是「撤掉候选词」、Enter 是「上屏」，都不是冲着弹窗来的。
    // Chrome 此时给 isComposing / keyCode 229；Safari 先发 compositionend 再发 keydown，
    // 两个标志都已复位，只能自己记着「刚组完字」，同一轮事件里的按键一律放过。
    let composing = false
    bd.addEventListener('compositionstart', () => { composing = true })
    bd.addEventListener('compositionend', () => setTimeout(() => { composing = false }))
    const onKey = e => {
      if (bd.classList.contains('out') || composing || e.isComposing || e.keyCode === 229) return
      // 叠了两层时（Tab 能把焦点挪到遮罩后面的按钮上再回车）只有最上面那层响应
      if ([...document.querySelectorAll('.bd:not(.out)')].pop() !== bd) return
      if (e.key === 'Escape') {
        if (bd.querySelector('.sel.open')) return closeAllSel()   // 先收起展开的下拉
        if (dirty()) { hint(); return toast('改动还没保存。确定不要了，请点右上角 × 或「取消」', true) }
        return close(null)
      }
      // 焦点关在弹窗里：Tab 不该跑到遮罩后面的页面上去
      if (e.key === 'Tab') {
        const f = [...box.querySelectorAll('button,input,textarea,[tabindex="0"]')].filter(x => !x.disabled && x.offsetParent)
        if (!f.length) return
        const a = document.activeElement
        if (!box.contains(a)) { e.preventDefault(); return f[0].focus() }
        if (e.shiftKey && a === f[0]) { e.preventDefault(); f[f.length - 1].focus() }
        else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0].focus() }
        return
      }
      if (e.key === 'Enter' && !html && document.body.contains(bd)) submit()
    }
    document.addEventListener('keydown', onKey)
    xBtn.onclick = () => close(null)
    // noCancel 的弹窗（如抓取诊断）没有取消按钮，不判空的话这里一抛异常，
    // 后面「知道了」的绑定就走不到了 —— 按钮点了没反应，弹窗只能按 Esc 关。
    const cancelBtn = bd.querySelector('[data-x]')
    if (cancelBtn) cancelBtn.onclick = () => close(null)
    okBtn.onclick = submit
    // 点遮罩不关窗。以前是关的，而在输入框里拖选文字、拖 textarea 的缩放手柄时
    // 只要在弹窗外松手，浏览器就把 click 派给按下点与松开点的公共祖先 —— 正是遮罩，
    // 一松手弹窗就没了、填的全丢。现在按下和松开都在遮罩上，也只是提示出口在哪。
    let downOnBd = false
    bd.addEventListener('pointerdown', e => { downOnBd = e.target === bd })
    bd.addEventListener('click', e => { if (e.target === bd && downOnBd) hint(); downOnBd = false })
  })
}

/* 表单里的开关（带 id 的 .sw）：点一下翻转 data-on，保存时再读。
   列表行上的开关各自 onclick 直接存盘，不归这里管。
   DNS 设置那三个开关以前谁都没绑，点了纹丝不动。 */
function bindSwitch(root){
  root.querySelectorAll('.sw[id]').forEach(s => {
    s.type = 'button'
    s.setAttribute('role', 'switch')
    s.setAttribute('aria-checked', s.dataset.on === '1')
    s.onclick = () => { s.dataset.on = s.dataset.on === '1' ? '0' : '1'; s.setAttribute('aria-checked', s.dataset.on === '1') }
  })
}
// 列表行上的开关：就地翻转外观，与 aria 状态保持一致
function setSw(el, on){
  if (!el) return
  el.dataset.on = on ? 1 : 0
  el.dataset.tip = on ? '停用' : '启用'
  el.setAttribute('aria-checked', on)
}

/* 自定义下拉，替代原生 select。multi=true 时可多选，面板不自动收起。 */
function selectHTML(id, opts, val, multi){
  const picked = multi ? (Array.isArray(val) ? val : [val]).filter(Boolean) : [val]
  const has = v => picked.includes(v)
  const first = opts.find(o => has(o.v)) || opts[0]
  return \`<div class="sel \${multi?'multi':''}" id="\${id}" data-v="\${esc(multi ? picked.join('|') : (first||{}).v || '')}">
    <button type="button" class="g selb" aria-haspopup="listbox"><span>\${esc(selLabel(opts, picked, multi))}</span>\${icon('down','s')}</button>
    <div class="selp" role="listbox" \${multi?'aria-multiselectable="true"':''} hidden>\${opts.map(o =>
      \`<div class="selo \${has(o.v)?'on':''}" role="option" aria-selected="\${has(o.v)}" data-v="\${esc(o.v)}">\${icon('check','s')}<span>\${esc(o.label)}</span></div>\`).join('')}</div>
  </div>\`
}
function selLabel(opts, picked, multi){
  const names = picked.map(v => (opts.find(o => o.v === v) || {}).label).filter(Boolean)
  if (!names.length) return multi ? '未选择' : (opts[0] || {}).label || ''
  if (!multi) return names[0]
  if (names.length === 1) return names[0] + '（已选 1 项）'
  return names.length === 2 ? names.join('、') : \`\${names[0]} 等 \${names.length} 项\`
}
// 读取当前值：单选得字符串，多选得数组。
// 多选勾完不收起，面板此时被 openSel 挪到了 body 上；只在 sel 里找会漏掉勾选项，
// 没收起就点保存会把目标存成空数组。所以从面板本身找，展开、收起都一样
function selValue(sel){
  if (!sel.classList.contains('multi')) return sel.dataset.v
  return [...(sel._pop || sel).querySelectorAll('.selo.on')].map(o => o.dataset.v)
}
function bindSelect(root){
  root.querySelectorAll('.sel').forEach(sel => {
    const btn = sel.querySelector('.selb'), pop = sel.querySelector('.selp')
    if (!btn || !pop || sel._bound) return
    sel._bound = 1
    const multi = sel.classList.contains('multi')
    const opts = [...pop.querySelectorAll('.selo')].map(o => ({ v: o.dataset.v, label: o.querySelector('span').textContent }))
    const repaint = () => {
      const picked = [...pop.querySelectorAll('.selo.on')].map(o => o.dataset.v)
      pop.querySelectorAll('.selo').forEach(o => o.setAttribute('aria-selected', o.classList.contains('on')))
      sel.dataset.v = multi ? picked.join('|') : (picked[0] || '')
      btn.innerHTML = '<span>' + esc(selLabel(opts, picked, multi)) + '</span>' + icon('down','s')
    }
    sel._pop = pop
    btn.onclick = e => {
      e.stopPropagation()
      const open = sel.classList.contains('open')
      closeAllSel()
      if (!open) openSel(sel, btn, pop)
    }
    // 键盘：上下键挑选、回车确认。以前只能用鼠标点
    btn.addEventListener('keydown', e => {
      const items = [...pop.querySelectorAll('.selo')]
      if (!items.length) return
      const open = sel.classList.contains('open')
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); closeAllSel(); openSel(sel, btn, pop) }
      if (!sel.classList.contains('open')) return
      let k = items.findIndex(o => o.classList.contains('kb'))
      if (k < 0) k = Math.max(0, items.findIndex(o => o.classList.contains('on')))
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (open) k = (k + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
        items.forEach((o, j) => o.classList.toggle('kb', j === k))
        items[k].scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' || e.key === ' ') {
        const cur = items.find(o => o.classList.contains('kb'))
        if (cur) { e.preventDefault(); e.stopPropagation(); cur.click() }
      }
    })
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
        btn.focus({ preventScroll: true })
      }
    })
  })
}
// 下拉面板打开时挪到 body 上、改用 fixed 定位。
// 弹窗内容区是 overflow:auto 的滚动容器，absolute 面板一旦超出边界就被裁掉，
// 底部按钮区还会盖在它上面 —— 光调 z-index 救不回被裁的那半，必须脱离容器。
function openSel(sel, btn, pop){
  if (!pop._home) pop._home = { p: pop.parentNode, n: pop.nextSibling }
  document.body.appendChild(pop)
  pop.classList.add('portal')
  pop.hidden = false
  sel.classList.add('open')
  btn.setAttribute('aria-expanded', 'true')
  placeSel(btn, pop)
  const on = pop.querySelector('.selo.on')
  if (on) on.scrollIntoView({ block: 'nearest' })
}
function placeSel(btn, pop){
  const r = btn.getBoundingClientRect(), gap = 5, pad = 10
  pop.style.width = r.width + 'px'
  pop.style.left = Math.max(pad, Math.min(r.left, innerWidth - r.width - pad)) + 'px'
  pop.style.maxHeight = ''
  const below = innerHeight - r.bottom - gap - pad
  const above = r.top - gap - pad
  const need = pop.scrollHeight
  // 下方放不下、且上方更宽敞时朝上展开
  if (need > below && above > below) {
    pop.style.maxHeight = Math.min(250, above) + 'px'
    pop.style.top = Math.max(pad, r.top - gap - Math.min(need, above, 250)) + 'px'
  } else {
    pop.style.maxHeight = Math.min(250, below) + 'px'
    pop.style.top = (r.bottom + gap) + 'px'
  }
}
function closeAllSel(){
  document.querySelectorAll('.sel.open').forEach(s => {
    s.classList.remove('open')
    const b = s.querySelector('.selb'); if (b) b.setAttribute('aria-expanded', 'false')
    const pop = s._pop
    if (!pop) return
    pop.hidden = true
    pop.classList.remove('portal')
    pop.style.cssText = ''
    pop.querySelectorAll('.kb').forEach(o => o.classList.remove('kb'))
    // 放回原位，否则下次重绘这块 DOM 时面板会被落在 body 上
    if (pop._home) pop._home.p.insertBefore(pop, pop._home.n)
  })
}
document.addEventListener('click', closeAllSel)
// 页面或弹窗滚动后按钮就挪位了，面板得跟上；跟不上就收起，别浮在半空
addEventListener('scroll', e => {
  if (e.target && e.target.classList && e.target.classList.contains('selp')) return   // 面板自己在滚
  document.querySelectorAll('.sel.open').forEach(s => {
    const btn = s.querySelector('.selb'), pop = s._pop
    if (!btn || !pop) return
    const r = btn.getBoundingClientRect()
    if (r.bottom < 0 || r.top > innerHeight) return closeAllSel()
    placeSel(btn, pop)
  })
}, true)
addEventListener('resize', closeAllSel)
// 用 span 做的可点元素（role=button），回车、空格也要能触发
document.addEventListener('keydown', e => {
  const t = e.target
  if ((e.key === 'Enter' || e.key === ' ') && t && t.matches && t.matches('[role="button"]:not(button)')) { e.preventDefault(); t.click() }
})

// 手柄上按下才允许拖，松开就复位。全局只挂这一个：以前每画一次列表就给 document
// 多挂一批监听，来回切几次页面能攒到上百个
document.addEventListener('mouseup', () => document.querySelectorAll('[draggable="true"]').forEach(r => { if (!r.classList.contains('drag')) r.draggable = false }))

/* 拖拽排序。策略列表与订阅源列表共用，两边行为必须一致 ——
   各写一套的话，一边修了抖动另一边照旧。 */
function bindDrag(listSel, itemSel, persist){
  const list = document.querySelector(listSel)
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
  // 把 src 挪到 row 的前面或后面；已经在那儿就什么都不做，避免来回抖
  const moveTo = (row, clientY) => {
    if (!src || src === row) return
    const r = row.getBoundingClientRect()
    const after = clientY > r.top + r.height / 2
    const ref = after ? row.nextSibling : row
    if (ref === src) return                       // 已经在目标位置
    if (after && row.nextSibling === src) return  // 同上，避免抖动
    flip(() => list.insertBefore(src, ref))
  }

  list.querySelectorAll(itemSel).forEach(row => {
    const grip = row.querySelector('.grip')
    // 默认不可拖，只有在手柄上按下才开启，避免拖到按钮或文字时误触发
    row.draggable = false
    if (grip) {
      grip.addEventListener('mousedown', () => { row.draggable = true })
      grip.addEventListener('touchstart', () => { row.draggable = true }, { passive: true })
      // 手机浏览器基本不支持 HTML5 拖放，触屏改用 pointer 事件自己跟手
      grip.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'touch') return
        e.preventDefault()
        src = row
        row.classList.add('tdrag')
        try { grip.setPointerCapture(e.pointerId) } catch (_) {}
        const move = ev => {
          const el = document.elementFromPoint(ev.clientX, ev.clientY)
          const over = el && el.closest(itemSel)
          if (over && over.parentNode === list) moveTo(over, ev.clientY)
        }
        const end = () => {
          grip.removeEventListener('pointermove', move)
          grip.removeEventListener('pointerup', end)
          grip.removeEventListener('pointercancel', end)
          row.classList.remove('tdrag')
          src = null
          persist()
        }
        grip.addEventListener('pointermove', move)
        grip.addEventListener('pointerup', end)
        grip.addEventListener('pointercancel', end)
      })
    }
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
      list.querySelectorAll(itemSel).forEach(r => { r.style.transition = ''; r.style.transform = '' })
      persist()
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

/* 带「全部」语义的多选：'all' 与具体白名单二选一 */
function chipsHTML(id, opts, val, word){
  const all = val === 'all'
  return \`<div class="chips" id="\${id}" data-word="\${esc(word||'项')}">
    <button type="button" class="chip \${all?'on':''}" data-v="__all">全部</button>
    \${opts.map(o => \`<button type="button" class="chip \${!all && Array.isArray(val) && val.includes(o.v) ? 'on':''}" data-v="\${esc(o.v)}">\${esc(o.label)}</button>\`).join('')
      || '<span class="hint" style="margin:0;align-self:center">（暂无可选项）</span>'}
  </div>
  <div class="hint chipst" data-for="\${id}" style="margin-top:6px"></div>\`
}
// 三态：全部 / 指定几个 / 一个都不选。
// 「都不选」是合法状态——比如给别人的订阅就不该包含自建节点，
// 所以不能像早先那样在清空时自动跳回「全部」。
function paintChips(box){
  box.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', c.classList.contains('on')))
  const t = box.parentNode.querySelector('.chipst[data-for="' + box.id + '"]')
  if (!t) return
  const word = box.dataset.word || '项'
  const allc = box.querySelector('.chip[data-v="__all"]')
  const picked = [...box.querySelectorAll('.chip.on')].filter(c => c !== allc)
  if (allc && allc.classList.contains('on')) t.innerHTML = '包含全部' + esc(word)
  else if (picked.length) t.innerHTML = '仅包含选中的 <b>' + picked.length + '</b> 个' + esc(word)
  else t.innerHTML = '<b style="color:var(--warn)">不包含任何' + esc(word) + '</b>'
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
  const names = v.map(x => esc((opts.find(o => o.v === x) || {}).label || x))
  return names.length <= 2 ? names.join(' · ') : names.slice(0,2).join(' · ') + \` 等 \${names.length} 项\`
}

function ago(ts){
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  const d = Math.floor(h / 24)
  return d < 60 ? d + ' 天前' : new Date(ts).toLocaleDateString('zh-CN')
}
const GB = 1073741824
function fmtSize(b){
  if (!b) return '0'
  if (b >= 1099511627776) return (b / 1099511627776).toFixed(2) + ' TB'
  if (b < GB) return (b / 1048576).toFixed(0) + ' MB'
  return (b / GB).toFixed(b >= 100 * GB ? 0 : 1) + ' GB'
}
function fmtBytes(n){ return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB' }
// 国家码 → 国旗 emoji（两个 Regional Indicator 字符）
function flagOf(cc){
  cc = String(cc || '').toUpperCase()
  return /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map(c => 0x1F1A5 + c.charCodeAt(0))) : ''
}
// 机场订阅地址里的 token 就是机场账号本身，截图、录屏时别整串露出来
function maskUrl(u){
  return String(u || '')
    .replace(/([?&][^=&#]+=)([^&#]{10,})/g, (_, k, v) => k + v.slice(0, 4) + '…' + v.slice(-3))
    .replace(/\\/([A-Za-z0-9_-]{20,})(?=[/?#]|$)/g, (_, v) => '/' + v.slice(0, 4) + '…' + v.slice(-3))
}
// 从 User-Agent 认出是哪个客户端
function clientName(ua){
  const u = String(ua || '')
  if (!u) return '未知客户端'
  const rules = [[/clash[- ]?verge/i,'Clash Verge'],[/mihomo[- ]?party/i,'Mihomo Party'],[/flclash/i,'FlClash'],[/stash/i,'Stash'],
    [/clash[ .-]?meta|clashmeta/i,'Clash Meta'],[/clashx/i,'ClashX'],[/clash/i,'Clash'],[/mihomo/i,'Mihomo'],[/shadowrocket/i,'Shadowrocket'],
    [/sing-?box|\\bSF[AIMT]\\//i,'sing-box'],[/v2rayng/i,'v2rayNG'],[/v2rayn/i,'v2rayN'],[/hiddify/i,'Hiddify'],[/neko(box|ray)/i,'NekoBox'],
    [/surge/i,'Surge'],[/quantumult/i,'Quantumult X'],[/loon/i,'Loon'],[/mozilla/i,'浏览器'],[/cfnetwork/i,'iOS / macOS 应用'],
    [/curl|wget|python|go-http|okhttp/i,'脚本']]
  for (const [re, n] of rules) {
    if (!re.test(u)) continue
    if (/浏览器|应用|脚本/.test(n)) return n
    const v = u.match(/\\/v?(\\d+(?:\\.\\d+){0,2})/)
    return n + (v ? ' ' + v[1] : '')
  }
  return u.split(/[\\/ ]/)[0].slice(0, 24) || '未知客户端'
}
// 空状态：一句话说清这里是干什么的，外加下一步该点哪
function blankHTML(ic, title, text, btn){
  return \`<div class="blank">\${icon(ic)}<b>\${title}</b><span>\${text}</span>\${btn || ''}</div>\`
}
function errHTML(r){
  return \`<div class="alert anim">\${icon('warn','s')}<span>\${esc((r && r.msg) || '加载失败，刷新页面重试')}</span></div>\`
}

// ---------------- 主题 ----------------
const THEMES = [['auto','跟随系统','auto'],['light','浅色','sun'],['dark','深色','moon']]
const themePref = () => { const t = store.get('theme', 'auto'); return THEMES.some(x => x[0] === t) ? t : 'auto' }
const darkMQ = matchMedia('(prefers-color-scheme: dark)')
function applyTheme(){
  const t = themePref()
  const dark = t === 'dark' || (t === 'auto' && darkMQ.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  const tc = document.getElementById('tc'); if (tc) tc.content = dark ? '#1b1a18' : '#faf9f7'
  const b = document.getElementById('thm')
  if (!b) return
  const x = THEMES.find(z => z[0] === t)
  b.innerHTML = icon(x[2])
  b.dataset.tip = '主题：' + x[1]
  b.setAttribute('aria-label', '切换主题（当前：' + x[1] + '）')
}
window.cycleTheme = () => {
  const i = THEMES.findIndex(z => z[0] === themePref())
  const next = THEMES[(i + 1) % THEMES.length]
  store.set('theme', next[0] === 'auto' ? null : next[0])
  applyTheme()
  toast('主题：' + next[1])
}
if (darkMQ.addEventListener) darkMQ.addEventListener('change', applyTheme)

// ---------------- 顶栏 ----------------
// 顶栏常驻。整页 innerHTML 重建会让它的入场动画每次重播，表现为切 tab 时上方闪一下。
// 这里首次渲染后只做增量更新：改统计文案、切 tab 高亮。
function ledeHTML(){
  const total = ST.regions.reduce((a, r) => a + r.nodes.length, 0)
  const when = ST.at ? new Date(ST.at).toLocaleString('zh-CN', {hour12:false, month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}) : ''
  const errs = (ST.errors || []).length
  const sep = '<span class="sep">·</span>'
  let h = \`<span><b>\${ST.upstreams.length}</b> 个订阅源</span>\${sep}<span><b>\${total}</b> 个机场节点</span>\`
  if (when) h += \`\${sep}<span>\${when} 更新</span>\`
  if (ST.stale) h += \`\${sep}<span class="bad" role="button" tabindex="0" onclick="showErrors()">\${icon('warn','s')}上游全部拉取失败，正在用缓存</span>\`
  else if (errs) h += \`\${sep}<span class="bad" role="button" tabindex="0" onclick="showErrors()">\${icon('warn','s')}\${errs} 个源拉取失败</span>\`
  return h
}
function paintHeader(){
  let hdr = document.getElementById('hdr')
  if (!hdr) {
    app.innerHTML = \`<div id="hdr" class="anim">
      <div class="top"><div class="brand"><div class="logo">\${icon('merge')}</div>
        <div><h1>订阅聚合</h1><div class="lede">\${ledeHTML()}</div></div></div>
        <span class="sp"><button class="ib tl" id="thm" onclick="cycleTheme()"></button>
          <button class="ib tl" data-tip="退出登录" aria-label="退出登录" onclick="logout()">\${icon('out')}</button></span></div>
      <nav class="tabs" role="tablist">\${TABS.map(([k,n]) =>
        \`<button class="tab \${TAB===k?'on':''}" role="tab" aria-selected="\${TAB===k}" data-t="\${k}" onclick="go('\${k}')">\${n}</button>\`).join('')}</nav>
    </div><div id="body"></div>\`
    applyTheme()
    return
  }
  hdr.querySelector('.lede').innerHTML = ledeHTML()
  hdr.querySelectorAll('.tab').forEach(b => { b.classList.toggle('on', b.dataset.t === TAB); b.setAttribute('aria-selected', b.dataset.t === TAB) })
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

// ---------------- 登录 ----------------
function login(){
  app.innerHTML = \`<div class="login anim"><div class="card" style="margin:0">
    <div class="logo">\${icon('merge')}</div>
    <h2>\${inited ? '订阅聚合' : '初始化管理端'}</h2>
    <p>\${inited ? '输入管理密码继续。' : needToken ? '首次使用：填入部署时 <code>deploy.sh</code> 打印的初始化令牌，再设一个管理密码。' : '首次使用：设一个管理密码。'}</p>
    \${inited || !needToken ? '' : \`<div class="fg"><label class="lb" for="tk">初始化令牌</label>
      <input id="tk" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="deploy.sh 输出的那一串"></div>\`}
    <div class="fg"><label class="lb" for="pw">\${inited ? '管理密码' : '设置管理密码'}</label>
      <div class="pw"><input id="pw" type="password" autocomplete="\${inited ? 'current-password' : 'new-password'}" placeholder="\${inited ? '' : '至少 8 位'}">
        <button type="button" class="ib" id="pwv" aria-label="显示密码" onclick="peek()">\${icon('eye')}</button></div></div>
    \${inited ? '' : \`<div class="fg"><label class="lb" for="pw2">再输一次</label>
      <input id="pw2" type="password" autocomplete="new-password" placeholder="确认密码"></div>\`}
    <button id="lgb" style="width:100%;justify-content:center;margin-top:6px" onclick="doLogin()">\${inited ? '登录' : '设置并登录'}</button>
    <div id="msg" class="msg" role="alert"></div></div>
    <div class="foot">运行在 Cloudflare Workers · 配置存于 Workers KV</div></div>\`
  ;(document.getElementById('tk') || document.getElementById('pw')).focus()
  app.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) doLogin() }))
}
window.peek = () => {
  const p = document.getElementById('pw'), b = document.getElementById('pwv')
  const show = p.type === 'password'
  p.type = show ? 'text' : 'password'
  b.innerHTML = icon(show ? 'eyeoff' : 'eye')
  b.setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
  p.focus()
}
window.doLogin = async () => {
  const tk = document.getElementById('tk'), btn = document.getElementById('lgb'), msg = document.getElementById('msg')
  const pw = document.getElementById('pw').value, pw2 = document.getElementById('pw2')
  msg.textContent = ''
  if (tk && !tk.value.trim()) { msg.textContent = '请填入初始化令牌'; return tk.focus() }
  if (!pw) { msg.textContent = '请输入密码'; return document.getElementById('pw').focus() }
  if (!inited && pw.length < 8) { msg.textContent = '密码至少 8 位'; return document.getElementById('pw').focus() }
  if (pw2 && pw2.value !== pw) { msg.textContent = '两次输入的密码不一致'; return pw2.focus() }
  btn.disabled = true; btn.textContent = '验证中…'
  const r = await api('/admin/login', { password: pw, initToken: tk ? tk.value.trim() : undefined })
  if (r.ok) return location.reload()
  btn.disabled = false; btn.textContent = inited ? '登录' : '设置并登录'
  msg.textContent = r.msg || '失败'
}
let EXPIRED = false
function expired(){
  if (EXPIRED) return
  EXPIRED = true
  modal({ title:'登录已过期', desc:'会话满 7 天，或者在别处改了密码、让其它设备下线了。重新登录后继续。', ok:'重新登录', noCancel:true })
    .then(() => location.reload())
}

// ---------------- 调度 ----------------
async function dash(skip){
  closeAllSel()      // 面板挂在 body 上，重建页面带不走它
  if (!skip) skeleton()
  // 每个 tab 只拉自己要的，且并行发出——串行等两个请求是之前切 tab 卡顿的主因之一
  const jobs = []
  if (!ST) jobs.push(api('/api/state').then(r => { ST = r }))
  if (TAB === 'node' && !OWN) jobs.push(api('/api/own').then(r => { OWN = r }))
  if ((TAB === 'node' || TAB === 'set') && !SET) jobs.push(api('/api/settings').then(r => { SET = r }))
  if (TAB === 'node' && !CH) jobs.push(api('/api/chains').then(r => { CH = r }))
  if (TAB === 'sub' && !PRF) jobs.push(api('/api/profiles').then(r => { PRF = r }))
  if ((TAB === 'pol' || TAB === 'lib') && !POL) jobs.push(api('/api/policies?pf=' + encodeURIComponent(PF)).then(r => { POL = r }))
  if (jobs.length) await Promise.all(jobs)
  if (!ST || !ST.ok) { app.innerHTML = errHTML(ST); return }
  // 正在编辑的那份订阅已经被删了（别的页面、别的标签页）：退回全局，不然之后每次保存都报「订阅不存在」
  if (PF && POL && POL.ok && !(POL.profiles || []).some(x => x.id === PF)) { PF = ''; POL = null; return dash(skip) }
  // 策略改过之后，域名库页的「被几条策略引用」要重新算
  if (TAB === 'lib' && POL && POL.dirtyRefs) { POL = null; return dash(skip) }

  paintHeader()
  document.getElementById('body').innerHTML =
    TAB === 'node' ? viewNode() : TAB === 'sub' ? viewSub() : TAB === 'pol' ? viewPol() : TAB === 'lib' ? viewLib() : viewSet()
  if (TAB === 'node') { bindDrag('.uplist.src', '.up', persistUpOrder); if (NQ || NF !== 'all') filterNodes(NQ) }
  if (TAB === 'pol') {
    bindDrag('#pollist', '.pol', persistOrder)
    const sel = document.getElementById('pfsel')
    if (sel) {
      bindSelect(document)
      sel.querySelectorAll('.selo').forEach(o => o.addEventListener('click', () => {
        if (o.dataset.v === PF) return
        PF = o.dataset.v; POL = null; dash(true)
      }))
    }
  }
  if (TAB === 'lib' && LQ) filterLib(LQ)
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
  if (location.hash.slice(1) !== t) history.replaceState(null, '', '#' + t)
  const need = (t === 'node' && (!OWN || !SET || !CH)) || (t === 'sub' && !PRF) || ((t === 'pol' || t === 'lib') && !POL) || (t === 'set' && !SET)
  // tab 高亮立即切过去，让点击有即时反馈
  document.querySelectorAll('.tab').forEach(b => { b.classList.toggle('on', b.dataset.t === t); b.setAttribute('aria-selected', b.dataset.t === t) })
  if (need) tabSkeleton()
  // 从长页面切到短页面时，不重置会停在一片空白上
  if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' })
  dash(true)
}
addEventListener('hashchange', () => { const t = hashTab(); if (t && t !== TAB && ST) go(t) })
// 「/」直接跳到当前页的搜索框
document.addEventListener('keydown', e => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
  const a = document.activeElement
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') || document.querySelector('.bd')) return
  const f = document.getElementById(TAB === 'node' ? 'nq' : TAB === 'lib' ? 'lq' : TAB === 'pol' ? 'mq' : '')
  if (f) { e.preventDefault(); f.focus(); f.select() }
})

// ---------------- 节点页 ----------------
// 新部署时的上手清单：三步都做完就不再出现
function onboarding(){
  const hasDomain = !!(SET && SET.settings && SET.settings.domain)
  const hasSrc = ST.upstreams.length > 0 || Object.keys((OWN && OWN.own) || {}).length > 0
  if (hasDomain && hasSrc) return ''
  const step = (done, t, sub, btn) => \`<div class="step \${done?'done':''}"><span class="t">\${t}<small>\${sub}</small></span>\${done ? '' : btn}</div>\`
  return \`<div class="card anim"><div class="ttl">开始使用<span class="sub">三步就能用上</span></div>
    <div class="steps">
      \${step(hasDomain, '填写本站域名', '用于 DNS 与「访问本站不走代理」的规则', \`<button class="sm g" onclick="go('set');setTimeout(editSettings,350)">去填写</button>\`)}
      \${step(hasSrc, '添加节点来源', '机场订阅链接，或者自建节点，至少一样', \`<button class="sm" onclick="addUp()">\${icon('plus','s')}订阅源</button><button class="sm g" onclick="editOwn(null)">自建节点</button>\`)}
      \${step(false, '把订阅地址导入客户端', '「订阅」页有复制、二维码与一键导入', \`<button class="sm g" onclick="go('sub')">去订阅页</button>\`)}
    </div></div>\`
}
function viewNode(){
  let h = onboarding()
  h += \`<div class="card anim" style="animation-delay:.02s"><div class="ttl">订阅源<span class="sub">机场</span><span class="sp">
    <button class="sm" onclick="addUp()">\${icon('plus','s')}添加</button></span></div>\`
  h += ST.upstreams.length > 1
    ? '<div class="desc">拖动左侧手柄调整顺序 —— 靠上的机场，节点排在订阅前面。</div>' : ''
  h += '<div class="uplist src">'
  h += ST.upstreams.map(upRow).join('') || blankHTML('link', '还没有订阅源', '添加机场的订阅链接，节点会按地区归类、统一命名。')
  h += '</div></div>'
  h += \`<div class="card anim" style="animation-delay:.05s" id="owncard">\${ownCardInner()}</div>\`
  h += \`<div class="card anim" style="animation-delay:.08s" id="chaincard">\${chainCardInner()}</div>\`
  h += \`<div class="card anim" style="animation-delay:.10s" id="nodecard">\${nodeCardInner()}</div>\`
  return h + '<div class="foot anim" style="animation-delay:.14s">节点每小时自动刷新，上游故障时沿用缓存</div>'
}

const protoName = n => n.type === 'vless' ? (n.net === 'ws' ? 'VLESS WS' : n.net === 'xhttp' ? 'VLESS XHTTP' : 'VLESS Reality') : 'Hysteria2'
function ownCardInner(){
  const ow = (OWN && OWN.own) || {}
  let h = \`<div class="ttl">自有节点<span class="sub">自建服务器</span><span class="sp">
      <button class="sm g" onclick="editOwn(null)">\${icon('plus','s')}添加</button></span></div>
    <div class="desc">与机场无关的自建节点，分流策略可以直接指向它们。</div>\`
  if (OWN && !OWN.ok) return h + errHTML(OWN)
  h += '<div class="uplist own">'
  h += Object.entries(ow).map(([k,n]) => \`<div class="up own">
      <span class="dot"></span>
      <span class="nm">\${esc(n.name)}</span>
      <span class="tgt">\${protoName(n)}</span>
      <span class="u">\${esc(n.s)}:\${esc(String(n.p))}\${n.ports ? ' · 跳跃 ' + esc(n.ports) : ''}</span>
      <button class="ib" data-tip="复制分享链接" aria-label="复制分享链接" onclick="copyOwnLink(\${jsq(k)},this)">\${icon('link')}</button>
      <button class="ib" data-tip="编辑" aria-label="编辑" onclick="editOwn(\${jsq(k)})">\${icon('edit')}</button>
      <button class="ib dl" data-tip="删除" aria-label="删除" onclick="delOwn(\${jsq(k)})">\${icon('trash')}</button>
    </div>\`).join('') || blankHTML('server', '还没有自有节点', '有自建的 VLESS Reality / Hysteria2 节点就加进来，没有可以跳过。')
  return h + '</div>'
}

// 链式代理：先连中转、再从中转连落地，出口 IP 是落地的。
// 单独一块，增删链后只重绘这里。
function chainCardInner(){
  const cs = (CH && CH.chains) || []
  let h = \`<div class="ttl">链式代理<span class="sp">
    <button class="sm g" onclick="editChain(null)">\${icon('plus','s')}新建</button></span></div>
    <div class="desc">先连中转、再从中转连落地，出口 IP 是<b>落地</b>的。典型用法：自建节点做中转（入口线路好），
      机场家宽节点做落地（住宅 IP，风控友好）。仅 Clash 与 sing-box 支持，base64 分享链接格式里没有对应写法。</div>\`
  if (!CH) return h + '<div class="empty">加载中…</div>'
  if (!CH.ok) return h + errHTML(CH)
  h += '<div class="uplist chain">'
  h += cs.map(c => \`<div class="up chain \${c.enabled===false?'off':''}" data-id="\${esc(c.id)}">
      <span class="dot \${c.landGone?'bad':''}"></span>
      <span class="nm">\${esc(c.name)}</span>
      <span class="u"><span class="hop">\${esc(c.viaName||'?')}</span><span class="arw">→</span><span class="hop \${c.landGone?'gone':''}">\${c.landGone?'落地节点已不存在':esc(c.landName)}</span></span>
      \${c.warn ? \`<span class="tgt hot" data-tip="\${esc(c.warn)}">协议存疑</span>\` : '<span></span>'}
      <button class="sw" data-on="\${c.enabled===false?0:1}" data-tip="\${c.enabled===false?'启用':'停用'}" role="switch" aria-checked="\${c.enabled!==false}" aria-label="启用这条链" onclick="chainAct('toggle',\${jsq(c.id)})"><i></i></button>
      <button class="ib" data-tip="编辑" aria-label="编辑" onclick="editChain(\${jsq(c.id)})">\${icon('edit')}</button>
      <button class="ib dl" data-tip="删除" aria-label="删除" onclick="delChain(\${jsq(c.id)})">\${icon('trash')}</button>
    </div>\`).join('') || '<div class="empty">还没有链式代理</div>'
  return h + '</div>'
}

/* 地区折叠状态存本地，刷新后保留；节点多时默认收起，避免一屏拉不到底 */
const COLL = new Set((() => { try { return JSON.parse(localStorage.getItem('rgcoll') || '[]') } catch { return [] } })())
function saveColl(){ try { localStorage.setItem('rgcoll', JSON.stringify([...COLL])) } catch {} }
window.toggleRg = (k, el) => {
  COLL.has(k) ? COLL.delete(k) : COLL.add(k)
  saveColl()
  el.closest('.rg').classList.toggle('coll', COLL.has(k))
  el.setAttribute('aria-expanded', !COLL.has(k))
}
window.foldAll = (open) => {
  const rgs = document.querySelectorAll('#body .rg')
  COLL.clear()
  if (!open) rgs.forEach(r => COLL.add(r.dataset.k))
  saveColl()
  rgs.forEach(r => { r.classList.toggle('coll', !open); const h = r.querySelector('.rgh'); if (h) h.setAttribute('aria-expanded', open) })
}

let NQ = '', NF = 'all'
// 单独一份，增删订阅源后只重绘这一块，不必整页重建
function nodeCardInner(){
  const all = ST.regions.reduce((a, r) => a + r.nodes.length, 0)
  const off = ST.regions.reduce((a, r) => a + r.nodes.filter(n => n.off).length, 0)
  const cus = ST.regions.reduce((a, r) => a + r.nodes.filter(n => n.custom).length, 0)
  // 筛选条件失效就复位：否则所有节点都被藏起来，而能取消筛选的按钮也跟着消失了
  if ((NF === 'off' && !off) || (NF === 'custom' && !cus)) NF = 'all'
  if (all <= 6) { NQ = ''; NF = 'all' }
  let h = \`<div class="ttl">节点<span class="sub">\${all} 个\${off ? \` · \${off} 个已停用\` : ''}</span><span class="sp">
    <button class="g sm" onclick="foldAll(true)">展开全部</button>
    <button class="g sm" onclick="foldAll(false)">收起全部</button>
    <button class="ib" data-tip="重新拉取全部订阅源" aria-label="重新拉取全部订阅源" onclick="refresh(this)">\${icon('refresh')}</button></span></div>\`
  if (all > 6) h += \`<div class="nfilter">
    <label class="search">\${icon('search','s')}<input id="nq" type="search" placeholder="搜索节点名、原名、机场或协议" value="\${esc(NQ)}" oninput="filterNodes(this.value)" aria-label="搜索节点" autocomplete="off">
      <button class="ib clr" type="button" aria-label="清空搜索" onclick="clearNodeQ()">\${icon('x','s')}</button></label>
    \${off || cus ? \`<div class="seg" role="group" aria-label="筛选">\${[['all','全部'],['off','已停用 ' + off],['custom','已改名 ' + cus]].filter(x => x[0] === 'all' || +x[1].split(' ')[1]).map(([k,n]) =>
      \`<button type="button" class="\${NF===k?'on':''}" data-f="\${k}" onclick="nodeFilter('\${k}')">\${n}</button>\`).join('')}</div>\` : ''}
    <span class="cnt" id="nqc" aria-live="polite"></span></div>\`
  for (const r of ST.regions) {
    const src = (ST.bySrc || {})[r.key] || {}
    const srcTxt = Object.entries(src).map(([n, c]) => esc(n) + ' ' + c).join(' · ')
    h += \`<div class="rg \${COLL.has(r.key)?'coll':''}" data-k="\${r.key}">
      <div class="rgh" role="button" tabindex="0" aria-expanded="\${!COLL.has(r.key)}" onclick="toggleRg('\${r.key}',this)">
        \${icon('fold','s chev')}
        <span class="n">\${r.flag} \${esc(r.cn)}</span><span class="c">\${r.nodes.length}</span>
        <span class="src">\${srcTxt}</span>
      </div>
      <div class="nds"><div class="inner">\`
    h += r.nodes.map(n => \`<div class="nd \${n.off?'off':''}" data-k="\${esc(n.key)}" data-c="\${n.custom?1:0}" data-s="\${esc([n.name, n.raw, n.upName, n.type || ''].join(' ').toLowerCase())}">
      <span class="nm"><span>\${esc(n.name)}</span>\${n.custom?'<span class="tag">自定义</span>':''}</span>
      \${n.type ? \`<span class="proto">\${esc(n.type)}</span>\` : ''}
      <span class="raw">\${n.custom ? esc(n.upName) + ' · ' : ''}\${esc(n.raw)}</span>
      <span class="act" onclick="event.stopPropagation()"><button class="ib" data-tip="重命名" aria-label="重命名" onclick="rename(this)">\${icon('edit')}</button>
      <button class="sw" data-on="\${n.off?0:1}" data-tip="\${n.off?'启用':'停用'}" role="switch" aria-checked="\${!n.off}" aria-label="下发这个节点" onclick="toggle(this)"><i></i></button></span>
    </div>\`).join('')
    h += '</div></div></div>'
  }
  if (!ST.regions.length) h += blankHTML('server', '暂无机场节点', ST.upstreams.length ? '订阅源都没拉到节点，点标题栏的刷新按钮重试，或者看看各源的「用量未知」诊断。' : '先在上面添加订阅源。')
  return h
}
window.filterNodes = q => {
  NQ = String(q || '').trim().toLowerCase()
  const card = document.getElementById('nodecard')
  if (!card) return
  const on = !!NQ || NF !== 'all'
  let shown = 0
  card.querySelectorAll('.rg').forEach(rg => {
    let n = 0
    rg.querySelectorAll('.nd').forEach(nd => {
      const hit = (!NQ || NQ.split(/\\s+/).every(w => nd.dataset.s.includes(w)))
        && (NF === 'all' || (NF === 'off' ? nd.classList.contains('off') : nd.dataset.c === '1'))
      nd.hidden = !hit
      if (hit) n++
    })
    rg.hidden = !n
    // 搜索时把命中的地区临时展开，不改动保存的折叠状态
    rg.classList.toggle('coll', on ? false : COLL.has(rg.dataset.k))
    shown += n
  })
  const c = document.getElementById('nqc')
  if (c) c.textContent = on ? (shown ? \`找到 \${shown} 个\` : '没有匹配的节点') : ''
}
window.nodeFilter = k => {
  NF = k
  document.querySelectorAll('.nfilter .seg button').forEach(b => b.classList.toggle('on', b.dataset.f === k))
  filterNodes(NQ)
}
window.clearNodeQ = () => { const i = document.getElementById('nq'); if (i) { i.value = ''; i.focus() } filterNodes('') }

function upRow(u, i){
  const snapAt = (ST.snaps || {})[u.id]
  const err = (ST.errors || []).find(e => e.id ? e.id === u.id : e.up === u.name)
  return \`<div class="up src \${u.enabled===false?'off':''}" data-id="\${esc(u.id)}" data-i="\${i||0}" draggable="false">
      <span class="grip" data-tip="拖动调整顺序">\${icon('grip','s')}</span>
      <span class="dot \${err && !snapAt ? 'bad' : ''}"></span>
      <span class="nm">\${esc(u.name)}\${u.auto===false?'<span class="tag manual" data-tip="不参与自动刷新，固定使用快照">手动</span>':''}</span>
      <span class="u">\${u.url ? esc(maskUrl(u.url)) : '<span class="mute">粘贴导入 · 无链接</span>'}\${snapAt?\`<span class="snap">快照 \${ago(snapAt)}</span>\`:''}\${err?\`<span class="err" role="button" tabindex="0" onclick="probeUp(\${jsq(u.id)})">\${err.msg.includes('沿用快照') ? '拉取失败，用快照' : '拉取失败'}</span>\`:''}</span>
      \${upMeta((ST.meta || {})[u.id], u.id)}
      <button class="sw" data-on="\${u.enabled===false?0:1}" data-tip="\${u.enabled===false?'启用':'停用'}" role="switch" aria-checked="\${u.enabled!==false}" aria-label="启用这个订阅源" onclick="upAct('toggle',\${jsq(u.id)},this)"><i></i></button>
      <button class="ib" data-tip="编辑" aria-label="编辑" onclick="editUp(\${jsq(u.id)})">\${icon('edit')}</button>
      <button class="ib dl" data-tip="删除" aria-label="删除" onclick="delUp(\${jsq(u.id)})">\${icon('trash')}</button>
    </div>\`
}
// 机场的流量与到期。返回三个平级元素（进度条 / 流量 / 到期），
// 缺项用空 span 占位——列数恒定，各行才能逐列对齐。
function upMeta(m, id){
  const blank = '<span></span>'
  // 拿不到就直说，并给一个查抓取详情的入口。
  // 以前这里是三个空 span，一片空白，分不清是机场没给还是我们没解析出来。
  if (!m) return blank + blank +
    \`<span class="tgt mute" role="button" tabindex="0" data-tip="点击查看抓取详情" onclick="probeUp(\${jsq(id||'')})">用量未知</span>\`
  let bar = blank, traffic = blank, exp = blank
  if (m.total > 0) {
    const left = Math.max(0, m.total - m.up - m.down)
    const pct = Math.round(left / m.total * 100)
    const hot = pct <= 15
    bar = \`<span class="bar \${hot?'hot':''}" title="剩余 \${pct}%"><i style="width:\${pct}%"></i></span>\`
    traffic = \`<span class="tgt lnk \${hot?'hot':''}" role="button" tabindex="0" data-tip="剩余 / 总量，点击查看抓取详情" onclick="probeUp(\${jsq(id||'')})">\${fmtSize(left)} / \${fmtSize(m.total)}</span>\`
  }
  if (m.expire > 0) {
    const days = Math.ceil((m.expire * 1000 - Date.now()) / 86400000)
    const d = new Date(m.expire * 1000)
    exp = \`<span class="tgt \${days <= 7 ? 'hot' : ''}" data-tip="\${d.toLocaleDateString('zh-CN')} 到期">\${days < 0 ? '已过期' : days === 0 ? '今天到期' : days + ' 天后到期'}</span>\`
  }
  return bar + traffic + exp
}

// ---------------- 订阅页 ----------------
// 每种客户端一个地址写法与一键导入链接
const CLIENTS = [
  { k:'clash', label:'Clash', hint:'Clash Verge Rev、Mihomo Party、FlClash、Stash、Clash Meta for Android 等 mihomo 内核客户端', q:'',
    imp: (u, n) => 'clash://install-config?url=' + encodeURIComponent(u) + '&name=' + encodeURIComponent(n) },
  { k:'shadowrocket', label:'Shadowrocket', hint:'小火箭。Shadowrocket 同一地址按 UA 下发原生 conf，这里显式带上参数更稳（Mac 版有时用浏览器的 UA 来拉）', q:'&fmt=shadowrocket',
    imp: (u, n) => 'shadowrocket://add/sub://' + btoa(u) + '?remark=' + encodeURIComponent(n) },
  { k:'singbox', label:'sing-box', hint:'sing-box 1.12 及以上的官方客户端（SFI / SFA / SFM），下发带 TUN 入站的完整配置', q:'&fmt=singbox',
    imp: (u, n) => 'sing-box://import-remote-profile?url=' + encodeURIComponent(u) + '#' + encodeURIComponent(n) },
  { k:'share', label:'通用', hint:'v2rayN、v2rayNG、Hiddify 等只认节点列表的客户端。这个格式不含分流规则，也不含链式代理', q:'&fmt=share', imp: null }
]
let CLI = store.get('client', 'clash')
const client = () => CLIENTS.find(c => c.k === CLI) || CLIENTS[0]
// 离线演示页没有真实域名（file:// 的 origin 是字符串 "null"），由它注入一个
const subUrl = (x, c) => (window.__origin || location.origin) + '/sub?token=' + encodeURIComponent(x.token) + (c || client()).q
function viewSub(){
  if (!PRF || !PRF.ok) return errHTML(PRF)
  const ps = PRF.profiles || [], o = PRF.opts || {own:[],ups:[],regions:[],pols:[]}
  const c = client()
  let h = \`<div class="card anim" style="animation-delay:.02s">
    <div class="ttl">订阅<span class="sub">\${ps.length} 份</span><span class="sp">
      <button class="sm" onclick="editProf(null)">\${icon('plus','s')}新建</button></span></div>
    <div class="desc">每份订阅一个独立地址，可以分别挑选包含哪些节点、机场、地区和策略 —— 给不同设备、不同的人用不同的订阅，互不影响。</div>
    <div class="clientbar"><div class="seg" role="radiogroup" aria-label="客户端">\${CLIENTS.map(z =>
      \`<button type="button" role="radio" aria-checked="\${z.k===c.k}" class="\${z.k===c.k?'on':''}" onclick="pickClient('\${z.k}')">\${z.label}</button>\`).join('')}</div>
      <span class="hint">\${esc(c.hint)}</span></div>
    <div id="proflist">\`
  h += ps.map((x, i) => profCard(x, i, o, c)).join('') || blankHTML('link', '还没有订阅', '新建一份订阅，就能拿到一个给客户端用的地址。')
  h += \`</div>
    <div class="tips" style="margin-top:14px"><span>地址后还可以加：</span>
      <span><code>&amp;mode=blacklist</code> 黑名单模式（没命中规则的直连）</span>
      <span><code>&amp;upstream=0</code> 应急：只下发自有节点</span></div>
  </div>\`
  return h
}
function profCard(x, i, o, c){
  const url = subUrl(x, c)
  const hits = (PRF.hits || {})[x.id] || []
  const last = hits[0]
  const lost = (PRF.lost || {})[x.id] || []
  return \`<div class="prof \${x.enabled===false?'off':''}" data-i="\${i}">
    <div class="hdr">
      <span class="nm">\${esc(x.name)}</span>
      <span class="tag mute">\${x.mode==='blacklist'?'黑名单':'白名单'}</span>
      \${Array.isArray(x.policies) ? '<span class="tag">专属策略</span>' : ''}
      \${x.note ? \`<span class="note">\${esc(x.note)}</span>\` : ''}
      <span class="acts">
        <button class="sw" data-on="\${x.enabled===false?0:1}" data-tip="\${x.enabled===false?'启用':'停用'}" role="switch" aria-checked="\${x.enabled!==false}" aria-label="启用这份订阅" onclick="toggleProf(\${i},this)"><i></i></button>
        <button class="ib" data-tip="编辑" aria-label="编辑" onclick="editProf(\${i})">\${icon('edit')}</button>
        <button class="ib dl tl" data-tip="删除" aria-label="删除" onclick="delProf(\${i})">\${icon('trash')}</button></span>
    </div>
    <div class="addr">
      <div class="url" id="su\${i}" title="\${esc(url)}">\${esc(url)}</div>
      <button class="g sm" onclick="copySub(\${i},this)">\${icon('copy','s')}复制</button>
      <button class="ib" data-tip="二维码" aria-label="显示二维码" onclick="qrSub(\${i})">\${icon('qr')}</button>
      \${c.imp ? \`<button class="ib" data-tip="一键导入 \${c.label}" aria-label="一键导入到 \${c.label}" onclick="importSub(\${i})">\${icon('open')}</button>\` : ''}
      <button class="ib tl" data-tip="预览配置内容" aria-label="预览配置内容" onclick="previewSub(\${i})">\${icon('eye')}</button>
    </div>
    <div class="sum">\${sumOf(x.own,o.own,'自有节点')} · \${sumOf(x.ups,o.ups,'机场')} · \${sumOf(x.regions,regionOpts(o),'地区')} · \${Array.isArray(x.policies) ? \`<b>专属策略 \${x.policies.length} 条</b>\` : sumOf(x.pols,o.pols,'策略') + '（继承）'}</div>
    \${lost.length ? \`<div class="seen warn">\${icon('warn','s')}<span>这份订阅不含\${lost.length > 1 ? '这些' : '这条'}严格策略指向的自建节点：\${lost.slice(0, 3).map(esc).join('、')}\${lost.length > 3 ? \` 等 \${lost.length} 条\` : ''} 会改走「🚀 节点选择」，出口变成机场节点</span></div>\` : ''}
    <div class="seen">\${icon('clock','s')}\${last
      ? \`<span>\${ago(last.at)}拉取 · \${esc(clientName(last.ua))}\${last.country ? ' · ' + flagOf(last.country) : ''}</span><button class="xs g" onclick="showHits(\${i})">\${hits.length} 个客户端</button>\`
      : '<span>还没有客户端拉取过</span>'}</div>
  </div>\`
}
window.pickClient = k => { CLI = k; store.set('client', k); dash(true) }

// ---------------- 分流策略页 ----------------
// 可选的分流目标。地区以 state 为准并入：策略接口只读节点缓存（切 tab 不该触发拉取），
// 而首次打开、或刚增删过订阅源时缓存是空的 —— 那一刻所有地区目标都会被误报成「已不存在」
function targetOpts(){
  const t = (POL.targets || []).slice()
  const have = new Set(t.map(x => x.v))
  let at = t.findIndex(x => x.v === 'direct'); if (at < 0) at = t.length
  for (const r of (ST && ST.regions) || []) {
    if (have.has('region:' + r.key)) continue
    t.splice(at++, 0, { v: 'region:' + r.key, label: \`\${r.flag} \${r.cn}（机场）\` })
  }
  return t
}
// 订阅编辑器里的地区选项，同样用 state 补齐
function regionOpts(o){
  const live = new Map(((ST && ST.regions) || []).map(r => [r.key, \`\${r.flag} \${r.cn}\`]))
  // 接口读缓存时可能把有节点的地区也标成「当前无节点」，以 state 为准改回来
  const out = (o.regions || []).map(x => live.has(x.v) ? { v: x.v, label: live.get(x.v) } : x)
  for (const [k, label] of live) if (!out.some(x => x.v === k)) out.push({ v: k, label })
  return out
}
function tgtLabel(v){
  const t = targetOpts().find(x => x.v === v)
  return t ? t.label : v
}
function polCount(p){
  const s = new Set()
  ;(p.presets||[]).forEach(k => ((POL.lib[k]||{}).domains||[]).forEach(d => s.add(d)))
  ;(p.domains||[]).forEach(d => s.add(d))
  return s.size
}
function viewPol(){
  if (!POL || !POL.ok) return errHTML(POL)
  const ps = POL.policies || []
  const pfs = POL.profiles || []
  // 目标失效时 resolveTarget 会静默回退到「节点选择」，出口可能悄悄变成别的地区。
  // 这种降级比直接报错更难察觉，必须在界面上点出来。
  const known = new Set(targetOpts().map(t => t.v))
  const polTargets = p => Array.isArray(p.target) ? (p.target.length ? p.target : ['all']) : [p.target || 'all']
  const broken = ps.filter(p => p.enabled !== false && polTargets(p).some(t => !known.has(t)))
  const cur = pfs.find(x => x.id === PF)
  const inherit = POL.inherit !== false
  const scopeOpts = [{v:'',label:'全局默认（新订阅的模板）'}, ...pfs.map(x => ({v:x.id, label:x.name + (x.own ? '（专属）' : '（继承）')}))]

  let h = \`<div class="card anim" style="animation-delay:.02s">
    <div class="ttl">分流策略\${PF && !inherit ? '<span class="tag" style="margin-left:0">专属</span>' : ''}<span class="sp">
      <button class="g sm" onclick="resetPol()">\${icon('undo','s')}恢复默认</button>
      <button class="sm" onclick="editPol(null)">\${icon('plus','s')}新建</button></span></div>
    <div class="row" style="flex-wrap:wrap;gap:8px 10px">
      <span class="lb" style="margin:0">编辑对象</span>
      <div style="flex:1;min-width:200px;max-width:320px">\${selectHTML('pfsel', scopeOpts, PF)}</div>
      \${PF ? (inherit
        ? \`<button class="g sm" onclick="detachPol()">改为专属配置</button>\`
        : \`<button class="g sm" onclick="inheritPol()">改回继承全局</button>\`) : ''}
    </div>
    <div class="hint" style="margin:8px 0 16px">\${
      !PF ? '这是全局模板，改动会影响所有「继承」状态的订阅。'
      : inherit ? \`「\${esc(cur ? cur.name : '')}」当前继承全局策略，这里看到的是全局内容。要单独配置请点「改为专属配置」。\`
      : \`「\${esc(cur ? cur.name : '')}」使用专属策略，与全局及其它订阅互不影响。\`
    }</div>
    <div class="desc" style="margin-top:0">顺序即匹配优先级：靠上的先命中，命中后不再往下匹配 —— 更具体的策略要放在更宽泛的前面。拖动左侧手柄调整。</div>
    \${broken.length ? \`<div class="alert" style="margin:-4px 0 13px">\${icon('warn','s')}
      <span>\${broken.map(p => esc(p.name)).join('、')} 指向的节点已不存在，当前被降级为「🚀 节点选择」——
      出口可能不是你预期的地区。请编辑这些策略重新指定目标。</span></div>\` : ''}
    <div id="pollist">\`
  h += ps.map((p, i) => \`<div class="pol \${p.enabled===false?'off':''}" draggable="true" data-i="\${i}">
      <span class="grip">\${icon('grip','s')}</span>
      <span class="ord">\${i + 1}</span>
      <span class="nm">\${esc(p.name)}</span>
      <span class="arrow">→</span>
      <span class="tgts">\${polTargets(p).map(t => \`<span class="tgt \${p.strict?'strict':''} \${known.has(t)?'':'gone'}" \${
        known.has(t) ? (p.strict?'data-tip="严格模式：目标不可用即失败，不回落"':'')
                     : 'data-tip="目标已不存在，实际走节点选择"'}>\${esc(tgtLabel(t))}</span>\`).join('')}</span>
      <span class="meta">\${(p.presets||[]).length ? (p.presets||[]).map(k => esc((POL.lib[k]||{}).name || k)).join(' · ') + ' · ' : ''}\${polCount(p)} 条域名\${(p.keywords||[]).length?' · '+p.keywords.length+' 关键词':''}\${(p.processes||[]).length?' · '+p.processes.length+' 进程':''}</span>
      <button class="sw" data-on="\${p.enabled===false?0:1}" data-tip="\${p.enabled===false?'启用':'停用'}" role="switch" aria-checked="\${p.enabled!==false}" aria-label="启用这条策略" onclick="togglePol(\${i})"><i></i></button>
      <button class="ib" data-tip="编辑" aria-label="编辑" onclick="editPol(\${i})">\${icon('edit')}</button>
      <button class="ib dl tl" data-tip="删除" aria-label="删除" onclick="delPol(\${i})">\${icon('trash')}</button>
    </div>\`).join('') || '<div class="empty">还没有策略</div>'
  h += \`</div></div>
  <div class="card anim" style="animation-delay:.06s">
    <div class="ttl">规则测试<span class="sub">\${PF ? '按「' + esc(cur ? cur.name : '') + '」这份订阅' : '按全局策略'}</span></div>
    <div class="desc">输入网址、域名或 IP，看它会命中哪条规则、从哪个出口出去。结果直接取自生成好的订阅，和客户端里的一致。</div>
    <div class="probe"><input id="mq" type="search" autocomplete="off" spellcheck="false" placeholder="如 chatgpt.com 或 https://www.youtube.com/watch?v=…" aria-label="要测试的网址">
      <button onclick="runMatch()">\${icon('play','s')}测试</button></div>
    <div class="samples"><span class="hint">试试</span>\${['youtube.com','chatgpt.com','gemini.google.com','github.com','icloud.com','bilibili.com'].map(d =>
      \`<button class="xs g" onclick="runMatch('\${d}')">\${d}</button>\`).join('')}</div>
    <div id="mres" aria-live="polite"></div>
  </div>\`
  return h
}

// ---------------- 域名库 ----------------
let LQ = ''
function viewLib(){
  if (!POL || !POL.ok) return errHTML(POL)
  const lib = POL.lib || {}
  const builtin = new Set(POL.builtin || []), custom = new Set(POL.custom || [])
  const refs = POL.refs || {}
  let h = \`<div class="card anim" style="animation-delay:.02s">
    <div class="ttl">域名库<span class="sub">\${Object.keys(lib).length} 个集合</span><span class="sp">
      <button class="sm" onclick="editLib(null)">\${icon('plus','s')}新建集合</button></span></div>
    <div class="desc">策略通过引用这些集合获得域名，一处修改，所有引用它的策略同步生效。内置集合改过之后可以一键恢复。</div>
    <div class="nfilter"><label class="search">\${icon('search','s')}<input id="lq" type="search" placeholder="查某个域名在哪个集合里" value="\${esc(LQ)}" oninput="filterLib(this.value)" aria-label="搜索域名" autocomplete="off">
      <button class="ib clr" type="button" aria-label="清空搜索" onclick="filterLib('');this.previousElementSibling.value='';this.previousElementSibling.focus()">\${icon('x','s')}</button></label>
      <span class="cnt" id="lqc" aria-live="polite"></span></div>\`
  h += '<div class="uplist lib">'
  h += Object.entries(lib).map(([k, v]) => {
    const r = refs[k] || []
    const kind = builtin.has(k) ? (custom.has(k) ? 'mod' : 'builtin') : 'custom'
    return \`<div class="up" data-k="\${esc(k)}" data-s="\${esc([v.name || k, v.hint || '', ...(v.domains || [])].join(' ').toLowerCase())}">
      <span class="nm">\${esc(v.name || k)}\${kind === 'custom' ? '<span class="tag">自定义</span>' : kind === 'mod' ? '<span class="tag mute">已修改</span>' : ''}</span>
      <span class="u w">\${esc(v.hint || '')}</span>
      <span class="tgt \${r.length ? '' : 'mute'}" \${r.length ? \`data-tip="\${esc('被引用：' + r.slice(0, 4).join('、') + (r.length > 4 ? ' 等' : ''))}"\` : ''}>\${r.length ? r.length + ' 条策略引用' : '未被引用'}</span>
      <span class="tgt">\${(v.domains||[]).length} 个域名</span>
      <span class="acts"><button class="ib" data-tip="编辑" aria-label="编辑" onclick="editLib(\${jsq(k)})">\${icon('edit')}</button>\${
        kind === 'custom' ? \`<button class="ib dl tl" data-tip="删除" aria-label="删除" onclick="delLib(\${jsq(k)})">\${icon('trash')}</button>\`
        : kind === 'mod' ? \`<button class="ib tl" data-tip="恢复内置内容" aria-label="恢复内置内容" onclick="restoreLib(\${jsq(k)})">\${icon('undo')}</button>\` : ''}</span>
    </div>\`
  }).join('')
  return h + '</div></div>'
}
window.filterLib = q => {
  LQ = String(q || '').trim().toLowerCase()
  let n = 0
  document.querySelectorAll('.uplist.lib .up').forEach(r => { const hit = !LQ || r.dataset.s.includes(LQ); r.hidden = !hit; if (hit) n++ })
  const c = document.getElementById('lqc')
  if (c) c.textContent = LQ ? (n ? \`\${n} 个集合包含「\${q.trim()}」\` : '没有集合包含它') : ''
}

// ---------------- 设置页 ----------------
function viewSet(){
  if (!SET || !SET.ok) return errHTML(SET)
  const st = SET.settings || { domain:'', directDomains:[], directIPs:[] }
  const row = (k, v) => \`<div class="up"><span class="nm">\${k}</span><span class="u w">\${v}</span></div>\`
  const list = a => (a || []).length ? esc(a.join('、')) : '<span style="color:var(--tx3)">（无）</span>'
  let h = \`<div class="card anim" style="animation-delay:.02s">
    <div class="ttl">站点<span class="sp"><button class="g sm" onclick="editSettings()">\${icon('edit','s')}编辑</button></span></div>
    <div class="desc">对所有订阅生效的全局规则。</div>
    <div class="uplist kv">
      \${row('本站域名', st.domain ? esc(st.domain) : '<span style="color:var(--warn)">未设置 —— 影响 DNS 策略与自身直连规则</span>')}
      \${row('直连域名', list(st.directDomains))}
      \${row('直连 IP', list(st.directIPs))}
      \${row('强制代理', list(st.proxyDomains))}
    </div>
  </div>
  <div class="card anim" style="animation-delay:.04s">
    <div class="ttl">DNS<span class="sp"><button class="g sm" onclick="editDns()">\${icon('edit','s')}编辑</button></span></div>
    <div class="desc">决定各类域名分别用哪个 DNS 解析。解析错了会直连到错误的地址 —— 表现是证书报错、跳到不相干的网站，而手机不挂代理反而正常。</div>
    \${dnsCardInner()}
  </div>
  <div class="card anim" style="animation-delay:.06s">
    <div class="ttl">账户与安全</div>
    <div class="uplist kv">
      <div class="up"><span class="nm">管理密码</span><span class="u w" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span>加盐哈希存储，连续输错 5 次锁定 15 分钟</span><button class="g xs" onclick="changePwd()">\${icon('lock','s')}修改密码</button></span></div>
      <div class="up"><span class="nm">登录会话</span><span class="u w" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span>每台设备登录后 7 天有效</span><button class="g xs" onclick="revokeOthers()">让其它设备下线</button><button class="g xs" onclick="logout()">\${icon('out','s')}退出登录</button></span></div>
    </div>
  </div>
  <div class="card anim" style="animation-delay:.08s">
    <div class="ttl">备份与恢复</div>
    <div class="desc">配置只存在这个 Worker 的 KV 里，没有别的副本。导出的文件包含全部配置和节点凭据（订阅 token、自建节点密钥），请妥善保管；登录密码不在其中。</div>
    <div class="row" style="flex-wrap:wrap">
      <button class="g sm" onclick="exportBackup(this)">\${icon('dl','s')}导出备份</button>
      <button class="g sm" onclick="importBackup()">\${icon('ul','s')}从文件恢复</button>
    </div>
  </div>
  <div class="card danger anim" style="animation-delay:.1s">
    <div class="ttl" style="color:var(--warn)">危险操作</div>
    <div class="uplist kv">
      <div class="up"><span class="nm">重置订阅</span><span class="u w" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span>全部订阅被替换为一份默认订阅，现有地址立即失效</span><button class="dg xs" onclick="resetProf()">重置</button></span></div>
    </div>
  </div>\`
  return h
}
function dnsCardInner(){
  const st = (SET && SET.settings) || {}
  const d = st.dns || {}
  const groups = (SET && SET.dnsGroups) || []
  const gl = k => (groups.find(g => g.k === k) || {}).label || k
  const row = (k, v) => \`<div class="up"><span class="nm">\${esc(k)}</span><span class="u brk">\${v}</span></div>\`
  let h = '<div class="uplist kv">'
  for (const g of groups) h += row(g.label, esc(((d[g.k] || []).join('、')) || '（未设置）'))
  h += row('本站域名走', \`<b>\${esc(gl(d.selfGroup))}</b>\`)
  const pol = (d.policies || []).map(p => \`\${esc(p.domain)} → \${esc(gl(p.group))}\`).join('　·　')
  h += row('域名指派', pol || '（无）')
  h += row('境外 DNS 走代理', d.remoteViaProxy === false
    ? '<span style="color:var(--warn)">关闭 —— 境内直连多半连不上境外 DoH，会回落到国内 DNS</span>' : '开启')
  h += row('解析模式', (d.fakeIp === false ? 'redir-host（真实 IP）' : 'fake-ip')
    + '　·　IPv6 ' + (d.ipv6 === false ? '关' : '开')
    + ((d.extraFilter || []).length ? '　·　额外不走 fake-ip：' + esc(d.extraFilter.join('、')) : ''))
  return h + '</div>'
}

// ---------------- 二维码 ----------------
// 紧凑 QR 码编码器（依 ISO/IEC 18004 公开描述自行实现，零依赖）。qrMatrix(text) 返回 boolean[][]（true 为黑），
// qrSVG(text, opts) 返回 SVG 字符串。字节模式 + UTF-8，纠错等级 M，自动选最小版本（1-40）与罚分最低的掩码。
// 全局只暴露这两个函数名。本文件会原样放进 JS 模板字符串，全文不得出现反引号、美元号接左花括号、反斜杠。
function qrMatrix(text) {
  var EXP = [], LOG = [], i, x, v, q, ecn, nb, dn, best, bestP, p;
  // GF(256)：本原多项式 0x11D，生成元 α = 2
  for (i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = x << 1 ^ (x & 128 ? 0x11d : 0); }
  function mul(a, b) { return a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0; }

  // Reed-Solomon：返回 data(x)·x^n 除以 g(x) = (x - α^0)(x - α^1)...(x - α^(n-1)) 的余式系数
  function rs(data, n) {
    var g = [1], r = [], a, b, f;
    for (a = 0; a < n; a++) { g.push(0); r.push(0); for (b = a + 1; b > 0; b--) g[b] ^= mul(g[b - 1], EXP[a]); }
    for (a = 0; a < data.length; a++) {
      f = data[a] ^ r.shift(); r.push(0);
      for (b = 0; b < n; b++) r[b] ^= mul(g[b + 1], f);
    }
    return r;
  }

  // BCH：d 左移 deg 位后拼上除以 poly 的余数（格式信息 (15,5) 与版本信息 (18,6) 共用）
  function bch(d, poly, deg) {
    for (var r = d << deg, t = 17; t >= deg; t--) if (r >> t & 1) r ^= poly << (t - deg);
    return d << deg | r;
  }

  // 写两份 15 位格式信息和固定暗模块。M 级纠错指示位是 00，所以 5 位数据就是掩码号
  function format(m, mask) {
    var n = m.length, bits = bch(mask, 0x537, 10) ^ 0x5412, t, b;
    for (t = 0; t < 15; t++) {
      b = (bits >> t & 1) == 1;
      m[t < 6 ? t : t < 8 ? t + 1 : 8][t < 8 ? 8 : t == 8 ? 7 : 14 - t] = b; // 左上：第 8 列向下再第 8 行向左，跳过定时线
      m[t < 8 ? 8 : n - 15 + t][t < 8 ? n - 1 - t : 8] = b; // 右上第 8 行 + 左下第 8 列
    }
    m[n - 8][8] = true;
  }

  // 画出版本 v 的功能图案（null 为空位），再按之字形顺序收集数据模块坐标
  function build(v) {
    var n = v * 4 + 17, m = [], cells = [], k = Math.floor(v / 7) + 2, al = [6], r, c, t, h, up, bits;
    for (r = 0; r < n; r++) m.push(Array(n).fill(null));
    function box(cr, cc, pat) { // 同心方环：pat 第 d 位是与中心切比雪夫距离为 d 处的颜色，越界跳过
      for (var dr = 1 - pat.length; dr < pat.length; dr++) for (var dc = 1 - pat.length; dc < pat.length; dc++)
        if (m[cr + dr] && cc + dc >= 0 && cc + dc < n) m[cr + dr][cc + dc] = pat[Math.max(Math.abs(dr), Math.abs(dc))] == '1';
    }
    box(3, 3, '11010'); box(3, n - 4, '11010'); box(n - 4, 3, '11010'); // 定位图案连同分隔带
    if (v > 1) { // 对齐图案中心：6，以及从 n-7 起按偶数步长向内等距的点（v32 的步长 26 是标准特例）
      for (t = n - 7; al.length < k; t -= v == 32 ? 26 : Math.ceil((v * 4 + 4) / (k * 2 - 2)) * 2) al.splice(1, 0, t);
      al.forEach(function (r) { al.forEach(function (c) { if (m[r][c] === null) box(r, c, '101'); }); });
    }
    for (t = 8; t < n - 8; t++) m[6][t] = m[t][6] = t % 2 == 0; // 定时线，须在对齐图案之后画（重叠处同色）
    format(m, 0); // 先占位，选定掩码后重写
    if (v > 6) for (bits = bch(v, 0x1f25, 12), t = 0; t < 18; t++) // 版本信息：右上、左下两块 6x3 互为转置
      m[Math.floor(t / 3)][n - 11 + t % 3] = m[n - 11 + t % 3][Math.floor(t / 3)] = (bits >> t & 1) == 1;
    for (c = n - 1, up = true; c > 0; c -= 2, up = !up) { // 自右向左两列一组上下蛇行，跳过第 6 列
      if (c == 6) c = 5;
      for (t = 0; t < n; t++) for (r = up ? n - 1 - t : t, h = 0; h < 2; h++) if (m[r][c - h] === null) cells.push([r, c - h]);
    }
    return { m: m, cells: cells };
  }

  // M 级每块纠错码字数（版本 1-21，22 起都是 28）与纠错块数（版本 1-40），取自标准的纠错块表
  var EC = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26],
    NB = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
      31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    bytes = new TextEncoder().encode(text), len = bytes.length, bits = [], data = [], blocks = [], ecs = [], out = [];
  for (v = 1; ; v++) { // 取最小可容纳版本；总码字数 = 数据模块数 / 8，零头是剩余位
    if (v > 40) throw new Error('QR 内容过长：UTF-8 共 ' + len + ' 字节，超过 40-M 上限 2331');
    q = build(v); ecn = EC[v - 1] || 28; nb = NB[v - 1]; dn = (q.cells.length >> 3) - ecn * nb;
    if (4 + (v < 10 ? 8 : 16) + len * 8 <= dn * 8) break;
  }

  // 位流：模式 0100、字符计数、数据、至多 4 位终止符，补零到整字节，再交替填充 0xEC、0x11
  function put(val, w) { while (w--) bits.push(val >> w & 1); }
  put(4, 4); put(len, v < 10 ? 8 : 16);
  for (i = 0; i < len; i++) put(bytes[i], 8);
  put(0, Math.min(4, dn * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  for (i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (i = 0; data.length < dn; i++) data.push(i % 2 ? 0x11 : 0xec);

  // 分块：前 nb - dn%nb 块各 floor(dn/nb) 个数据码字，其余块多 1 个；逐块算纠错码，再按列交织
  for (i = 0, x = 0; i < nb; i++) {
    blocks.push(data.slice(x, x += Math.floor(dn / nb) + (i < nb - dn % nb ? 0 : 1)));
    ecs.push(rs(blocks[i], ecn));
  }
  for (i = 0; i <= dn / nb; i++) blocks.forEach(function (b) { if (i < b.length) out.push(b[i]); });
  for (i = 0; i < ecn; i++) ecs.forEach(function (e) { out.push(e[i]); });

  // 填入数据位（剩余位自然为 0），并预先算好 8 种掩码的条件式，值为 0 处要取反
  q.cells.forEach(function (p, k) {
    var r = p[0], c = p[1];
    q.m[r][c] = (out[k >> 3] >> (7 - (k & 7)) & 1) == 1;
    p.push([(r + c) % 2, r % 2, c % 3, (r + c) % 3, (Math.floor(r / 2) + Math.floor(c / 3)) % 2,
      r * c % 2 + r * c % 3, (r * c % 2 + r * c % 3) % 2, ((r + c) % 2 + r * c % 3) % 2]);
  });
  function flip(k) { q.cells.forEach(function (p) { if (!p[2][k]) q.m[p[0]][p[1]] = !q.m[p[0]][p[1]]; }); }

  // 罚分（标准四条）：N1 行列中连续同色 5 格以上计 3+(长度-5)；N2 每个 2x2 同色块计 3；N3 行列中每出现一次
  // 10111010000 或 00001011101（1:1:3:1:1 加一侧 4 格浅色，符号外按浅色静区算）计 40；N4 深色占比每偏离 50% 满 5% 计 10
  function penalty(m) {
    var n = m.length, s = 0, dark = 0, lines = [], r, c, a, b, row, col;
    for (r = 0; r < n; r++) {
      for (a = m[r], b = m[r - 1], row = col = '', c = 0; c < n; c++) {
        row += a[c] ? 1 : 0; col += m[c][r] ? 1 : 0; dark += a[c] ? 1 : 0;
        if (b && c && a[c] == b[c] && a[c] == a[c - 1] && a[c] == b[c - 1]) s += 3;
      }
      lines.push(row, col);
    }
    lines.forEach(function (l) {
      (l.match(/0{5,}|1{5,}/g) || []).forEach(function (run) { s += run.length - 2; });
      s += (('0000' + l + '0000').match(/(?=10111010000|00001011101)/g) || []).length * 40;
    });
    return s + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  }
  for (best = 0, bestP = Infinity, i = 0; i < 8; i++) {
    flip(i); format(q.m, i); p = penalty(q.m); flip(i);
    if (p < bestP) { bestP = p; best = i; }
  }
  flip(best); format(q.m, best);
  return q.m;
}

// 渲染成 SVG：一条 path 画全部黑模块（每行连续黑块合并为一个矩形），四周留 4 模块静区，viewBox 用模块坐标。
// 配色取舍：码点若用 currentColor，暗色主题下会变成浅码深底的反色码，不少扫码器（含部分代理客户端）认不出。
// 所以 SVG 自带白色背景矩形、码点默认 #000，任何主题下都是深码浅底；确要跟随主题可传 opts.color = 'currentColor'，
// 但须自行保证它与 opts.bg 对比足够。opts：color 码点色（默认 #000）、bg 背景色（默认 #fff）、size 可选的宽高值
function qrSVG(text, opts) {
  opts = opts || {};
  var m = qrMatrix(text), n = m.length, w = n + 8, d = '', r, c, s;
  for (r = 0; r < n; r++) for (c = 0; c < n; c++) if (m[r][c]) {
    s = c;
    while (c + 1 < n && m[r][c + 1]) c++;
    d += 'M' + (s + 4) + ' ' + (r + 4) + 'h' + (c - s + 1) + 'v1H' + (s + 4) + 'z';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + w + '"' +
    (opts.size ? ' width="' + opts.size + '" height="' + opts.size + '"' : '') +
    ' shape-rendering="crispEdges"><rect width="' + w + '" height="' + w + '" fill="' + (opts.bg || '#fff') +
    '"/><path fill="' + (opts.color || '#000') + '" d="' + d + '"/></svg>';
}


// ================= 订阅 =================
window.copySub = async (i, b) => {
  const text = document.getElementById('su'+i).textContent
  if (!await copyText(text)) return toast('复制失败，请手动选取', true)
  const old = b.innerHTML
  b.innerHTML = icon('check','s') + '已复制'; b.classList.add('on')
  toast('订阅地址已复制')
  setTimeout(() => { b.innerHTML = old; b.classList.remove('on') }, 1500)
}
// 剪贴板 API 只在安全上下文里有；退路是临时 textarea + execCommand
async function copyText(t){
  try { await navigator.clipboard.writeText(t); return true } catch (e) {}
  try {
    const ta = document.createElement('textarea')
    ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta); ta.select()
    const ok = document.execCommand('copy'); ta.remove(); return ok
  } catch (e) { return false }
}
window.importSub = i => {
  const x = PRF.profiles[i], c = client()
  if (!c.imp) return
  location.href = c.imp(subUrl(x, c), x.name)
  toast(\`正在唤起 \${c.label}…没反应的话，说明这台设备没装它，复制地址手动添加即可\`)
}
window.qrSub = i => {
  const x = PRF.profiles[i], c = client()
  const url = subUrl(x, c)
  const alt = c.imp ? c.imp(url, x.name) : ''
  const draw = (b, v) => {
    b.querySelector('#qrv').innerHTML = qrSVG(v)
    b.querySelector('#qru').textContent = v
  }
  modal({ title: '扫码添加 · ' + x.name, ok: '完成', noCancel: true,
    desc: alt ? '在客户端里扫「订阅地址」；用手机相机扫「一键导入」会直接唤起 ' + c.label + '。' : '在客户端里扫码添加订阅。',
    html: \`\${alt ? \`<div class="seg" id="qrm" style="align-self:center">
        <button type="button" class="on" data-m="u">订阅地址</button><button type="button" data-m="i">一键导入</button></div>\` : ''}
      <div class="qr" id="qrv"></div>
      <div class="url" id="qru" style="font-size:11px;margin-top:4px;max-height:84px;overflow:auto"></div>\`,
    onMount: b => {
      draw(b, url)
      b.querySelectorAll('#qrm button').forEach(btn => btn.onclick = () => {
        b.querySelectorAll('#qrm button').forEach(z => z.classList.toggle('on', z === btn))
        draw(b, btn.dataset.m === 'i' ? alt : url)
      })
    } })
}
// 预览：这份订阅在各客户端格式下的完整内容。base64 格式解开再给人看。
//
// 切格式时弹窗一丝不能动。以前一切就把代码区清成一条骨架线、统计行清空：代码区从大半屏
// 塌成一行，整个弹窗跟着缩一下再撑开；统计行本来折在第二行，一清空就缩回第一行，下面的内容
// 整体上跳。现在代码区与统计行都是固定尺寸；新内容到手前旧内容原样留着（等久了才稍微变淡），
// 到手后一次换上；四种格式第一次打开后就在后台预取并缓存，之后来回切都是瞬间的。
function hlCode(t, f){
  return t.split('\\n').map(l => {
    const e = esc(l)
    if (f === 'singbox') {                    // JSON：键名着色
      const m = e.match(/^(\\s*)(&quot;(?:(?!&quot;).)*&quot;)(?=\\s*:)/)
      return m ? m[1] + '<span class="k">' + m[2] + '</span>' + e.slice(m[0].length) : e
    }
    if (f === 'share') {                      // 节点链接：协议头着色
      const m = e.match(/^([a-z][a-z0-9+.-]*:\\/\\/)/i)
      return m ? '<span class="k">' + m[1] + '</span>' + e.slice(m[1].length) : e
    }
    if (/^\\s*(#|\\/\\/|;)/.test(l)) return '<span class="cm">' + e + '</span>'
    if (f === 'shadowrocket' && /^\\s*\\[[^\\]]+\\]\\s*$/.test(l)) return '<span class="k">' + e + '</span>'
    const m = e.match(/^(\\s*-?\\s*)([\\w.-]+)(:|\\s*=)/)
    return m ? m[1] + '<span class="k">' + m[2] + '</span>' + e.slice(m[1].length + m[2].length) : e
  }).join('\\n')
}
window.previewSub = i => {
  const x = PRF.profiles[i]
  let fmt = client().k
  const cache = {}, pending = {}
  // 取一种格式并排好版，结果按格式缓存；同一格式同时只发一个请求
  const fetchFmt = f => pending[f] || (pending[f] = api('/api/preview?pf=' + encodeURIComponent(x.id) + '&fmt=' + f).then(r => {
    if (!r.ok) { delete pending[f]; return { ok: false, msg: r.msg || '加载失败' } }
    let show = r.body, note = ''
    if (r.fmt === 'share') {
      try { show = new TextDecoder().decode(Uint8Array.from(atob(r.body.trim()), ch => ch.charCodeAt(0))); note = '已解码显示，实际下发的是 base64' } catch (e) {}
    }
    const cut = show.length > 400000
    const u = r.usage ? Object.fromEntries(r.usage.split(';').map(s => s.trim().split('='))) : null
    return (cache[f] = { ok: true, f, body: r.body, name: r.filename, top: 0, left: 0,
      html: hlCode(cut ? show.slice(0, 400000) + '\\n…（太长，只显示前 400KB，完整内容请下载）' : show, r.fmt),
      stats: [\`\${r.nodes} 个节点\`, r.fmt === 'share' ? '' : \`\${r.policies} 条策略\`, \`\${show.split('\\n').length} 行\`, fmtBytes(r.bytes),
        u && +u.total ? \`流量 \${fmtSize(+u.total - (+u.upload||0) - (+u.download||0))} / \${fmtSize(+u.total)}\` : '', note]
        .filter(Boolean).map(s => \`<span>\${esc(s)}</span>\`).join('') })
  }))
  let seq = 0
  const show = async b => {
    const wrap = b.querySelector('#pvw'), pre = b.querySelector('#pvc'), st = b.querySelector('#pvs')
    const my = ++seq
    let v = cache[fmt]
    if (!v) {
      wrap.classList.add('busy')      // 旧内容留着，只在等得久时变淡（样式里有延迟）
      v = await fetchFmt(fmt)
      if (my !== seq) return          // 期间又切了格式：这份已经不是用户要看的了
      wrap.classList.remove('busy')
    }
    if (!v.ok) { pre.textContent = v.msg; pre.dataset.f = ''; return }
    // 内容、统计、滚动位置在同一帧里换好，中间态不会被画出来
    pre.innerHTML = v.html
    pre.dataset.f = fmt
    pre.scrollTop = v.top; pre.scrollLeft = v.left
    st.innerHTML = v.stats
  }
  const cur = () => cache[fmt]
  modal({ title: '预览 · ' + x.name, xl: true, ok: '关闭', noCancel: true,
    desc: '客户端拉到的就是这份内容。里面是真实的节点密钥，截图外发前记得打码。',
    html: \`<div class="seg" id="pvf" style="align-self:flex-start">\${CLIENTS.map(z => \`<button type="button" data-f="\${z.k}" class="\${z.k===fmt?'on':''}">\${z.label}</button>\`).join('')}</div>
      <div class="stats pv" id="pvs"></div>
      <div class="pvw" id="pvw"><pre class="code pv" id="pvc" tabindex="0">\${[62, 38, 51, 44, 70, 33, 57].map(w => \`<span class="sk" style="display:block;width:\${w}%;height:11px;margin:5px 0 12px"></span>\`).join('')}</pre>
        <span class="pvl">加载中…</span></div>\`,
    foot: \`<button class="g sm" id="pvcopy">\${icon('copy','s')}复制</button><button class="g sm" id="pvdl">\${icon('dl','s')}下载</button>\`,
    onMount: b => {
      // 先把当前格式显示出来，再在后台把其余三种取好
      show(b).then(() => CLIENTS.forEach(c => fetchFmt(c.k)))
      b.querySelectorAll('#pvf button').forEach(btn => btn.onclick = () => {
        if (btn.dataset.f === fmt) return
        // 记住离开时的滚动位置，切回来还在原处
        const pre = b.querySelector('#pvc')
        if (cur()) { cur().top = pre.scrollTop; cur().left = pre.scrollLeft }
        fmt = btn.dataset.f
        b.querySelectorAll('#pvf button').forEach(z => z.classList.toggle('on', z === btn))
        show(b)
      })
      b.querySelector('#pvcopy').onclick = async () => {
        const v = cur()
        if (!v || !v.ok) return toast('内容还没加载出来', true)
        toast(await copyText(v.body) ? '已复制全部内容' : '复制失败', false)
      }
      b.querySelector('#pvdl').onclick = () => {
        const v = cur()
        if (!v || !v.ok) return toast('内容还没加载出来', true)
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([v.body], { type: 'text/plain;charset=utf-8' }))
        a.download = v.name || 'subscription.txt'
        document.body.appendChild(a); a.click(); a.remove()
        setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      }
    } })
}
window.showHits = i => {
  const x = PRF.profiles[i]
  const hs = (PRF.hits || {})[x.id] || []
  const html = \`<div class="hits">\${hs.map(h => \`<div class="hit">
      <span class="flag" title="\${esc(h.country || '')}">\${flagOf(h.country) || '🌐'}</span>
      <span class="who">\${esc(clientName(h.ua))}<span style="color:var(--tx3);font-weight:400"> · \${esc(h.ip || '')}\${h.city ? ' · ' + esc(h.city) : ''}</span></span>
      <span class="when" title="\${esc(new Date(h.at).toLocaleString('zh-CN', {hour12:false}))}">\${ago(h.at)}</span>
      <span class="ua">\${esc(h.ua || '（没有 User-Agent）')}\${h.fmt ? ' · ' + esc(h.fmt) : ''}</span></div>\`).join('')}</div>\`
  modal({ title: '最近拉取 · ' + x.name, wide: true, ok: '知道了', noCancel: true,
    desc: '最近拉取过这份订阅的客户端，同一客户端半小时内只记一次。出现不认识的 IP，说明地址可能泄露了 —— 编辑订阅、重新生成 token，旧地址立即失效。', html })
}

async function saveProf(msg){
  const r = await api('/api/profiles', { profiles: PRF.profiles })
  if (!r.ok) { toast(r.msg || '保存失败', true); PRF = await api('/api/profiles'); dash(true); return false }
  PRF = null; POL = null      // 策略页的「编辑对象」下拉里列着各份订阅
  if (msg) toast(msg)
  ST = null   // 顶栏统计依赖它
  dash(true)
  return true
}
window.toggleProf = async (i, el) => {
  const x = PRF.profiles[i]
  x.enabled = x.enabled === false
  if (el) {
    const row = el.closest('.prof')
    if (row) row.classList.toggle('off', !x.enabled)
    setSw(el, x.enabled)
  }
  const r = await api('/api/profiles', { profiles: PRF.profiles })
  if (!r.ok) { toast(r.msg || '保存失败', true); PRF = null; dash(true); return }
  PRF.profiles = r.profiles
  toast(x.enabled ? \`「\${x.name}」已启用\` : \`「\${x.name}」已停用，客户端将拉不到它\`)
}
window.delProf = async i => {
  const x = PRF.profiles[i]
  if (!await modal({title:'删除订阅', desc:\`「\${x.name}」删除后，正在使用该地址的客户端会立刻拉不到配置。\`, ok:'删除', danger:true})) return
  PRF.profiles.splice(i,1); await saveProf('已删除')
}
window.resetProf = async () => {
  if (!await modal({title:'重置订阅', desc:'所有订阅会被替换为一份默认订阅，其它地址立即失效，正在用它们的客户端全部掉线。此操作不可撤销。', ok:'重置', danger:true})) return
  const r = await api('/api/profiles', { act:'reset' })
  if (!r.ok) return toast(r.msg || '失败', true)
  PRF = null; ST = null; POL = null; PF = ''; toast('已重置'); dash(true)
}

window.editProf = async (i) => {
  // 列表没加载到时保存，会拿一份残缺的数组把全部订阅覆盖掉
  if (!PRF || !PRF.ok || !Array.isArray(PRF.profiles)) return toast('订阅列表还没加载出来，刷新页面后再试', true)
  const isNew = i === null
  const o = PRF.opts || {own:[],ups:[],regions:[],pols:[]}
  const x = isNew
    ? { name:'', token: PRF.newToken || '', enabled:true, own:'all', ups:'all', regions:'all', pols:'all', mode:'whitelist', note:'' }
    : JSON.parse(JSON.stringify(PRF.profiles[i]))
  const html = \`
    <div class="fg"><label class="lb" for="sn">订阅名称</label><input id="sn" value="\${esc(x.name)}" placeholder="如 手机 / 家人" maxlength="24">
      <div class="hint">会作为配置名显示在客户端里。</div></div>
    <div class="fg"><label class="lb" for="stk">访问 token</label>
      <div class="row"><input id="stk" class="mono" value="\${esc(x.token)}" placeholder="16-64 位字母数字" spellcheck="false" autocomplete="off">
        <button type="button" class="g sm" id="sgen">重新生成</button></div>
      <div class="hint">这是这份订阅的唯一凭据，改了之后旧地址立即失效 —— 地址泄露时就用它。</div></div>
    <div class="fg"><label class="lb">默认模式</label>
      \${selectHTML('smd', [{v:'whitelist',label:'白名单（没命中规则的走代理）'},{v:'blacklist',label:'黑名单（没命中规则的直连）'}], x.mode)}</div>
    <div class="fg"><label class="lb">自有节点</label>\${chipsHTML('so', o.own, x.own, '自有节点')}</div>
    <div class="fg"><label class="lb">机场源</label>\${chipsHTML('su', o.ups, x.ups, '机场源')}</div>
    <div class="fg"><label class="lb">地区</label>\${chipsHTML('sr', regionOpts(o), x.regions, '地区')}</div>
    <div class="fg"><label class="lb">分流策略</label>
      <div class="hint" style="margin:0 0 7px">\${Array.isArray(x.policies)
        ? '该订阅使用<b style="color:var(--acc)">专属策略</b>，到「分流策略」页选中它即可单独编辑。'
        : '该订阅<b>继承全局策略</b>，可在下方勾选只启用其中一部分；要完全独立配置，请到「分流策略」页选中它并改为专属。'}</div>
      \${Array.isArray(x.policies) ? '' : chipsHTML('sp', o.pols, x.pols, '策略')}</div>
    <div class="fg"><label class="lb" for="snt">备注<span class="opt">可留空</span></label><input id="snt" value="\${esc(x.note||'')}" placeholder="如 给家里老人用" maxlength="60"></div>\`

  const box = await modal({ title: isNew ? '新建订阅' : '编辑订阅', html, ok:'保存', wide:true, onMount: b => {
    bindSelect(b); bindChips(b)
    b.querySelector('#sgen').onclick = () => {
      // 用 Web Crypto 生成，避免 Math.random 的可预测性
      const a = new Uint8Array(16); crypto.getRandomValues(a)
      b.querySelector('#stk').value = [...a].map(v => v.toString(16).padStart(2,'0')).join('')
    }
  }, onSubmit: async b => {
    const np = {
      id: x.id || 'f' + Date.now().toString(36),
      name: b.querySelector('#sn').value.trim(),
      token: b.querySelector('#stk').value.trim(),
      enabled: x.enabled !== false,
      mode: selValue(b.querySelector('#smd')),
      own: chipsValue(b.querySelector('#so')), ups: chipsValue(b.querySelector('#su')),
      regions: chipsValue(b.querySelector('#sr')),
      pols: b.querySelector('#sp') ? chipsValue(b.querySelector('#sp')) : (x.pols || 'all'),
      policies: Array.isArray(x.policies) ? x.policies : 'inherit',
      note: b.querySelector('#snt').value.trim()
    }
    if (!np.name) return { msg:'请填写订阅名称', field:'sn' }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(np.token))
      return { msg:'token 需为 16-64 位字母数字（可含 _ -），点「重新生成」最省事', field:'stk' }
    // 在副本上改：服务端拒了，页面上的数据也不会被带偏
    const next = PRF.profiles.slice()
    if (isNew) next.push(np); else next[i] = np
    const r = await api('/api/profiles', { profiles: next })
    if (!r.ok) {
      const m = r.msg || '保存失败'
      // 服务端是对全部订阅一起校验的，报的未必是这一条 —— 点名本条时才定位到字段
      const mine = m.includes('「' + np.name + '」')
      return { msg: m, field: /token/.test(m) && (mine || /重复/.test(m)) ? 'stk' : mine && /节点/.test(m) ? 'so' : null }
    }
    PRF.profiles = r.profiles
    return null
  }})
  if (!box) return
  toast(isNew ? '已新建订阅' : '已保存')
  PRF = null; ST = null; POL = null
  dash(true)
}

// ================= 分流策略 =================
/* 拖拽结束后按 DOM 的实际顺序回写数据；顺序没变就不发请求 */
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

// 订阅源顺序即节点加载顺序：靠前的机场，节点排在前面
async function persistUpOrder(){
  const list = document.querySelector('.uplist.src')
  if (!list) return
  const cur = ST.upstreams || []
  const ids = [...list.querySelectorAll('.up')].map(el => el.dataset.id)
  if (ids.length !== cur.length) return
  if (ids.every((id, i) => cur[i] && cur[i].id === id)) return
  ST.upstreams = ids.map(id => cur.find(u => u.id === id)).filter(Boolean)
  const r = await api('/api/upstreams', { act:'sort', ids })
  if (!r.ok) { toast(r.msg || '顺序保存失败', true); ST = null; return dash() }
  toast('顺序已保存')
  // 节点列表跟着换顺序，重绘它；订阅源那边 DOM 已经是对的，不动，
  // 免得把用户刚拖完的行又重建一遍。
  const card = document.getElementById('nodecard')
  if (card) card.classList.add('busy')
  PRF = null
  const s = await api('/api/state')
  if (card) card.classList.remove('busy')
  if (!s || !s.ok) return
  ST = s
  paintHeader()
  ;[...list.querySelectorAll('.up')].forEach((el, i) => { el.dataset.i = i })
  if (card) { card.innerHTML = nodeCardInner(); if (NQ || NF !== 'all') filterNodes(NQ) }
}

async function savePol(msg){
  const r = await api('/api/policies', { pf: PF, policies: POL.policies })
  if (!r.ok) {
    toast(r.msg || '保存失败', true)
    POL = await api('/api/policies?pf=' + encodeURIComponent(PF)); dash(true); return false
  }
  POL.policies = r.policies
  if (r.inherit !== undefined) POL.inherit = r.inherit
  POL.dirtyRefs = true
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
  setSw(row.querySelector('.sw'), on)
}
async function quietSave(){
  const r = await api('/api/policies', { pf: PF, policies: POL.policies })
  if (!r.ok) { toast(r.msg || '保存失败', true); POL = null; dash(true); return false }
  POL.policies = r.policies
  if (r.inherit !== undefined) POL.inherit = r.inherit
  POL.dirtyRefs = true
  PRF = null
  return true
}
window.togglePol = async i => {
  if (!POL || !POL.policies) return
  const p = POL.policies[i]
  p.enabled = p.enabled === false
  paintSwitch(document.querySelectorAll('#pollist .pol')[i], p.enabled !== false)
  if (await quietSave()) toast(p.enabled !== false ? \`「\${p.name}」已启用\` : \`「\${p.name}」已停用\`)
}
window.delPol = async i => {
  if (!POL || !POL.policies) return
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
  if (!POL || !POL.ok) return toast('策略还没加载出来，刷新页面后再试', true)
  const isNew = i === null
  const p = isNew ? { name:'', target:'all', strict:false, enabled:true, presets:[], domains:[], keywords:[], processes:[] } : JSON.parse(JSON.stringify(POL.policies[i]))
  const libs = Object.entries(POL.lib || {})
  const html = \`
    <div class="fg"><label class="lb" for="pn">策略名称</label>
      <input id="pn" value="\${esc(p.name)}" placeholder="如 🎬 流媒体" maxlength="24">
      <div class="hint">会成为客户端里的分组名，可以带 emoji。</div></div>
    <div class="fg"><label class="lb">分流目标<span class="opt">可多选</span></label>
      \${selectHTML('pt', targetOpts(), Array.isArray(p.target) ? p.target : [p.target || 'all'], true)}
      <div class="hint">选中的会按顺序放进该策略的节点组，客户端里可自行切换，第一个为默认。</div></div>
    <div class="fg"><label class="lb">严格模式</label>
      <div class="row"><button class="sw" id="ps" data-on="\${p.strict?1:0}" aria-label="严格模式"><i></i></button>
        <span class="hint" style="margin:0">开启后组内只有目标本身，目标不可用即断流，不会静默回落到其它地区。AI 类建议开启。</span></div></div>
    <div class="fg"><label class="lb">引用域名集</label>
      <div class="chips" id="pc">\${libs.map(([k,v]) =>
        \`<button type="button" class="chip \${(p.presets||[]).includes(k)?'on':''}" data-k="\${esc(k)}">\${esc(v.name||k)}<span class="n">\${(v.domains||[]).length}</span></button>\`).join('')}</div></div>
    <div class="fg"><label class="lb" for="pd">额外域名<span class="opt">每行一个，按后缀匹配，子域名自动包含</span></label>
      <textarea id="pd" placeholder="example.com">\${esc((p.domains||[]).join('\\n'))}</textarea></div>
    <div class="fg"><label class="lb">关键词 / 进程名<span class="opt">逗号分隔</span></label>
      <div class="row"><input id="pk" value="\${esc((p.keywords||[]).join(', '))}" placeholder="关键词，如 binance">
        <input id="pp" value="\${esc((p.processes||[]).join(', '))}" placeholder="进程名，如 ChatGPT"></div>
      <div class="hint">进程名规则只在电脑端的 Clash 系客户端里生效。</div></div>\`

  const box = await modal({ title: isNew ? '新建策略' : '编辑策略', html, ok:'保存', wide:true, onMount: b => {
    bindSelect(b); bindSwitch(b)
    b.querySelectorAll('#pc .chip').forEach(c => { c.setAttribute('aria-pressed', c.classList.contains('on')); c.onclick = () => { c.classList.toggle('on'); c.setAttribute('aria-pressed', c.classList.contains('on')) } })
  }, onSubmit: async b => {
    const name = b.querySelector('#pn').value.trim()
    if (!name) return { msg:'请填写策略名称 —— 它会成为客户端里的分组名', field:'pn' }
    if ((POL.policies || []).some((x, k) => k !== i && x.name === name))
      return { msg:'已有同名策略 —— 分组名重复会让客户端只认其中一个', field:'pn' }
    let pid = p.id
    if (!pid) {
      const base = 'p' + Math.abs([...name].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)).toString(36)
      pid = base
      // 同理：改过名的策略还用着这个 id，重复的 id 会让订阅的策略筛选分不清是哪条
      for (let n = 2; (POL.policies || []).some(x => x.id === pid); n++) pid = base + '-' + n
    }
    const np = {
      id: pid,
      name, target: selValue(b.querySelector('#pt')),
      strict: b.querySelector('#ps').dataset.on === '1',
      enabled: p.enabled !== false,
      presets: [...b.querySelectorAll('#pc .chip.on')].map(c => c.dataset.k),
      domains: b.querySelector('#pd').value.split('\\n').map(x => x.trim()).filter(Boolean),
      keywords: b.querySelector('#pk').value.split(/[,，]/).map(x => x.trim()).filter(Boolean),
      processes: b.querySelector('#pp').value.split(/[,，]/).map(x => x.trim()).filter(Boolean)
    }
    // 一条什么都不匹配的策略只会生成一个永远用不上的空分组
    if (!np.presets.length && !np.domains.length && !np.keywords.length && !np.processes.length)
      return { msg:'至少要有一条匹配规则：勾选域名集，或填额外域名 / 关键词 / 进程名', field:'pd' }
    b.__np = np
    return null
  }})
  if (!box) return
  if (isNew) POL.policies.push(box.__np); else POL.policies[i] = box.__np
  await savePol(isNew ? '已新建' : '已保存')
}

// 规则测试
window.runMatch = async q => {
  const inp = document.getElementById('mq')
  if (!inp) return
  if (typeof q === 'string') inp.value = q
  const v = inp.value.trim()
  if (!v) return inp.focus()
  const box = document.getElementById('mres')
  box.innerHTML = '<div class="mres"><div class="sk" style="width:62%;height:13px"></div><div style="height:9px"></div><div class="sk" style="width:40%;height:12px"></div></div>'
  const my = ++MSEQ
  const r = await api('/api/match', { q: v, pf: PF })
  if (my !== MSEQ || !document.body.contains(box)) return
  if (!r.ok) { box.innerHTML = errHTML(r); return }
  box.innerHTML = matchHTML(r)
}
let MSEQ = 0
function matchHTML(r){
  const tg = r.target
  const pi = ((POL && POL.policies) || []).findIndex(p => p.name === tg)
  const tag = tg === 'DIRECT' ? '<span class="tgt okc">直连</span>' : tg === 'REJECT' ? '<span class="tgt gone" style="text-decoration:none">拒绝</span>' : \`<span class="tgt strict">\${esc(tg)}</span>\`
  let h = \`<div class="mres"><div class="path"><b>\${esc(r.q)}</b>\${icon('arrow','s')}\`
  if (r.type === 'MATCH') h += \`没有命中任何规则，落到兜底\${icon('arrow','s')}\${tag}\`
  else h += \`命中第 \${r.index + 1} 条 <span class="rule">\${esc(r.rule)}</span>\${icon('arrow','s')}\${tag}\`
  h += '</div>'
  const ms = r.members || []
  if (ms.length) h += \`<div class="mem"><span class="hint" style="margin:0 2px 0 0">组内候选</span>\${ms.slice(0, 10).map((m, k) =>
    \`<span class="tgt \${k ? '' : 'first'}">\${esc(m)}\${k ? '' : '（默认）'}</span>\`).join('')}\${ms.length > 10 ? \`<span class="hint" style="margin:0">等 \${ms.length} 个</span>\` : ''}</div>\`
  const notes = []
  const src = r.src || {}
  if (src.kind === 'policy') notes.push(\`来自策略「\${esc(src.policy)}」\${src.sets && src.sets.length ? '引用的域名集 <b>' + src.sets.map(esc).join('、') + '</b>' : src.keyword ? '的关键词（不分大小写，包含即命中）' : src.process ? '的进程名' : '的额外域名'}。\`)
  if (src.kind === 'direct') notes.push('来自「设置 → 站点 → 直连域名」。')
  if (src.kind === 'directIP') notes.push('来自「设置 → 站点 → 直连 IP」。')
  if (src.kind === 'proxy') notes.push('来自「设置 → 站点 → 强制代理」，它排在所有直连规则之前。')
  if (src.kind === 'self') notes.push('这是本站域名：永远直连，访问管理端不绕代理。')
  const pre = (r.unsure || []).filter(u => u.index < r.index)
  const proc = pre.filter(u => u.type === 'PROCESS-NAME')
  if (proc.length) notes.push(\`前面还有 \${proc.length} 条进程规则（如 <span class="rule">\${esc(proc[0].rule)}</span>）：来自这些程序的连接会先被它们截走。\`)
  if (pre.some(u => /^GEO/.test(u.type))) {
    const cn = /\\.cn$/.test(r.q)
    notes.push(cn ? '以 .cn 结尾，客户端的 <b>GEOSITE,cn</b> 几乎一定先命中 → <b>直连</b>。'
      : '兜底前还有 <b>GEOSITE,cn</b> 与 <b>GEOIP,CN</b>：它若是国内网站、或解析到国内 IP，会先直连 —— 这要看客户端自带的地理数据库，这里判断不了。')
  }
  if (r.kind === 'ip' && r.type === 'MATCH') notes.push('输入的是 IP：只有 IP 规则会参与匹配，域名规则对它不起作用。')
  if (notes.length) h += \`<div class="note">\${notes.join('<br>')}</div>\`
  if (pi >= 0) h += \`<div style="margin-top:10px"><button class="g xs" onclick="editPol(\${pi})">\${icon('edit','s')}编辑「\${esc(tg)}」</button></div>\`
  return h + '</div>'
}
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target && e.target.id === 'mq' && !e.isComposing) runMatch() })

// ================= 域名库 =================
window.editLib = async (key) => {
  if (!POL || !POL.ok) return toast('域名库还没加载出来，刷新页面后再试', true)
  const isNew = key === null
  const v = isNew ? { name:'', hint:'', domains:[] } : (POL.lib[key] || { name:'', hint:'', domains:[] })
  const refs = (POL.refs || {})[key] || []
  const html = \`
    <div class="fg"><label class="lb" for="ln">集合名称</label><input id="ln" value="\${esc(v.name||'')}" placeholder="如 流媒体" maxlength="24"></div>
    <div class="fg"><label class="lb" for="lh">说明<span class="opt">可留空</span></label><input id="lh" value="\${esc(v.hint||'')}" placeholder="写给自己看的备注" maxlength="60"></div>
    <div class="fg"><label class="lb" for="ld">域名<span class="opt">每行一个，保存时自动去重、转小写</span></label>
      <textarea id="ld" style="min-height:180px">\${esc((v.domains||[]).join('\\n'))}</textarea>
      <div class="hint">按后缀匹配：写 <code>google.com</code> 就包含了 <code>mail.google.com</code>，不用写 <code>*.</code>。\${refs.length ? \`<br>改动会同步到引用它的 \${refs.length} 条策略：\${esc(refs.slice(0, 5).join('、'))}\${refs.length > 5 ? ' 等' : ''}。\` : ''}</div></div>\`
  const box = await modal({ title: isNew ? '新建域名集' : '编辑域名集', html, ok:'保存', wide:true, onSubmit: async b => {
    const name = b.querySelector('#ln').value.trim()
    if (!name) return { msg:'请填写域名集名称', field:'ln' }
    const doms = b.querySelector('#ld').value.split('\\n').map(x => x.trim()).filter(Boolean)
    if (!doms.length) return { msg:'至少填一个域名 —— 空域名集不会产生任何规则', field:'ld' }
    let k2 = key
    if (!k2) {
      const base = 'c' + Math.abs([...name].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)).toString(36)
      k2 = base
      // 改过名的旧集合还占着这个 key：不加序号的话，新建会把它整个覆盖掉
      for (let n = 2; (POL.lib || {})[k2]; n++) k2 = base + '-' + n
    }
    const r = await api('/api/lib', { key: k2, name, hint: b.querySelector('#lh').value.trim(), domains: doms })
    if (!r.ok) return { msg: r.msg || '保存失败', field: /名称/.test(r.msg || '') ? 'ln' : 'ld' }
    b.__lib = r
    return null
  }})
  if (!box) return
  POL.lib = box.__lib.lib; POL.custom = box.__lib.custom; toast('已保存'); dash(true)
}
window.delLib = async key => {
  const v = POL.lib[key] || {}
  if (!await modal({ title:'删除域名集', desc:\`「\${v.name || key}」将被删除。\`, ok:'删除', danger:true, onSubmit: async () => {
    const r = await api('/api/lib', { key, act:'del' })
    return r.ok ? null : (r.msg || '删除失败')
  } })) return
  POL = null; toast('已删除'); dash(true)
}
window.restoreLib = async key => {
  const v = POL.lib[key] || {}
  if (!await modal({ title:'恢复内置内容', desc:\`「\${v.name || key}」会回到内置的域名列表，你加过的域名将被丢弃。\`, ok:'恢复', danger:true })) return
  const r = await api('/api/lib', { key, act:'del' })
  if (!r.ok) return toast(r.msg || '失败', true)
  POL = null; toast('已恢复内置内容'); dash(true)
}

// ================= 设置 =================
window.editSettings = async () => {
  // 没加载到就别打开：拿一张空表单点保存，直连名单和强制代理名单会被整份清空
  if (!SET || !SET.ok || !SET.settings) return toast('站点设置还没加载出来，刷新页面后再试', true)
  const st = SET.settings
  const html = \`
    <div class="fg"><label class="lb" for="stdm">本站域名</label>
      <input id="stdm" value="\${esc(st.domain)}" placeholder="\${esc(location.hostname)}">
      <div class="hint">用于 DNS 策略与「访问本站不走代理」的规则，填部署这个 Worker 的域名\${/workers\\.dev$|localhost|127\\.0\\.0\\.1/.test(location.hostname) ? '' : \`（就是现在地址栏里的 <code>\${esc(location.hostname)}</code>）\`}。</div></div>
    <div class="fg"><label class="lb" for="stdd">额外直连域名<span class="opt">每行一个</span></label>
      <textarea id="stdd" placeholder="api.example.com">\${esc(st.directDomains.join('\\n'))}</textarea>
      <div class="hint">按域名后缀匹配，子域名自动包含 —— 填 <code>example.com</code> 就等于覆盖了
        <code>a.example.com</code>，不用写 <code>*.</code>。粘完整网址也行，会自动剥成域名。</div></div>
    <div class="fg"><label class="lb" for="stip">额外直连 IP<span class="opt">每行一个</span></label>
      <textarea id="stip" placeholder="203.0.113.10" style="min-height:70px">\${esc(st.directIPs.join('\\n'))}</textarea>
      <div class="hint">自建节点所在服务器的 IP 建议填这里：程序按 IP 直连时匹配不到域名规则，会被兜底送进代理绕一圈。</div></div>
    <div class="fg"><label class="lb" for="stpx">强制走代理的域名<span class="opt">每行一个</span></label>
      <textarea id="stpx" placeholder="relay.example.com" style="min-height:70px">\${esc((st.proxyDomains||[]).join('\\n'))}</textarea>
      <div class="hint">规则生成在<b>所有直连规则之前</b>，是唯一能从「整个域名直连」里把个别子域名拎出来的位置。
        用途：某个子域名在直连时被劫持（证书报错、跳到不相干的网站），而同域名下别的服务又必须直连。</div></div>\`
  const box = await modal({ title:'站点设置', html, ok:'保存', wide:true, onSubmit: async b => {
    const lines2 = sel => b.querySelector(sel).value.split('\\n').map(x => x.trim()).filter(Boolean)
    const bad = lines2('#stip').find(x => !/^(\\d{1,3}\\.){3}\\d{1,3}$/.test(x))
    if (bad) return { msg:'「' + bad + '」不是合法的 IPv4 地址', field:'stip' }
    const r = await api('/api/settings', {
      domain: b.querySelector('#stdm').value.trim(),
      directDomains: lines2('#stdd'), directIPs: lines2('#stip'), proxyDomains: lines2('#stpx')
    })
    if (!r.ok) return { msg: r.msg || '保存失败', field: /IP/.test(r.msg || '') ? 'stip' : 'stdm' }
    SET = { ok:true, settings: r.settings, dnsGroups: (SET && SET.dnsGroups) || [] }
    return null
  }})
  if (!box) return
  toast('已保存'); dash(true)
}

/* 自有节点编辑：按协议动态切换专属字段 */
window.editOwn = async (key) => {
  const isNew = key === null
  const ow = (OWN && OWN.own) || {}
  const n = isNew ? { name:'', type:'vless', s:'', p:443, u:'', sni:'', net:'tcp', flow:'xtls-rprx-vision', pk:'', sid:'', path:'/', host:'', obfs:'salamander', opwd:'', ports:'' } : JSON.parse(JSON.stringify(ow[key]))
  const html = \`
    \${isNew ? \`<div class="fg"><label class="lb" for="oimp">从分享链接导入<span class="opt">可选</span></label>
      <div class="row"><input id="oimp" class="mono" placeholder="vless://… 或 hysteria2://…" spellcheck="false" autocomplete="off">
        <button type="button" class="g" id="oimpb" style="white-space:nowrap">解析填充</button></div>
      <div class="hint">粘贴节点的分享链接，自动填好下面各项，核对无误就能直接保存。</div></div><hr class="fsep">\` : ''}
    <div class="fg"><label class="lb" for="on">节点名称</label><input id="on" value="\${esc(n.name)}" placeholder="如 美西-AI-Vision" maxlength="32">
      <div class="hint">会作为节点名出现在客户端里，也是分流策略里选择它时看到的名字。</div></div>
    <div class="fg"><label class="lb">协议</label>
      \${selectHTML('ot', [{v:'vless',label:'VLESS'},{v:'hysteria2',label:'Hysteria2'}], n.type)}</div>
    <div class="fg"><label class="lb" for="os">服务器 / 端口</label>
      <div class="row"><input id="os" class="mono" value="\${esc(n.s)}" placeholder="cloud.example.com" spellcheck="false">
        <input id="op" class="mono" value="\${esc(String(n.p||443))}" placeholder="443" inputmode="numeric" style="max-width:110px"></div></div>
    <div class="fg"><label class="lb" id="ulb" for="ou">UUID</label><input id="ou" class="mono" value="\${esc(n.u)}" placeholder="uuid 或密码" spellcheck="false" autocomplete="off"></div>
    <div class="fg"><label class="lb" for="osni">SNI</label><input id="osni" class="mono" value="\${esc(n.sni||'')}" placeholder="www.bing.com" spellcheck="false"></div>
    <div id="fv">
      <div class="fg"><label class="lb">传输方式</label>
        \${selectHTML('onet', [{v:'tcp',label:'TCP + Reality（Vision 流控）'},{v:'xhttp',label:'XHTTP + Reality'},{v:'ws',label:'WebSocket + TLS（可套 CDN）'}], n.net||'tcp')}</div>
      <div class="fg" id="fr"><label class="lb" for="opk">Reality 公钥 / ShortId</label>
        <div class="row"><input id="opk" class="mono" value="\${esc(n.pk||'')}" placeholder="PublicKey" spellcheck="false">
          <input id="osid" class="mono" value="\${esc(n.sid||'')}" placeholder="ShortId" style="max-width:150px" spellcheck="false"></div></div>
      <div class="fg" id="fw" hidden><label class="lb" for="opath">WebSocket 路径 / Host<span class="opt">Host 留空则用 SNI</span></label>
        <div class="row"><input id="opath" class="mono" value="\${esc(n.path||'/')}" placeholder="/" style="max-width:180px" spellcheck="false">
          <input id="ohost" class="mono" value="\${esc(n.host||'')}" placeholder="cdn.example.com" spellcheck="false"></div></div>
    </div>
    <div id="fh" hidden>
      <div class="fg"><label class="lb" for="oports">端口跳跃<span class="opt">可留空</span></label><input id="oports" class="mono" value="\${esc(n.ports||'')}" placeholder="50000-50020"></div>
      <div class="fg"><label class="lb" for="oobfs">混淆类型 / 密码</label>
        <div class="row"><input id="oobfs" class="mono" value="\${esc(n.obfs||'salamander')}" placeholder="salamander" style="max-width:150px">
          <input id="oopwd" class="mono" value="\${esc(n.opwd||'')}" placeholder="obfs 密码" autocomplete="off"></div></div>
    </div>
    \${isNew ? '' : \`<div class="fg"><label class="lb">节点标识<span class="opt">自动生成，不可改</span></label>
      <input class="mono" value="\${esc(key || '')}" disabled>
      <div class="hint">分流策略在内部通过它指向这个节点，所以建好之后不能再变。</div></div>\`}\`

  const box = await modal({ title: isNew ? '添加自有节点' : '编辑自有节点', html, ok:'保存', wide:true, onMount: b => {
    bindSelect(b)
    const sync = () => {
      const t = b.querySelector('#ot').dataset.v
      const ws = b.querySelector('#onet').dataset.v === 'ws'
      b.querySelector('#fv').hidden = t !== 'vless'
      b.querySelector('#fh').hidden = t !== 'hysteria2'
      b.querySelector('#fr').hidden = ws
      b.querySelector('#fw').hidden = !ws
      b.querySelector('#ulb').textContent = t === 'vless' ? 'UUID' : '密码'
    }
    b.querySelectorAll('#ot .selo, #onet .selo').forEach(o => o.addEventListener('click', () => setTimeout(sync, 0)))
    sync()

    const impb = b.querySelector('#oimpb')
    if (impb) impb.addEventListener('click', async () => {
      b.querySelectorAll('.ferr').forEach(e => e.remove())
      b.querySelectorAll('.bad').forEach(e => e.classList.remove('bad'))
      const box2 = b.querySelector('#oimp')
      const link = box2.value.trim()
      const say = (m, warn) => {
        const tip = document.createElement('div')
        tip.className = 'ferr'
        if (!warn) box2.classList.add('bad')
        else tip.style.color = 'var(--tx2)'
        tip.textContent = m
        box2.closest('.fg').appendChild(tip)
      }
      if (!link) return say('先粘贴一条分享链接')
      impb.disabled = true; impb.textContent = '解析中…'
      const r = await api('/api/parse-share', { link })
      impb.disabled = false; impb.textContent = '解析填充'
      if (!r.ok) return say(r.msg || '解析失败')
      const n2 = r.node
      // 协议是自定义下拉，点一下对应项才会重绘显示
      const opt = b.querySelector('#ot .selo[data-v="' + n2.type + '"]')
      if (opt && b.querySelector('#ot').dataset.v !== n2.type) opt.click()
      setTimeout(() => {
        const put = (id, v) => { const el = b.querySelector('#' + id); if (el && v !== undefined && v !== null) el.value = v }
        put('on', n2.name); put('os', n2.s); put('op', n2.p); put('ou', n2.u); put('osni', n2.sni)
        if (n2.type === 'vless') {
          put('opk', n2.pk); put('osid', n2.sid); put('opath', n2.path); put('ohost', n2.host)
          const no = b.querySelector('#onet .selo[data-v="' + (n2.net || 'tcp') + '"]')
          if (no && b.querySelector('#onet').dataset.v !== (n2.net || 'tcp')) no.click()
        } else {
          put('oports', n2.ports); put('oobfs', n2.obfs || 'salamander'); put('oopwd', n2.opwd)
        }
        sync()
        say(n2.warn || '已填好，核对一下就能保存', !n2.warn)
        const nf = b.querySelector('#on')
        if (nf) nf.focus()
      }, 30)
    })
  }, onSubmit: async b => {
    const val = id => b.querySelector('#' + id).value.trim()
    const t = selValue(b.querySelector('#ot'))
    if (!val('on')) return { msg:'请填写节点名称', field:'on' }
    // 标识是内部引用（策略里的 own:xxx），用户在策略下拉里看到的一直是节点名，
    // 从头到尾接触不到它 —— 以前却要人手填，还得遵守「只能字母数字连字符」。
    // 新建时按名称生成，重了就加序号。已有节点的标识保持不变，否则策略会失效。
    let k = key
    if (!k) {
      const base = 'n' + Math.abs([...val('on')].reduce((x, c) => x * 31 + c.charCodeAt(0) | 0, 7)).toString(36)
      k = base
      for (let n2 = 2; ow[k]; n2++) k = base + '-' + n2
    }
    if (!val('os')) return { msg:'请填写服务器地址', field:'os' }
    if (!/^\\d+$/.test(val('op')) || +val('op') < 1 || +val('op') > 65535) return { msg:'端口要是 1-65535 的数字', field:'op' }
    if (!val('ou')) return { msg: t === 'vless' ? '请填写 UUID' : '请填写密码', field:'ou' }

    const np = { name: val('on'), type: t, s: val('os'), p: val('op'), u: val('ou'), sni: val('osni') }
    if (t === 'vless' && selValue(b.querySelector('#onet')) === 'ws') {
      np.net = 'ws'; np.flow = ''
      np.path = val('opath') || '/'
      if (!np.path.startsWith('/')) return { msg:'路径要以 / 开头', field:'opath' }
      if (val('ohost')) np.host = val('ohost')
    } else if (t === 'vless') {
      // Reality 缺公钥会让客户端握手失败，报错极难定位，挡在这里
      if (!val('opk')) return { msg:'VLESS Reality 必须填公钥', field:'opk' }
      if (!val('osid')) return { msg:'VLESS Reality 必须填 ShortId', field:'osid' }
      // 格式不对的公钥会让客户端拒绝加载整份订阅，不只是这一个节点连不上
      if (!/^[A-Za-z0-9_-]{43}$/.test(val('opk'))) return { msg:'公钥应是 43 位的 base64url（xray x25519 输出的 Public key），现在是 ' + val('opk').length + ' 位', field:'opk' }
      if (!/^([0-9a-fA-F]{2}){0,8}$/.test(val('osid'))) return { msg:'ShortId 应是十六进制、位数为偶数、最多 16 位', field:'osid' }
      np.pk = val('opk'); np.sid = val('osid')
      np.net = selValue(b.querySelector('#onet'))
      np.flow = np.net === 'tcp' ? 'xtls-rprx-vision' : ''
    } else {
      np.ports = val('oports'); np.obfs = val('oobfs'); np.opwd = val('oopwd')
    }
    // 保存前重新拉一次自有节点，避免页面 OWN 过期/未加载时
    // 用空对象合并，把其它节点「覆盖删掉」触发误报悬空引用。
    const fresh = await api('/api/own')
    if (!fresh || !fresh.ok) return (fresh && fresh.msg) || '读取自有节点失败，请刷新后再试'
    const base = (fresh.own && typeof fresh.own === 'object') ? fresh.own : {}
    const r = await api('/api/own', { own: { ...base, [k]: np } })
    if (!r.ok) return r.msg || '保存失败'      // 服务端的话也留在弹窗里，不关
    OWN = null
    return null
  }})
  if (!box) return
  POL = null; PRF = null; CH = null
  toast(isNew ? '已添加' : '已保存')
  dash(true)
}

window.delOwn = async (key) => {
  const n = ((OWN && OWN.own) || {})[key] || { name: key }
  if (!await modal({title:'删除自有节点', desc:\`「\${n.name}」将从订阅中移除。若有策略指向它，需先改那些策略的分流目标。\`, ok:'删除', danger:true, onSubmit: async () => {
    const fresh = await api('/api/own')
    if (!fresh || !fresh.ok) return (fresh && fresh.msg) || '读取自有节点失败'
    const next = { ...((fresh.own && typeof fresh.own === 'object') ? fresh.own : {}) }
    delete next[key]
    const r = await api('/api/own', { own: next })
    return r.ok ? null : (r.msg || '删除失败')
  } })) return
  OWN = null; POL = null; PRF = null; CH = null
  toast('已删除'); dash(true)
}
window.copyOwnLink = async (key, b) => {
  const link = ((OWN && OWN.links) || {})[key]
  if (!link) return toast('这个节点生成不了分享链接', true)
  if (!await copyText(link)) return toast('复制失败', true)
  b.innerHTML = icon('check'); b.classList.add('on')
  toast('分享链接已复制 —— 里面有节点密钥，别发到公开场合')
  setTimeout(() => { b.innerHTML = icon('link'); b.classList.remove('on') }, 1500)
}

window.logout = async () => {
  if (!await modal({title:'退出登录', desc:'下次进入需要重新输入管理密码。', ok:'退出'})) return
  await fetch('/admin/logout', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' }).catch(() => {})
  location.reload()
}
window.revokeOthers = async () => {
  if (!await modal({ title:'让其它设备下线', desc:'除了现在这台，所有已登录的浏览器都要重新输入密码。怀疑密码或设备泄露时用它。', ok:'全部下线', danger:true })) return
  const r = await api('/api/sessions', {})
  toast(r.ok ? '其它设备已下线' : (r.msg || '操作失败'), !r.ok)
}
window.editDns = async () => {
  const st = (SET && SET.settings) || {}
  const d = { ...(st.dns || {}) }
  const groups = (SET && SET.dnsGroups) || []
  if (!groups.length) return toast('DNS 配置未加载', true)
  const ta = (id, arr, ph) => \`<textarea id="\${id}" class="mono" placeholder="\${ph}" style="min-height:66px" spellcheck="false">\${esc((arr||[]).join('\\n'))}</textarea>\`
  const polRow = (p, i) => \`<div class="row" data-pi="\${i}" style="gap:8px;margin-bottom:6px">
    <input class="pdm mono" value="\${esc(p.domain)}" placeholder="+.example.com" style="flex:1">
    \${selectHTML('pg' + i, groups.map(g => ({ v:g.k, label:g.label })), p.group)}
    <button type="button" class="ib dl" aria-label="删除这条" onclick="this.closest('[data-pi]').remove()">\${icon('trash')}</button></div>\`
  const html = \`
    \${groups.map(g => \`<div class="fg"><label class="lb" for="dg_\${g.k}">\${g.label}<span class="opt">每行一个</span></label>
      \${ta('dg_' + g.k, d[g.k], g.k === 'bootstrap' ? '223.5.5.5' : 'https://dns.example.com/dns-query')}
      <div class="hint">\${esc(g.hint)}</div></div>\`).join('')}
    <div class="fg"><label class="lb">本站域名用哪组解析</label>
      \${selectHTML('dself', groups.map(g => ({ v:g.k, label:g.label })), d.selfGroup || 'remote')}
      <div class="hint">本站域名若托管在 Cloudflare、服务器又在境外，交给国内 DNS 可能拿到被污染的地址；
        再叠加「本站域名直连」就会直连到错误的 IP，浏览器报证书错误。默认走境外组。</div></div>
    <div class="fg"><label class="lb">域名指派</label>
      <div id="dpol">\${(d.policies || []).map(polRow).join('')}</div>
      <button class="g sm" type="button" onclick="addDnsPol()">\${icon('plus','s')}添加一条</button>
      <div class="hint">指定某类域名固定用哪组 DNS。写法同 mihomo：<code>+.cn</code> 含所有子域名。</div></div>
    <div class="fg"><label class="lb">境外 DNS 走代理</label>
      <div class="row"><button class="sw" id="dviap" data-on="\${d.remoteViaProxy === false ? 0 : 1}" aria-label="境外 DNS 走代理"><i></i></button>
        <span class="hint" style="margin:0">强烈建议开启。境内直连连不上 Cloudflare / Google 的 DoH，
          连不上就会回落到国内明文 DNS —— 表现是 DNS 泄露检测里冒出运营商的 DNS 出口。
          不会循环依赖：节点地址由「国内 DNS」解析，代理先起得来。</span></div></div>
    <div class="fg"><label class="lb">解析模式</label>
      <div class="row"><button class="sw" id="dfake" data-on="\${d.fakeIp === false ? 0 : 1}" aria-label="fake-ip"><i></i></button>
        <span class="hint" style="margin:0">开启 fake-ip（推荐）。关掉则用 redir-host 返回真实 IP，兼容性好但会慢一些。</span></div>
      <div class="row" style="margin-top:8px"><button class="sw" id="dv6" data-on="\${d.ipv6 === false ? 0 : 1}" aria-label="IPv6"><i></i></button>
        <span class="hint" style="margin:0">解析 IPv6（AAAA）记录。</span></div></div>
    <div class="fg"><label class="lb" for="dfilter">额外不走 fake-ip 的域名<span class="opt">每行一个</span></label>
      \${ta('dfilter', d.extraFilter, 'example.com')}
      <div class="hint">某些应用要拿到真实 IP 才能工作（如部分游戏、内网服务）。本站域名已自动在列。</div></div>\`
  const box = await modal({ title:'DNS 设置', html, ok:'保存', wide:true,
    onMount: b => { bindSelect(b); bindSwitch(b); window.__dnsBox = b },
    onSubmit: async b => {
      const lines2 = sel => [...b.querySelectorAll(sel)].map(e => e.value).join('\\n')
        .split('\\n').map(x => x.trim()).filter(Boolean)
      const next = {
        selfGroup: selValue(b.querySelector('#dself')),
        remoteViaProxy: b.querySelector('#dviap').dataset.on === '1',
        fakeIp: b.querySelector('#dfake').dataset.on === '1',
        ipv6: b.querySelector('#dv6').dataset.on === '1',
        extraFilter: lines2('#dfilter'),
        policies: [...b.querySelectorAll('#dpol [data-pi]')].map(r2 => ({
          domain: r2.querySelector('.pdm').value.trim(),
          group: selValue(r2.querySelector('.sel'))
        })).filter(x => x.domain)
      }
      for (const g of groups) {
        const list = lines2('#dg_' + g.k)
        if (!list.length) return { msg: g.label + '不能为空 —— 至少留一个地址', field:'dg_' + g.k }
        // 引导 DNS 负责解析其它 DoH 的域名，自己再依赖域名解析就成了死循环
        if (g.k === 'bootstrap') {
          const bad = list.find(x => !/^(\\d{1,3}\\.){3}\\d{1,3}$/.test(x))
          if (bad) return { msg:'引导 DNS 必须是纯 IP，「' + bad + '」不行', field:'dg_bootstrap' }
        } else {
          const bad = list.find(x => !/^(https|tls|quic):\\/\\//.test(x) && !/^(\\d{1,3}\\.){3}\\d{1,3}$/.test(x))
          if (bad) return { msg:'「' + bad + '」不是有效地址 —— 要 https:// 开头的 DoH，或纯 IP', field:'dg_' + g.k }
        }
        next[g.k] = list
      }
      const r = await api('/api/settings', { ...st, dns: next })
      if (!r.ok) return r.msg || '保存失败'
      SET = { ok:true, settings: r.settings, dnsGroups: groups }
      return null
    } })
  if (!box) return
  toast('DNS 设置已保存'); dash(true)
}
window.addDnsPol = () => {
  const b = window.__dnsBox
  if (!b) return
  const groups = (SET && SET.dnsGroups) || []
  const i = 'n' + Date.now()
  b.querySelector('#dpol').insertAdjacentHTML('beforeend', \`<div class="row" data-pi="\${i}" style="gap:8px;margin-bottom:6px">
    <input class="pdm mono" placeholder="+.example.com" style="flex:1">
    \${selectHTML('pg' + i, groups.map(g => ({ v:g.k, label:g.label })), groups[0].k)}
    <button type="button" class="ib dl" aria-label="删除这条" onclick="this.closest('[data-pi]').remove()">\${icon('trash')}</button></div>\`)
  bindSelect(b)
  const inp = b.querySelectorAll('#dpol .pdm'); if (inp.length) inp[inp.length - 1].focus()
}

// ---- 链式代理 ----
async function reloadChains(msg){
  const card = document.getElementById('chaincard')
  if (card) card.classList.add('busy')
  CH = await api('/api/chains')
  POL = null      // 策略目标下拉里有链，要用最新的
  if (card) { card.classList.remove('busy'); card.innerHTML = chainCardInner() }
  if (msg) toast(msg)
}
window.chainAct = async (act, id) => {
  const r = await api('/api/chains', { act, id })
  if (!r.ok) return toast(r.msg || '操作失败', true)
  await reloadChains()
}
window.delChain = async (id) => {
  const c = ((CH && CH.chains) || []).find(x => x.id === id) || { name: id }
  if (!await modal({ title:'删除链式代理', desc:\`「\${c.name}」将被移除。指向它的分流策略会回落到「🚀 节点选择」。\`, ok:'删除', danger:true })) return
  const r = await api('/api/chains', { act:'del', id })
  if (!r.ok) return toast(r.msg || '删除失败', true)
  await reloadChains('已删除')
}
window.editChain = async (id) => {
  if (!CH || !CH.ok) return toast('链式代理还没加载出来，刷新页面后再试', true)
  const c = (CH.chains || []).find(x => x.id === id) || { name:'', via:'', out:'' }
  const vias = CH.vias || [], lands = CH.lands || []
  if (!vias.length || !lands.length) return toast('还没有可用的节点，先添加自有节点或订阅源', true)
  const html = \`
    <div class="fg"><label class="lb" for="cn">名称</label>
      <input id="cn" value="\${esc(c.name)}" placeholder="如 🔗 AI 家宽链" maxlength="30">
      <div class="hint">这会直接成为客户端里的节点名。</div></div>
    <div class="fg"><label class="lb">中转（先连这个）</label>
      \${selectHTML('cv', vias.map(v => ({ v:v.v, label:v.label })), c.via || vias[0].v)}
      <div class="hint">走它的线路出去。选组的话，组内节点挂了会自动换。</div></div>
    <div class="fg"><label class="lb">落地（出口 IP 是它）</label>
      \${selectHTML('co', lands.map(l => ({ v:l.v, label:l.label + (l.warn ? '  ⚠️' : '') })), c.out || lands[0].v)}
      <div class="hint" id="cow"></div></div>\`
  const box = await modal({ title: id ? '编辑链式代理' : '新建链式代理', html, ok:'保存', wide:true, onMount: b => {
    bindSelect(b)
    // 落地协议不对就当场说，别等用户导进客户端连不上才发现
    const sync = () => {
      const v = selValue(b.querySelector('#co'))
      const l = lands.find(x => x.v === v)
      b.querySelector('#cow').innerHTML = l && l.warn
        ? \`<span style="color:var(--warn)">\${esc(l.warn)}</span>\`
        : '只能选具体节点 —— dialer-proxy 是加在节点上的字段，指向一个组没地方安放。'
    }
    b.querySelectorAll('#co .selo').forEach(o => o.addEventListener('click', () => setTimeout(sync, 0)))
    sync()
  }, onSubmit: async b => {
    const name = b.querySelector('#cn').value.trim()
    if (!name) return { msg:'给这条链起个名字 —— 它会直接成为客户端里的节点名', field:'cn' }
    const r = await api('/api/chains', { act:'save', id, name,
      via: selValue(b.querySelector('#cv')), out: selValue(b.querySelector('#co')) })
    if (!r.ok) return { msg: r.msg || '保存失败', field: /同名|名字/.test(r.msg || '') ? 'cn' : null }
    return null
  }})
  if (!box) return
  await reloadChains(id ? '已保存' : '已新建')
}

window.changePwd = async () => {
  const html = \`
    <div class="fg"><label class="lb" for="p0">当前密码</label>
      <input id="p0" type="password" autocomplete="current-password" placeholder="先验证身份"></div>
    <div class="fg"><label class="lb" for="p1">新密码</label>
      <input id="p1" type="password" autocomplete="new-password" placeholder="至少 8 位"></div>
    <div class="fg"><label class="lb" for="p2">再输一次</label>
      <input id="p2" type="password" autocomplete="new-password" placeholder="确认新密码">
      <div class="hint">保存后其它设备上的登录会失效，当前这台不用重新登录。</div></div>\`
  const box = await modal({ title:'修改密码', html, ok:'保存', wide:true, onSubmit: async b => {
    const oldPassword = b.querySelector('#p0').value
    const newPassword = b.querySelector('#p1').value
    if (!oldPassword) return { msg:'请输入当前密码', field:'p0' }
    if (newPassword.length < 8) return { msg:'新密码至少 8 位', field:'p1' }
    // 输错了自己看不见，只能等下次登录才发现 —— 所以要求输两遍
    if (newPassword !== b.querySelector('#p2').value) return { msg:'两次输入的新密码不一致', field:'p2' }
    const r = await api('/api/password', { oldPassword, newPassword })
    if (!r.ok) return { msg: r.msg || '修改失败', field: /当前密码/.test(r.msg || '') ? 'p0' : 'p1' }
    return null
  }})
  if (!box) return
  toast('密码已更新')
}

window.exportBackup = async b => {
  if (b) b.disabled = true
  const r = await api('/api/backup')
  if (b) b.disabled = false
  if (!r.ok) return toast(r.msg || '导出失败', true)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r.backup, null, 2)], { type: 'application/json' }))
  a.download = 'cf-sub-worker-' + new Date().toISOString().slice(0, 10) + '.json'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  toast('备份已下载')
}
window.importBackup = () => {
  const inp = document.createElement('input')
  inp.type = 'file'; inp.accept = 'application/json,.json'
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]
    if (!f) return
    let bk = null
    try { bk = JSON.parse(await f.text()) } catch (e) { return toast('读不出这个文件：不是有效的 JSON', true) }
    if (!bk || bk.app !== 'cf-sub-worker' || !bk.data) return toast('这不是本服务导出的备份文件', true)
    const d = bk.data
    const cnt = (v, u) => Array.isArray(v) ? v.length + ' ' + u : v && typeof v === 'object' ? Object.keys(v).length + ' ' + u : '默认'
    const rows = [['导出时间', bk.at ? new Date(bk.at).toLocaleString('zh-CN', {hour12:false}) : '未知'],
      ['订阅源', cnt(d.upstreams, '个')], ['自有节点', cnt(d.nodes, '个')], ['订阅', cnt(d.profiles, '份')],
      ['分流策略', Array.isArray(d.policies) ? d.policies.length + ' 条' : '默认'], ['自定义域名集', cnt(d.lib, '个')],
      ['链式代理', cnt(d.chains, '条')], ['订阅源快照', Object.keys(bk.snaps || {}).length + ' 份']]
    const html = \`<div class="uplist kv">\${rows.map(([k, v]) => \`<div class="up"><span class="nm">\${k}</span><span class="u w">\${esc(v)}</span></div>\`).join('')}</div>\`
    if (!await modal({ title:'从备份恢复', desc:'当前全部配置会被备份内容替换，此操作不可撤销。拿不准的话，先导出一份当前配置。', html, ok:'恢复', danger:true, wide:true,
      onSubmit: async () => { const r = await api('/api/restore', { backup: bk }); return r.ok ? null : (r.msg || '恢复失败') } })) return
    toast('已从备份恢复')
    ST = POL = OWN = PRF = SET = CH = null
    dash()
  }
  inp.click()
}

// ================= 订阅源 =================
window.addUp = async () => {
  const html = \`
    <div class="fg"><label class="lb" for="un">名称<span class="opt">可留空</span></label>
      <input id="un" placeholder="便于区分多个来源，留空则从链接里取" maxlength="30"></div>
    <div class="fg"><label class="lb" for="uu">订阅链接</label>
      <input id="uu" class="mono" placeholder="https://..." spellcheck="false" autocomplete="off">
      <div class="hint">保存前会先试拉一次，确认能解析出节点。</div></div>
    <div class="fg"><label class="lb" for="ut">或粘贴订阅内容</label>
      <textarea id="ut" placeholder="机场拦住本站时用这个：浏览器打开订阅链接 → 全选复制 → 粘到这里"></textarea>
      <div class="hint">填了这里就不走网络，直接解析贴进来的内容并存成快照。</div></div>\`
  const box = await modal({ title:'添加订阅源', html, ok:'添加', wide:true, onSubmit: async b => {
    const name = b.querySelector('#un').value.trim()
    const url = b.querySelector('#uu').value.trim()
    const text = b.querySelector('#ut').value.trim()
    if (!url && !text) return { msg:'订阅链接和订阅内容至少要填一个', field:'uu' }
    if (url && !/^https?:\\/\\//.test(url)) return { msg:'链接要以 http:// 或 https:// 开头', field:'uu' }
    // 第一次拉不通不直接判死刑，也不再叠一个弹窗 —— 这个表单本来就有粘贴框，
    // 就地把话说清楚：要么把内容粘进来，要么再点一次先加进来。
    const ok = b.querySelector('[data-ok]')
    if (ok && !text) ok.textContent = '正在试拉…'
    let r = await api('/api/upstreams', { act:'add', name, url, text, force: b.__retry ? 1 : 0 })
    if (!r.ok && (r.canPaste || r.canForce) && !b.__retry) {
      b.__retry = 1
      return { msg: r.msg + '。可以在浏览器里打开这个链接、全选复制，粘到下面的框里再保存；或者直接再点一次「添加」先把它加进来（暂时不会有节点）。', field:'ut' }
    }
    if (!r.ok) return { msg: r.msg || '添加失败', field: text ? 'ut' : 'uu' }
    b.__up = r.up
    return null
  }})
  if (!box) return
  toast(box.__up && box.__up.n ? \`已添加，解析到 \${box.__up.n} 个节点\` : '已添加订阅源')
  await syncUp(box.__up)
}
window.editUp = async (id) => {
  const u = (ST.upstreams || []).find(x => x.id === id)
  if (!u) return
  const auto = u.auto !== false
  const snapAt = (ST.snaps || {})[id]
  const html = \`
    <div class="fg"><label class="lb" for="un">名称</label>
      <input id="un" value="\${esc(u.name)}" placeholder="便于区分多个来源" maxlength="30"></div>
    <div class="fg"><label class="lb" for="uu">订阅链接</label>
      <input id="uu" class="mono" value="\${esc(u.url)}" placeholder="https://..." spellcheck="false" autocomplete="off">
      <div class="hint">改动链接会立即拉取一次并刷新快照。</div></div>
    <div class="fg"><label class="lb">更新方式</label>
      \${selectHTML('ua', [
        {v:'1', label:'自动更新 — 每小时拉取最新节点'},
        {v:'0', label:'手动 — 只用快照，不自动拉取'}
      ], auto ? '1' : '0')}
      <div class="hint" id="uah"></div></div>
    <div class="fg"><label class="lb" for="ut">或粘贴订阅内容</label>
      <textarea id="ut" placeholder="机场拦住本站时用这个：浏览器打开订阅链接 → 全选复制 → 粘到这里"></textarea>
      <div class="hint">填了这里就不走网络，直接用贴进来的内容刷新快照，更新方式自动转为手动。</div></div>\`
  const box = await modal({ title:'编辑订阅源', html, ok:'保存', wide:true, onMount: b => {
    bindSelect(b)
    const sync = () => {
      b.querySelector('#uah').innerHTML = selValue(b.querySelector('#ua')) === '1'
        ? '常规机场用这个。链接长期有效，每小时自动拉一次。'
        : \`适合<b>有效期只有几分钟的一次性链接</b>：平时完全不请求它，固定使用快照。\${snapAt?'当前快照抓于 '+ago(snapAt)+'。':'目前还没有快照，保存后会先拉一次。'}需要更新节点时，回机场复制新链接贴到上面即可。\`
    }
    b.querySelectorAll('#ua .selo').forEach(o => o.addEventListener('click', () => setTimeout(sync, 0)))
    sync()
  }, onSubmit: async b => {
    const name = b.querySelector('#un').value.trim()
    const url = b.querySelector('#uu').value.trim()
    const text = b.querySelector('#ut').value.trim()
    const a = selValue(b.querySelector('#ua')) === '1'
    // 粘贴导入的源本来就没有链接，只改名字或更新方式时两样都不用填。
    // 原本有链接却被清空才拦：服务端收到空链接是保持原样，不拦的话用户会以为删掉了
    if (!url && !text && u.url) return { msg:'订阅链接和订阅内容至少要填一个', field:'uu' }
    if (url && !/^https?:\\/\\//.test(url)) return { msg:'链接要以 http:// 或 https:// 开头', field:'uu' }
    let r = await api('/api/upstreams', { act:'edit', id, name, url, auto:a, text, force: b.__retry ? 1 : 0 })
    if (!r.ok && (r.canPaste || r.canForce) && !b.__retry) {
      b.__retry = 1
      return { msg: r.msg + '。可以在浏览器里打开这个链接、全选复制，粘到下面的框里再保存；或者直接再点一次「保存」（在拿到能用的链接前它不会有新节点）。', field:'ut' }
    }
    if (!r.ok) return { msg: r.msg || '保存失败', field: text ? 'ut' : 'uu' }
    b.__up = r.up
    return null
  }})
  if (!box) return
  toast(box.__up && box.__up.n ? \`已保存，抓到 \${box.__up.n} 个节点\` : '已保存')
  await syncUp(null)
}
window.delUp = async (id) => {
  const u = (ST.upstreams || []).find(x => x.id === id) || { name: id }
  if (!await modal({title:'删除订阅源', desc:\`「\${u.name}」及其全部节点将从订阅中移除。\`, ok:'删除', danger:true})) return
  const r = await api('/api/upstreams', {act:'del', id})
  if (!r.ok) return toast(r.msg || '删除失败', true)
  const row = document.querySelector(\`.uplist.src .up[data-id="\${CSS.escape(id)}"]\`)
  if (row) row.remove()
  toast('已删除'); await syncUp(null)
}

// 增删订阅源后的局部刷新：新行立刻插入，数据后台重取，
// 只重绘受影响的两处。整页 dash() 会换骨架屏 + 重放入场动画，看着就是「闪一下」。
async function syncUp(nu){
  const list = document.querySelector('.uplist.src')
  if (nu && list) {
    const em = list.querySelector('.empty, .blank')
    if (em) em.remove()
    ST.upstreams.push(nu)
    list.insertAdjacentHTML('beforeend', upRow(nu, ST.upstreams.length - 1))
  }
  const card = document.getElementById('nodecard')
  if (card) card.classList.add('busy')
  PRF = null; CH = null            // 档案的机场选项、链式的落地清单都依赖它
  const r = await api('/api/state')
  if (card) card.classList.remove('busy')
  if (!r || !r.ok) return
  ST = r
  paintHeader()                    // 顶部「N 个订阅源 · M 个节点」
  if (list) {
    list.innerHTML = ST.upstreams.map(upRow).join('') || blankHTML('link', '还没有订阅源', '添加机场的订阅链接，节点会按地区归类、统一命名。')
    bindDrag('.uplist.src', '.up', persistUpOrder)   // 行是新建的，拖拽要重新绑
  }
  if (card) { card.innerHTML = nodeCardInner(); if (NQ || NF !== 'all') filterNodes(NQ) }
  // 上手清单、链式卡片跟着节点来源变
  if (TAB === 'node' && (!document.querySelector('.steps') !== !onboarding())) dash(true)
  else if (document.getElementById('chaincard')) api('/api/chains').then(c => { CH = c; const cc = document.getElementById('chaincard'); if (cc) cc.innerHTML = chainCardInner() })
}

window.probeUp = async (id) => {
  if (!id) return
  const u = (ST.upstreams || []).find(x => x.id === id) || { name: '' }
  const row = (k, v) => \`<div class="up"><span class="nm">\${k}</span><span class="u w" style="white-space:pre-wrap">\${esc(String(v))}</span></div>\`
  // 每种客户端身份的结果逐条列出：机场拒绝我们、还是给了解析不了的格式，一眼分得清
  const uaName = t => t.ua || '（不带 UA）'
  const tryLine = t => t.err ? \`\${uaName(t)} → 请求失败：\${t.err}\`
    : t.status < 200 || t.status >= 300 ? \`\${uaName(t)} → HTTP \${t.status}\${t.body ? '：' + t.body : ''}\`
    : \`\${uaName(t)} → HTTP \${t.status} · \${t.fmt} · \${t.bytes} 字节 · \${t.n} 个节点\`
  const fill = r => {
    let h = '<div class="uplist kv">'
    if (!r.ok) return errHTML(r)
    if (r.tries && r.tries.length) h += row('逐个身份试拉', r.tries.map(tryLine).join('\\n'))
    if (r.snap) h += row('本地快照', \`\${r.snap.n} 个节点，抓于 \${ago(r.snap.at)}\` + (r.http === 0 ? ' —— 拉不通时订阅仍靠它供节点' : ''))
    if (r.http === 0) {
      h += row('结果', '请求失败：' + (r.err || '未知错误'))
      h += row('怎么办', '机场可能挡住了 Cloudflare 的出站请求。在浏览器里打开订阅链接、全选复制，到「编辑订阅源」里粘贴内容即可。')
    } else {
      h += row('采用', \`\${uaName(r)} 这一份\`)
      h += row('HTTP', r.http) + row('响应格式', r.fmt) + row('大小', r.bytes + ' 字节') + row('解析到节点', r.nodes + ' 个')
      h += row('用量响应头', r.hasUserinfo ? r.headers['subscription-userinfo'] : '机场没有返回 Subscription-Userinfo 头')
      h += row('识别到的公告行', r.notes.length ? r.notes.join('\\n') : '（无）')
      h += row('最终用量信息', r.meta
        ? \`总量 \${r.meta.total ? fmtSize(r.meta.total) : '未知'} · 已用 \${fmtSize((r.meta.up||0)+(r.meta.down||0))} · 到期 \${r.meta.expire ? new Date(r.meta.expire*1000).toLocaleDateString('zh-CN') : '未知'}\`
        : '解析不出 —— 上面两行都没有可用信息')
      h += row('响应前几行', r.sample.join('\\n'))
    }
    return h + '</div>'
  }
  await modal({ title:'抓取诊断' + (u.name ? ' · ' + u.name : ''), desc:'机场到底给了什么，我们又解析出了什么。密钥字段已抹去。', ok:'知道了', noCancel:true, wide:true,
    html: '<div id="pbx"><div class="skrow"><div class="sk" style="width:120px;height:13px"></div><div class="sk" style="width:48%;height:12px"></div></div><div class="hint">正在用几种客户端身份逐个试拉，可能要十几秒…</div></div>',
    onMount: async b => {
      const r = await api('/api/probe', { id })
      const box = b.querySelector('#pbx')
      if (box) box.innerHTML = fill(r)
    } })
}
window.showErrors = () => {
  const es = (ST && ST.errors) || []
  go('node')
  if (!es.length) return
  const row = e => \`<div class="up"><span class="nm">\${esc(e.up)}</span><span class="u w">\${esc(e.msg)}</span></div>\`
  modal({ title:'订阅源拉取失败', desc: ST.stale ? '这一轮所有订阅源都没拉到，订阅暂时在用上一次成功的缓存。' : '这些源没拉到最新节点；有快照的会先用快照顶上。',
    html: \`<div class="uplist kv">\${es.map(row).join('')}</div><div class="hint">点订阅源行上的「拉取失败」或「用量」可以看逐个身份的试拉详情。</div>\`, ok:'知道了', noCancel:true, wide:true })
}
window.upAct = async (act, id, el) => {
  if (act === 'toggle' && el) {
    const row = el.closest('.up'), on = el.dataset.on === '1'
    row.classList.toggle('off', on)
    setSw(el, !on)
  }
  const r = await api('/api/upstreams', {act, id})
  if (!r.ok) { toast(r.msg || '操作失败', true); ST = null; return dash(true) }
  if (act === 'toggle') {
    const u = ((ST && ST.upstreams) || []).find(x => x.id === id)
    if (u) u.enabled = u.enabled === false
    PRF = null   // 档案的机场选项依赖它
    toast(u && u.enabled === false ? \`「\${u.name}」已停用，下次刷新起不再拉取\` : '已启用')
  } else {
    ST = null; PRF = null; dash()   // 增删要重拉节点
  }
}
window.toggle = async (el) => {
  const row = el && el.closest('.nd')
  if (!row) return
  const key = row.dataset.k
  const off = !row.classList.contains('off')
  row.classList.toggle('off', off)
  setSw(el, !off)
  const r = await api('/api/node', {key, off})
  if (!r.ok) { row.classList.toggle('off', !off); setSw(el, off); return toast(r.msg || '保存失败', true) }
  for (const rg of ((ST && ST.regions) || [])) {
    const n = rg.nodes.find(x => x.key === key)
    if (n) n.off = off
  }
}
window.rename = (btn) => {
  const row = btn.closest('.nd')
  if (row.querySelector('input')) return
  const key = row.dataset.k, nm = row.querySelector('.nm')
  const old = (nm.querySelector('span') || nm).textContent.trim()
  nm.innerHTML = \`<input class="edit" value="\${esc(old)}" aria-label="新名字（留空恢复自动命名）" placeholder="留空恢复自动命名">\`
  const inp = nm.querySelector('input'); inp.focus(); inp.select()
  let done = false
  const fin = async (save) => {
    if (done) return; done = true
    const v = inp.value.trim()
    if (!save || v === old) { ST = null; return dash(true) }
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
  inp.addEventListener('keydown', e => { if (e.isComposing) return; if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false) })
  inp.addEventListener('blur', () => fin(true))
}
window.refresh = async (b) => {
  b.disabled = true
  b.querySelector('svg').classList.add('spin')
  const r = await api('/api/refresh', {})
  const errs = (r.errors || []).length
  toast(r.ok ? \`已拉取 \${r.count} 个节点\${errs ? \`，\${errs} 个源失败\` : ''}\` : (r.msg || '拉取失败'), !r.ok || !!errs)
  ST = null; dash(true)
}

authed ? dash() : login()
</script></body></html>`
}
