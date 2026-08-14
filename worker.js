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
function flagRegion(name) {
  const m = String(name).match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)
  if (!m) return null
  const cc = [...m[0]].map(c => String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 65)).join('').toLowerCase()
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

// 订阅名下发给客户端。HTTP 头只能是 ASCII，中文得按 RFC 6266 编码成
// filename*，同时留一份 ASCII 的 filename 给不认 filename* 的老客户端。
// 两个都给时，认得 filename* 的客户端会优先用它。
function contentDisposition(name) {
  const n = String(name || '').trim().slice(0, 60) || '订阅'
  // 引号和反斜杠会截断头部，控制字符更是直接让整个响应非法
  const ascii = n.replace(/[^\x20-\x7E]/g, '').replace(/["\\;]/g, '').trim()
  const fallback = ascii || 'subscription'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(n)}`
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

// ---------- 分享链接 / 块式 YAML → Clash 节点 ----------
// 机场按 UA 给的格式天差地别：clash UA 给 YAML（有的单行 flow、有的块式缩进），
// 浏览器与 v2rayN UA 常给 base64 分享链接列表。三条路最终都落到同一种 kv 形状
// （键名用 Clash proxy 的字段名），下游 genClash / toSB / shareLink 才不用各认一套。

// flow 写法里以 - ? : 等开头、或含逗号花括号的值必须加引号，否则 YAML 解析器
// 会把它当成别的结构 —— reality 的 public-key 就常以 '-' 开头。机场原样给的
// YAML 自己带了引号，我们从分享链接造 kv 时得自己补。
function flowVal(s) {
  const t = String(s)
  if (t === '') return "''"
  if (/^['"]/.test(t)) return t                                  // 已经带引号
  if (/^[-?:,[\]{}#&*!|>%@`]|[,{}[\]]|:\s|\s#/.test(t)) return `'${t.replace(/'/g, "''")}'`
  return t
}

// 对象 → YAML flow 映射字符串，嵌套递归。空对象返回 '' 表示该字段不写。
function nestFlow(o) {
  const parts = []
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue
    const s = (typeof v === 'object') ? nestFlow(v) : flowVal(v)
    if (s !== '') parts.push(`${k}: ${s}`)
  }
  return parts.length ? `{ ${parts.join(', ')} }` : ''
}

// nestFlow 的逆运算：`{ path: /x, headers: { Host: y } }` → 对象。
// 三种入站格式都把嵌套值归一成了这种 flow 写法，这里是唯一的反向出口。
function parseFlow(s) {
  const t = String(s || '').trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return {}
  const o = {}
  for (const pair of splitTop(t.slice(1, -1))) {
    const i = pair.indexOf(':')
    if (i < 0) continue
    const k = pair.slice(0, i).trim()
    if (!k) continue
    const v = pair.slice(i + 1).trim()
    o[k] = v.startsWith('{') ? parseFlow(v) : unquote(v)
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
  const path = q.path ? decodeURIComponent(q.path) : ''
  if (net === 'ws') {
    kv.network = 'ws'
    kv['ws-opts'] = nestFlow({ path: path || '/', headers: q.host ? { Host: q.host } : '' })
  } else if (net === 'grpc') {
    kv.network = 'grpc'
    const g = nestFlow({ 'grpc-service-name': q.serviceName || q.servicename || '' })
    if (g) kv['grpc-opts'] = g
  } else if (net === 'h2' || net === 'http') {
    kv.network = 'h2'
    // h2-opts.host 是列表，flow 写法里要带方括号
    const h = nestFlow({ path: path || '', host: q.host ? `[${q.host}]` : '' })
    if (h) kv['h2-opts'] = h
  } else if (net !== 'tcp' && net !== 'raw' && net !== 'none' && net !== '') {
    kv.network = net          // xhttp / quic 等，原样带过去，别丢
  }
}

// TLS 相关参数三家共用（vless / trojan / 部分 vmess）
function shareTLS(kv, q, sniKey) {
  const sec = String(q.security || q.tls || '').toLowerCase()
  if (sec && sec !== 'none') kv.tls = 'true'
  if (q.sni || q.peer) kv[sniKey] = q.sni || q.peer
  if (q.fp) kv['client-fingerprint'] = q.fp
  if (q.alpn) kv.alpn = `[${decodeURIComponent(q.alpn).split(',').join(', ')}]`
  if (q.insecure === '1' || q.insecure === 'true' || q.allowInsecure === '1' || q.allowInsecure === 'true')
    kv['skip-cert-verify'] = 'true'
  if (sec === 'reality') {
    const r = nestFlow({ 'public-key': q.pbk || '', 'short-id': q.sid || '' })
    if (r) kv['reality-opts'] = r
  }
}

// ss:// 有两种写法：SIP002 的 base64(method:password)@host:port，
// 以及老客户端的整串 base64(method:password@host:port)
function parseSSBody(body) {
  let s = body
  if (!s.includes('@')) s = b64decode(s)
  const at = s.lastIndexOf('@')
  if (at < 0) return null
  let cred = s.slice(0, at)
  const hostport = s.slice(at + 1).replace(/\/.*$/, '')
  if (!cred.includes(':')) cred = b64decode(cred)
  const ci = cred.indexOf(':')
  if (ci < 0) return null
  const pi = hostport.lastIndexOf(':')
  if (pi < 0) return null
  return {
    cipher: cred.slice(0, ci), password: cred.slice(ci + 1),
    server: bareHost(hostport.slice(0, pi)), port: hostport.slice(pi + 1)
  }
}

// 一行分享链接 → 与 parseProxyLine 同形状的 kv；认不出返回 null
function parseShareLine(line) {
  const raw = String(line).trim()
  const si = raw.indexOf('://')
  if (si < 1) return null
  const scheme = raw.slice(0, si).toLowerCase()
  const kv = {}
  let tag = ''

  if (scheme === 'vmess') {
    // 绝大多数是 base64(JSON)；少数新客户端写成 URL 形式，交给下面的通用分支
    const body = raw.slice(si + 3)
    if (!body.includes('@')) {
      let j = null
      try { j = JSON.parse(b64decode(body.split('#')[0])) } catch (e) { return null }
      if (!j || !j.add || !j.port) return null
      tag = String(j.ps || j.remark || '')
      Object.assign(kv, {
        type: 'vmess', server: bareHost(j.add), port: String(j.port),
        uuid: String(j.id || ''), alterId: String(j.aid === undefined ? 0 : j.aid),
        cipher: String(j.scy || j.security || 'auto'), udp: 'true'
      })
      if (String(j.tls || '') !== '') kv.tls = 'true'
      if (j.sni) kv.servername = j.sni
      if (j.fp) kv['client-fingerprint'] = j.fp
      shareTransport(kv, { type: j.net, path: j.path ? encodeURIComponent(j.path) : '', host: j.host, serviceName: j.path })
      if (!kv.uuid) return null
      kv.name = tag || `${kv.server}:${kv.port}`
      kv._name = kv.name
      return kv
    }
  }

  if (scheme === 'ss') {
    const hi = raw.indexOf('#')
    const body = raw.slice(si + 3, hi < 0 ? undefined : hi).split('?')[0]
    const p = parseSSBody(body)
    if (!p || !p.server || !p.port) return null
    tag = hi < 0 ? '' : safeDecode(raw.slice(hi + 1))
    Object.assign(kv, { type: 'ss', server: p.server, port: p.port, cipher: p.cipher, password: p.password, udp: 'true' })
    kv.name = tag || `${kv.server}:${kv.port}`
    kv._name = kv.name
    return kv
  }

  let u = null
  try { u = new URL(raw) } catch (e) { return null }
  const host = bareHost(u.hostname), port = u.port
  if (!host || !port) return null
  const q = {}
  u.searchParams.forEach((v, k) => { q[k] = v })
  tag = safeDecode(u.hash.slice(1))
  const user = safeDecode(u.username)

  if (scheme === 'vless') {
    if (!user) return null
    Object.assign(kv, { type: 'vless', server: host, port, uuid: user, udp: 'true' })
    if (q.flow) kv.flow = q.flow
    shareTLS(kv, q, 'servername')
    shareTransport(kv, q)
  } else if (scheme === 'vmess') {
    if (!user) return null
    Object.assign(kv, { type: 'vmess', server: host, port, uuid: user, alterId: q.aid || '0', cipher: q.scy || 'auto', udp: 'true' })
    shareTLS(kv, q, 'servername')
    shareTransport(kv, q)
  } else if (scheme === 'trojan') {
    if (!user) return null
    Object.assign(kv, { type: 'trojan', server: host, port, password: user, udp: 'true' })
    shareTLS(kv, q, 'sni')
    shareTransport(kv, q)
  } else if (scheme === 'hysteria2' || scheme === 'hy2') {
    Object.assign(kv, { type: 'hysteria2', server: host, port, password: user || safeDecode(u.password) })
    if (q.sni || q.peer) kv.sni = q.sni || q.peer
    if (q.insecure === '1' || q.insecure === 'true') kv['skip-cert-verify'] = 'true'
    if (q.obfs) { kv.obfs = q.obfs; if (q['obfs-password']) kv['obfs-password'] = q['obfs-password'] }
    if (q.mport) kv.ports = q.mport         // 端口跳跃
  } else if (scheme === 'tuic') {
    Object.assign(kv, { type: 'tuic', server: host, port, uuid: user, password: safeDecode(u.password), udp: 'true' })
    if (q.sni) kv.sni = q.sni
    if (q.congestion_control) kv['congestion-controller'] = q.congestion_control
    if (q.alpn) kv.alpn = `[${decodeURIComponent(q.alpn).split(',').join(', ')}]`
    if (q.allow_insecure === '1' || q.insecure === '1') kv['skip-cert-verify'] = 'true'
  } else if (scheme === 'anytls') {
    Object.assign(kv, { type: 'anytls', server: host, port, password: user, udp: 'true' })
    if (q.sni) kv.sni = q.sni
    if (q.insecure === '1' || q.allowInsecure === '1') kv['skip-cert-verify'] = 'true'
  } else return null

  kv.name = tag || `${host}:${port}`
  kv._name = kv.name
  return kv
}

// 分享链接里的 name 常有非法转义，decodeURIComponent 会整条抛掉
function safeDecode(s) {
  try { return decodeURIComponent(String(s || '')) } catch (e) { return String(s || '') }
}

const indentOf = l => l.length - l.replace(/^[ \t]+/, '').length

// 缩进块 → flow 字符串。块式 YAML 里 ws-opts / reality-opts 是多层缩进，
// 收成 flow 后与单行格式的值形状一致，下游读法就只有一种。
function collectFlow(lines, i, base) {
  const parts = []
  let j = i
  while (j < lines.length) {
    const l = lines[j]
    if (!l.trim()) { j++; continue }
    const ind = indentOf(l)
    if (ind <= base) break
    const t = l.trim()
    const ci = t.indexOf(':')
    if (ci < 0) { j++; continue }
    const k = t.slice(0, ci).trim(), v = t.slice(ci + 1).trim()
    if (v) { parts.push(`${k}: ${v}`); j++ }
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
  const fi = first.indexOf(':')
  if (fi < 0) return { node: null, next: i + 1 }
  const obj = {}
  obj[first.slice(0, fi).trim()] = first.slice(fi + 1).trim()
  let j = i + 1
  while (j < lines.length) {
    const l = lines[j]
    if (!l.trim()) { j++; continue }
    const ind = indentOf(l)
    if (ind <= base) break                       // 同级或更浅 → 本块结束
    const t = l.trim()
    if (t.startsWith('- ')) break                // 下一个节点
    const ci = t.indexOf(':')
    if (ci < 0) { j++; continue }
    const k = t.slice(0, ci).trim(), v = t.slice(ci + 1).trim()
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
function takeNode(p, nodes, notes) {
  if (/^(select|url-test|fallback|load-balance|relay)$/.test(unquote(p.type || ''))) return   // proxy-group
  // 公告条目不是节点，但流量/到期常藏在里面，先留作兜底解析
  if (JUNK.test(p._name) || unquote(p.server || '') === '127.0.0.1') { notes.push(p._name); return }
  nodes.push(p)
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
  let inProxies = false, seenYamlKey = false
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
      if (/^(rules|rule-providers|proxy-providers|sub-rules|listeners)\s*:/.test(line)) break
      inProxies = /^proxies\s*:/.test(line)
      i++
      continue
    }
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
async function fetchRaw(url, ua) {
  const headers = { 'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
  if (ua) headers['User-Agent'] = ua
  const opt = { headers, redirect: 'follow', cf: { cacheTtl: 0 } }
  // 机场超时不能拖死整个请求：Workers 免费版壁钟也有限
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(15000)
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
  for (const ua of UPSTREAM_UAS) {
    let r = null
    try { r = await fetchRaw(u.url, ua) }
    catch (e) { tries.push({ ua, err: String(e && e.message || e) }); continue }
    if (!r.ok) { tries.push({ ua, status: r.status, body: await errBody(r) }); continue }
    const raw = await r.text()
    const got = feedParse(raw, r.headers.get('subscription-userinfo'), u)
    tries.push({ ua, status: r.status, n: got.nodes.length })
    if (got.nodes.length) return { ...got, tries }
  }
  throw new Error(triesMsg(tries))
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

  const nodes = [], errors = [], meta = {}, snaps = {}
  const useSnap = async (u, why) => {
    const s = await kvGet('snap:' + u.id, null)
    if (!s || !s.nodes || !s.nodes.length) return false
    // 快照里的 region 是抓取当时算的。地区表更新后必须重算，
    // 否则老快照会把节点永远钉死在旧分类上（改了识别规则也不生效）。
    nodes.push(...s.nodes.map(n => ({ ...n, region: regionOf(n.raw) })))
    if (s.info) meta[u.id] = s.info
    snaps[u.id] = s.at
    if (why) errors.push({ up: u.name, msg: why + ' — 已沿用快照' })
    return true
  }

  for (const u of ups) {
    // 一次性链接反复拉必然失败，平时根本不该去请求它
    if (u.auto === false) {
      if (await useSnap(u, '')) continue
      // 还没有快照就仍拉一次，否则这个源永远是空的
    }
    try {
      const r = await fetchUpstream(u)
      if (!r.nodes.length) { errors.push({ up: u.name, msg: '解析结果为空' }); continue }
      nodes.push(...r.nodes)
      if (r.info) meta[u.id] = r.info
      await saveSnap(u.id, r, event)
    } catch (e) {
      if (!await useSnap(u, String(e.message || e))) errors.push({ up: u.name, msg: String(e.message || e) })
    }
  }

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
  const seq = {}
  const label = upLabels(nodes)
  return nodes.map(n => {
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
    'Subscription-Userinfo': 'upload=0; download=0; total=1073741824000; expire=0',
    // 客户端拿这个头当配置名显示。不给的话它只能从 URL 路径猜，
    // 于是每一份订阅在客户端里都叫「sub」，多开几份根本分不出谁是谁。
    'Content-Disposition': contentDisposition(prof.name)
  }

  const [rawOwn, rawPol, lib, set, chains] = await Promise.all([loadOwn(), loadPolicies(), loadLib(), loadSettings(), loadChains()])
  const f = applyProfile(prof, rawOwn, up, rawPol.filter(p => p.enabled !== false))

  // 链式节点是 Clash / sing-box 专有能力，分享链接格式里没有对应表达，
  // 只能整条略过 —— 硬塞一个落地节点进去会变成不带中转的直连，出口 IP 全变。
  if (fmt === 'share') return new Response(genShare(f.up, f.own, set), { headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8' } })
  // URL 上的 mode 优先，其次用档案自己的设定
  const mode = url.searchParams.get('mode') || prof.mode || 'whitelist'
  if (fmt === 'singbox') return new Response(genSB(f.up, f.policies, lib, f.own, set, chains, up), { headers: { ...h, 'Content-Type': 'application/json; charset=utf-8' } })
  return new Response(genClash(mode === 'blacklist', f.up, f.policies, lib, f.own, set, chains, up), { headers: { ...h, 'Content-Type': 'text/yaml; charset=utf-8' } })
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

  // 改密码。以前只有首次初始化那一次机会，之后想换只能去 KV 里删 auth:password，
  // 而那会让管理端在重设之前一直处于无密码状态 —— 公网上开着的后台，不该这么干。
  if (p === '/api/password' && req.method === 'POST') {
    const { oldPassword, newPassword } = await req.json().catch(() => ({}))
    const stored = await kvGet('auth:password', null)
    if (!stored) return json({ ok: false, msg: '尚未设置过密码' }, 400)
    // 登录态不能替代当前密码：cookie 被借走时，改密码等于把号让出去
    if (await sha256(String(oldPassword || '')) !== stored) return json({ ok: false, msg: '当前密码不正确' }, 401)
    const np = String(newPassword || '')
    if (np.length < 8) return json({ ok: false, msg: '新密码至少 8 位' }, 400)
    if (np === String(oldPassword)) return json({ ok: false, msg: '新密码与当前密码相同' }, 400)
    await kvPut('auth:password', await sha256(np))
    // 换了密码，别处已经登上的会话就该作废，否则改了等于没改。
    // 轮换签名密钥即可让所有旧 cookie 失效；当前这台重新签一张，
    // 免得刚改完就把正在操作的人自己踢下线。
    await kvPut('auth:secret', randHex(32))
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `sess=${await makeCookie()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
      }
    })
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
        nodes: byRegion[r.key].map(n => ({ key: n.key, name: n.name, auto: n.auto, raw: n.raw, upName: n.upName, custom: n.custom, off: n.off }))
      })),
      subUrl: `https://${url.hostname}/sub?token=${((await loadProfiles()).find(x => x.enabled !== false) || { token: '' }).token}`
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

// 自有节点若填域名，拨号改走 settings.directIPs[0]。
// Clash TUN 解析节点域名会脏（假 IP / 过期 A 记录），两个节点共用一个域名就会一起 timeout。
// ponytail: 自有节点都在同一台机；多机再给节点加独立 ip 字段。
function ownHost(n, st) {
  if (looksIP(n.s)) return n.s
  const ip = ((st && st.directIPs) || [])[0]
  return ip || n.s
}

// DoH 地址里有冒号和斜杠，写进 YAML 流式列表要带引号；纯 IP 不用
function dnsQ(x) {
  const v = String(x).trim()
  return /^[\d.]+$/.test(v) ? v : JSON.stringify(v)
}
const dnsFlow = arr => (arr || []).map(dnsQ).join(', ')
const sbDnsTag = g => g === 'domestic' ? 'dns-direct' : g === 'bootstrap' ? 'dns-resolver' : 'dns-remote'
const dnsList = arr => (arr || []).map(x => `    - ${dnsQ(x)}`)

function genClash(blacklist, up, policies, lib, own, st, chains, pool) {
  const SET = { ...DEFAULT_SETTINGS, ...(st || {}) }
  const D = { ...DEFAULT_DNS, ...(SET.dns || {}) }
  const FORCED = SET.proxyDomains || []
  const ownN = Object.values(own).map(n => n.name)
  const upN = up.map(n => n.name)
  const liveR = REGIONS.filter(r => up.some(n => n.region === r.key))
  const liveKeys = liveR.map(r => r.key)
  const ch = resolveChains(chains, pool || up, own, liveKeys)
  const allN = [...ownN, ...upN, ...ch.map(c => c.name)]
  const regionNames = liveR.map(r => `${r.flag} ${r.cn}`)
  const act = (policies || []).filter(p => p.enabled !== false)

  let pl = ''
  Object.values(own).forEach(n => {
    if (n.type === 'vless') {
      pl += [
        `  - name: "${n.name}"`,
        `    type: vless`,
        `    server: ${ownHost(n, SET)}`,
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
        `    server: ${ownHost(n, SET)}`,
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

  // 链式节点：把落地节点整份复制一遍，加 dialer-proxy 指向中转。
  // 必须是副本而不是改原节点 —— 原节点还要照常出现在地区组里直连用。
  ch.forEach(c => {
    const lines = [`  - name: "${c.name}"`]
    for (const k of Object.keys(c.land.kv)) {
      if (k === 'name' || k === 'dialer-proxy' || k.startsWith('_')) continue
      lines.push(`    ${k}: ${c.land.kv[k]}`)
    }
    lines.push(`    dialer-proxy: "${c.via}"`)
    pl += lines.join('\n') + '\n\n'
  })

  // 策略组 —— 每条启用的策略一个 select 组
  const polGroups = act.map(p => {
    const t = resolveTargets(p, liveKeys, own, ch)
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
    ...(SET.domain ? [`    - "+.${SET.domain}"`] : []),
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
      ...(SET.domain ? [`    - "+.${SET.domain}"`] : []),
      ...(D.extraFilter || []).map(f => `    - "${f}"`)
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
    ...(SET.domain ? [
      `    "+.${SET.domain}": [${dnsFlow(D[D.selfGroup] || D.remote)}]`,
      `    "${SET.domain}": [${dnsFlow(D[D.selfGroup] || D.remote)}]`
    ] : []),
    ...(D.policies || []).filter(p => p && p.domain && D[p.group])
      .map(p => `    "${p.domain}": [${dnsFlow(D[p.group])}]`),
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
    // 强制代理必须排在所有直连规则之前，否则永远轮不到它。
    // 同名的直连规则一并去掉：留着也永远匹配不到，只会让人以为它还在生效。
    ...FORCED.map(d => `  - DOMAIN-SUFFIX,${d},🚀 节点选择`),
    ...(SET.domain && !FORCED.includes(SET.domain) ? [`  - DOMAIN-SUFFIX,${SET.domain},DIRECT`] : []),
    ...SET.directDomains.filter(d => !FORCED.includes(d)).map(d => `  - DOMAIN-SUFFIX,${d},DIRECT`),
    polRules,
    tail.join('\n')
  ].filter(x => x !== '').join('\n')
}

// Clash 的 network + *-opts → sing-box transport。tcp 返回 null，走 sing-box 默认。
function sbTransport(net, v) {
  if (net === 'ws') {
    const w = parseFlow(v('ws-opts'))
    const t = { type: 'ws', path: w.path || '/' }
    if (w.headers && w.headers.Host) t.headers = { Host: w.headers.Host }
    return t
  }
  if (net === 'grpc') return { type: 'grpc', service_name: parseFlow(v('grpc-opts'))['grpc-service-name'] || '' }
  if (net === 'h2') {
    const h = parseFlow(v('h2-opts'))
    const t = { type: 'http' }
    if (h.path) t.path = h.path
    if (h.host) t.host = String(h.host).replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean)
    return t
  }
  return null
}

// Clash 节点 → sing-box outbound。认不出的协议返回 null，
// 调用方必须连带把这个节点从所有分组里剔掉（见 genSB 开头）。
function toSB(n) {
  const v = k => n.kv[k] === undefined ? undefined : unquote(n.kv[k])
  const t = v('type')
  const base = { tag: n.name, server: v('server'), server_port: parseInt(v('port'), 10) }

  // sni 与 servername 两个字段名都要认：Clash 里 trojan/hysteria2 写 sni，
  // vless 写 servername，机场给哪个取决于它用的是哪个生成器
  const sni = v('sni') || v('servername')
  const ro = parseFlow(v('reality-opts'))
  const tls = { enabled: true, insecure: v('skip-cert-verify') === 'true' }
  if (sni) tls.server_name = sni
  if (v('client-fingerprint')) tls.utls = { enabled: true, fingerprint: v('client-fingerprint') }
  if (ro['public-key']) tls.reality = { enabled: true, public_key: ro['public-key'], short_id: ro['short-id'] || '' }
  const tr = sbTransport(v('network'), v)

  if (t === 'anytls') return { type: 'anytls', ...base, password: v('password'), tls }
  if (t === 'hysteria2') {
    const o = { type: 'hysteria2', ...base, password: v('password'), tls }
    if (v('obfs')) o.obfs = { type: v('obfs'), password: v('obfs-password') || '' }
    return o
  }
  if (t === 'trojan') {
    const o = { type: 'trojan', ...base, password: v('password'), tls }
    if (tr) o.transport = tr
    return o
  }
  if (t === 'vmess') {
    // TLS 与 transport 以前都没带过。机场的 vmess 十有八九是 ws+tls，
    // 缺了这两样 outbound 生成得出来却连不上，比直接丢掉更难排查。
    const o = { type: 'vmess', ...base, uuid: v('uuid'), security: v('cipher') || 'auto', alter_id: parseInt(v('alterId') || '0', 10) }
    if (v('tls') === 'true') o.tls = tls
    if (tr) o.transport = tr
    return o
  }
  if (t === 'vless') {
    const o = { type: 'vless', ...base, uuid: v('uuid'), packet_encoding: 'xudp' }
    if (v('flow')) o.flow = v('flow')
    if (v('tls') === 'true' || tls.reality || sni) o.tls = tls
    if (tr) o.transport = tr
    return o
  }
  if (t === 'ss') return { type: 'shadowsocks', ...base, method: v('cipher'), password: v('password') }
  return null
}

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
  const ownN = Object.values(own).map(n => n.name)
  const liveR = REGIONS.filter(r => up.some(n => n.region === r.key))
  const liveKeys = liveR.map(r => r.key)
  // 链式 outbound：复制落地节点的 outbound，改 tag，加 detour 指向中转。
  // 落地本身转不出 outbound（协议不认识）时整条链跳过，绝不留悬空引用。
  const chOut = []
  for (const c of resolveChains(chains, pool || up, own, liveKeys)) {
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
    ...Object.values(own).map(n => {
      if (n.type === 'vless') {
        if (n.net === 'tcp') {
          return { type: 'vless', tag: n.name, server: ownHost(n, SET), server_port: n.p, uuid: n.u, flow: n.flow, packet_encoding: 'xudp', tls: { enabled: true, server_name: n.sni, utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: n.pk, short_id: n.sid } }, transport: { type: 'tcp' } }
        }
        return { type: 'vless', tag: n.name, server: ownHost(n, SET), server_port: n.p, uuid: n.u, flow: '', packet_encoding: 'xudp', tls: { enabled: true, server_name: n.sni, utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: n.pk, short_id: n.sid } }, transport: { type: 'xhttp', path: '/', mode: 'auto' } }
      }
      return { type: 'hysteria2', tag: n.name, server: ownHost(n, SET), server_port: n.p, password: n.u, obfs: { type: n.obfs, password: n.opwd }, tls: { enabled: true, server_name: n.sni, insecure: true } }
    }),
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
    const t = resolveTargets(p, liveKeys, own, ch)
    outbounds.push({
      type: 'selector', tag: p.name,
      outbounds: policyMembers(p, t, allN, regionNames).map(mapTag)
    })
  })

  const forced = SET.proxyDomains || []
  const direct = [...(SET.domain ? [SET.domain] : []), ...SET.directDomains].filter(d => !forced.includes(d))
  const rules = []
  // 与 Clash 那边一致：强制代理排在所有直连规则之前
  if (forced.length) rules.push({ domain_suffix: forced, outbound: '🚀 节点选择' })
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
    // 与 Clash 共用同一份 DNS 设置，字段名在这里做映射：
    // remote→dns-remote、domestic→dns-direct、bootstrap→dns-resolver
    dns: {
      servers: [
        { tag: 'dns-remote', address: D.remote[0], address_resolver: 'dns-resolver', strategy: 'prefer_ipv4', detour: aiPrimary(own) },
        { tag: 'dns-direct', address: D.domestic[0], address_resolver: 'dns-resolver', strategy: 'prefer_ipv4', detour: 'direct-out' },
        { tag: 'dns-resolver', address: D.bootstrap[0], detour: 'direct-out' },
        { tag: 'dns-fake', address: 'fakeip' }
      ],
      rules: [
        { outbound: 'any', server: 'dns-resolver' },
        // 本站域名以前写死走 dns-resolver（国内明文），和 Clash 那边是同一个坑
        ...(SET.domain ? [{ domain_suffix: [SET.domain], server: sbDnsTag(D.selfGroup) }] : []),
        ...(D.policies || []).filter(p => p && p.domain && D[p.group]).map(p => ({
          domain_suffix: [String(p.domain).replace(/^\+\./, '').replace(/^\*\./, '')],
          server: sbDnsTag(p.group)
        })),
        { query_type: ['A','AAAA'], server: 'dns-fake' }
      ],
      final: 'dns-remote',
      independent_cache: true,
      ...(D.fakeIp === false ? {} : { fakeip: { enabled: true, inet4_range: '198.18.0.0/15' } })
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
  // 上游节点：这里是 parseShareLine 的逆运算，两边字段映射必须对得上，
  // 否则「订阅进来能用、导出去连不上」。
  const v = k => n.kv[k] === undefined ? undefined : unquote(n.kv[k])
  const t = v('type'), host = v('server'), port = v('port'), pwd = v('password')
  const sni = v('sni') || v('servername')
  const net = v('network') || 'tcp'
  const ws = parseFlow(v('ws-opts')), ro = parseFlow(v('reality-opts'))
  const wsHost = ws.headers && ws.headers.Host

  const qs = new URLSearchParams()
  if (sni) qs.set('sni', sni)
  if (v('skip-cert-verify') === 'true') { qs.set('insecure', '1'); qs.set('allowInsecure', '1') }
  // 传输层参数不带上，ws / grpc 节点导进客户端照样连不上
  const addTransport = () => {
    if (net !== 'tcp') qs.set('type', net)
    if (net === 'ws') {
      if (ws.path) qs.set('path', ws.path)
      if (wsHost) qs.set('host', wsHost)
    } else if (net === 'grpc') {
      const g = parseFlow(v('grpc-opts'))['grpc-service-name']
      if (g) qs.set('serviceName', g)
    }
  }

  if (t === 'anytls')    return `anytls://${encodeURIComponent(pwd)}@${hostPart(host)}:${port}?${qs}#${tag}`
  if (t === 'trojan')    { addTransport(); return `trojan://${encodeURIComponent(pwd)}@${hostPart(host)}:${port}?${qs}#${tag}` }
  if (t === 'ss')        return `ss://${b64utf8(v('cipher') + ':' + pwd)}@${hostPart(host)}:${port}#${tag}`
  if (t === 'hysteria2') {
    if (v('obfs')) { qs.set('obfs', v('obfs')); if (v('obfs-password')) qs.set('obfs-password', v('obfs-password')) }
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
    return 'vmess://' + b64utf8(JSON.stringify({
      v: '2', ps: n.name, add: host, port: String(port), id: v('uuid'),
      aid: v('alterId') || '0', scy: v('cipher') || 'auto',
      net, type: 'none', host: wsHost || '', path: ws.path || '',
      tls: v('tls') === 'true' ? 'tls' : '', sni: sni || ''
    }))
  }
  return null
}

function genShare(up, ownCfg, st) {
  const SET = { ...DEFAULT_SETTINGS, ...(st || {}) }
  const own = Object.values(ownCfg || {}).map(o => ({ name: o.name, own: true, o: { ...o, s: ownHost(o, SET) } }))
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
.selp{position:absolute;top:calc(100% + 5px);left:0;right:0;background:var(--card);border:1px solid var(--bd);border-radius:11px;box-shadow:var(--shP);padding:5px;z-index:30;max-height:250px;overflow:auto;animation:popIn .18s var(--e) both}
/* 打开时挪到 body 上，脱离弹窗的滚动裁剪区；位置由 JS 按触发器算 */
.selp.portal{position:fixed;top:auto;left:auto;right:auto;z-index:120}
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
.pol.drag,.up.drag{background:var(--accBg);border:1.5px dashed var(--accBd);box-shadow:none}
.pol.drag > *,.up.drag > *{opacity:0}
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
.uplist.src{grid-template-columns:auto auto auto minmax(0,1fr) auto auto auto auto auto auto}
.uplist.chain{grid-template-columns:auto auto minmax(0,1fr) auto auto auto auto}
.up.chain .hop{background:var(--bg);border:1px solid var(--bd2);border-radius:6px;padding:1.5px 7px;font-size:12px}
.up.chain .hop.gone{color:var(--warn);border-color:var(--warnBd);border-style:dashed}
.up.chain .arw{color:var(--tx3);margin:0 7px}
.uplist.lib{grid-template-columns:auto minmax(0,1fr) auto auto}
.up{grid-column:1/-1;display:grid;grid-template-columns:subgrid;align-items:center;gap:11px;padding:10px 12px;border:1px solid var(--bd2);border-radius:10px;transition:border-color .16s var(--e),background .16s var(--e)}
.up:hover{border-color:var(--bd);background:var(--hov)}
.up .nm{font-weight:500;font-size:13.5px;white-space:nowrap}
.up .u{color:var(--tx3);font:11.5px ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.up.src .tgt{font-variant-numeric:tabular-nums;white-space:nowrap;justify-self:end}
.up.src .tgt.hot{background:var(--warnBg);border-color:var(--warnBd);color:var(--warn)}
/* 「手动」是状态说明不是强调，用中性色，跟 accent 色的「自定义」标签区分开 */
.tag.manual{background:var(--bg);color:var(--tx2);border-color:var(--bd2)}
.up.src .snap{margin-left:9px;color:var(--tx3);font-size:11.5px}
/* 用量拿不到时的占位，点进去看抓取诊断 */
.up.src .tgt.mute{color:var(--tx3);border-style:dashed;cursor:pointer;transition:color .15s,border-color .15s}
.up.src .tgt.mute:hover{color:var(--acc);border-color:var(--accBd)}
/* 局部刷新期间给节点卡片一点反馈，但不换骨架屏——那会整块闪 */
#nodecard.busy{opacity:.55;transition:opacity .2s;pointer-events:none}
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
<g id="i-lock" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></g>
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
  try { return JSON.parse(raw) }
  catch (e) {
    if (r.status === 401 || r.status === 403) return { ok:false, msg:'登录已失效，请刷新页面重新登录' }
    const hint = r.status === 500 && /exceeded|limit|1102/i.test(raw) ? '服务端超出资源限制' : '服务端返回了非 JSON 响应'
    return { ok:false, msg:\`\${hint}（HTTP \${r.status}）\` }
  }
}
const icon = (n, cls = '') => \`<svg class="ic \${cls}" viewBox="0 0 24 24" stroke-width="2"><use href="#i-\${n}"/></svg>\`
let TAB = 'node', ST = null, POL = null, OWN = null, PRF = null, PF = '', SET = null, CH = null

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

function modal({title, desc, html = '', fields = [], ok = '确定', danger = false, wide = false, noCancel = false, onMount}){
  return new Promise(resolve => {
    const bd = document.createElement('div')
    bd.className = 'bd'
    bd.innerHTML = \`<div class="md \${wide?'lg':''}" role="dialog" aria-modal="true">
      <div class="hd"><h3>\${esc(title)}</h3>\${desc ? \`<p>\${esc(desc)}</p>\` : ''}</div>
      <div class="ct">
        \${html ? \`<div class="bdy">\${html}</div>\` : ''}
        \${fields.length ? \`<div class="bdy">\${fields.map((f,i)=>\`<input data-i="\${i}" placeholder="\${esc(f.ph||'')}" value="\${esc(f.val||'')}">\`).join('')}</div>\` : ''}
      </div>
      <div class="ft">\${noCancel?'':'<button class="g" data-x>取消</button>'}
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
      // 展开中的下拉面板此刻挂在 body 上，bd.remove() 带不走它，会留在页面上
      closeAllSel()
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
    sel._pop = pop
    btn.onclick = e => {
      e.stopPropagation()
      const open = sel.classList.contains('open')
      closeAllSel()
      if (!open) openSel(sel, btn, pop)
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
// 下拉面板打开时挪到 body 上、改用 fixed 定位。
// 弹窗内容区是 overflow:auto 的滚动容器，absolute 面板一旦超出边界就被裁掉，
// 底部按钮区还会盖在它上面 —— 光调 z-index 救不回被裁的那半，必须脱离容器。
function openSel(sel, btn, pop){
  if (!pop._home) pop._home = { p: pop.parentNode, n: pop.nextSibling }
  document.body.appendChild(pop)
  pop.classList.add('portal')
  pop.hidden = false
  sel.classList.add('open')
  placeSel(btn, pop)
}
function placeSel(btn, pop){
  const r = btn.getBoundingClientRect(), gap = 5, pad = 10
  pop.style.width = r.width + 'px'
  pop.style.left = r.left + 'px'
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
    const pop = s._pop
    if (!pop) return
    pop.hidden = true
    pop.classList.remove('portal')
    pop.style.cssText = ''
    // 放回原位，否则下次重绘这块 DOM 时面板会被落在 body 上
    if (pop._home) pop._home.p.insertBefore(pop, pop._home.n)
  })
}
document.addEventListener('click', closeAllSel)
// 页面或弹窗滚动后按钮就挪位了，面板得跟上；跟不上就收起，别浮在半空
addEventListener('scroll', () => {
  document.querySelectorAll('.sel.open').forEach(s => {
    const btn = s.querySelector('.selb'), pop = s._pop
    if (!btn || !pop) return
    const r = btn.getBoundingClientRect()
    if (r.bottom < 0 || r.top > innerHeight) return closeAllSel()
    placeSel(btn, pop)
  })
}, true)
addEventListener('resize', closeAllSel)

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
  closeAllSel()      // 面板挂在 body 上，重建页面带不走它
  if (!skip) skeleton()
  // 每个 tab 只拉自己要的，且并行发出——串行等两个请求是之前切 tab 卡顿的主因之一
  const jobs = []
  if (!ST) jobs.push(api('/api/state').then(r => { ST = r }))
  if (TAB === 'node' && !OWN) jobs.push(api('/api/own').then(r => { OWN = r }))
  if (TAB === 'node' && !SET) jobs.push(api('/api/settings').then(r => { SET = r }))
  if (TAB === 'node' && !CH) jobs.push(api('/api/chains').then(r => { CH = r }))
  if (TAB === 'sub' && !PRF) jobs.push(api('/api/profiles').then(r => { PRF = r }))
  if ((TAB === 'pol' || TAB === 'lib') && !POL) jobs.push(api('/api/policies?pf=' + encodeURIComponent(PF)).then(r => { POL = r }))
  if (jobs.length) await Promise.all(jobs)
  if (!ST || !ST.ok) { app.innerHTML = \`<div class="alert">\${icon('warn','s')}\${esc((ST&&ST.msg)||'加载失败')}</div>\`; return }

  paintHeader()
  document.getElementById('body').innerHTML =
    TAB === 'node' ? viewNode() : TAB === 'sub' ? viewSub() : TAB === 'pol' ? viewPol() : viewLib()
  if (TAB === 'node') bindDrag('.uplist.src', '.up', persistUpOrder)
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
      <button class="g sm" onclick="changePwd()">\${icon('lock','s')}修改密码</button>
      <button class="g sm" onclick="editSettings()">\${icon('edit','s')}编辑</button></div>
    <div class="uplist" style="grid-template-columns:auto minmax(0,1fr)">
      <div class="up"><span class="nm">本站域名</span>
        <span class="u">\${st.domain ? esc(st.domain) : '<span style="color:var(--warn)">未设置 — 影响 DNS 策略与自身直连规则</span>'}</span></div>
      <div class="up"><span class="nm">直连域名</span>
        <span class="u">\${st.directDomains.length ? esc(st.directDomains.join('、')) : '（无）'}</span></div>
      <div class="up"><span class="nm">直连 IP</span>
        <span class="u">\${st.directIPs.length ? esc(st.directIPs.join('、')) : '（无）'}</span></div>
      <div class="up"><span class="nm">强制代理</span>
        <span class="u">\${(st.proxyDomains||[]).length ? esc(st.proxyDomains.join('、')) : '（无）'}</span></div>
    </div>
  </div>
  <div class="card anim" style="animation-delay:.03s">
    <div class="ttl">DNS<span class="sp"></span>
      <button class="g sm" onclick="editDns()">\${icon('edit','s')}编辑</button></div>
    <div class="hint" style="margin:-6px 0 13px">决定各类域名分别用哪个 DNS 解析。
      解析错了会直连到错误的地址 —— 表现是证书报错、跳到不相干的网站，而手机不挂代理反而正常。</div>
    \${dnsCardInner()}
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
  h += ST.upstreams.length > 1
    ? '<div class="hint" style="margin:-6px 0 13px">拖动左侧手柄调整顺序 —— 靠上的机场，节点排在订阅前面。</div>' : ''
  h += '<div class="uplist src">'
  h += ST.upstreams.map(upRow).join('') || '<div class="empty">还没有订阅源</div>'
  h += '</div></div>'
  h += \`<div class="card anim" style="animation-delay:.08s" id="chaincard">\${chainCardInner()}</div>\`
  h += \`<div class="card anim" style="animation-delay:.10s" id="nodecard">\${nodeCardInner()}</div>\`
  return h + '<div class="foot anim" style="animation-delay:.14s">节点每小时自动刷新，上游故障时沿用缓存</div>'
}

function dnsCardInner(){
  const st = (SET && SET.settings) || {}
  const d = st.dns || {}
  const groups = (SET && SET.dnsGroups) || []
  const gl = k => (groups.find(g => g.k === k) || {}).label || k
  const row = (k, v) => \`<div class="up"><span class="nm">\${esc(k)}</span><span class="u">\${v}</span></div>\`
  let h = '<div class="uplist" style="grid-template-columns:auto minmax(0,1fr)">'
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

// 链式代理：先连中转、再从中转连落地，出口 IP 是落地的。
// 单独一块，增删链后只重绘这里。
function chainCardInner(){
  const cs = (CH && CH.chains) || []
  let h = \`<div class="ttl">链式代理<span class="sp"></span>
    <button class="sm" onclick="editChain(null)">\${icon('plus','s')}新建</button></div>
    <div class="hint" style="margin:-6px 0 13px">先连中转、再从中转连落地，出口 IP 是<b>落地</b>的。
      典型用法：自建节点做中转（入口线路好），机场家宽节点做落地（住宅 IP，风控友好）。
      仅 Clash 与 sing-box 支持，base64 分享链接格式里没有对应写法。</div>\`
  if (!CH) return h + '<div class="empty">加载中…</div>'
  h += '<div class="uplist chain">'
  h += cs.map(c => \`<div class="up chain \${c.enabled===false?'off':''}" data-id="\${c.id}">
      <span class="dot"></span>
      <span class="nm">\${esc(c.name)}</span>
      <span class="u"><span class="hop">\${esc(c.viaName||'?')}</span><span class="arw">→</span><span class="hop \${c.landGone?'gone':''}">\${c.landGone?'落地节点已不存在':esc(c.landName)}</span></span>
      \${c.warn ? \`<span class="tgt hot" data-tip="\${esc(c.warn)}">协议存疑</span>\` : '<span></span>'}
      <button class="sw" data-on="\${c.enabled===false?0:1}" data-tip="\${c.enabled===false?'启用':'停用'}" onclick="chainAct('toggle','\${c.id}')"><i></i></button>
      <button class="ib" data-tip="编辑" onclick="editChain('\${c.id}')">\${icon('edit')}</button>
      <button class="ib dl" data-tip="删除" onclick="delChain('\${c.id}','\${esc(c.name)}')">\${icon('trash')}</button>
    </div>\`).join('') || '<div class="empty">还没有链式代理</div>'
  return h + '</div>'
}

// 单独一份，增删订阅源后只重绘这一块，不必整页重建
function nodeCardInner(){
  let h = \`<div class="ttl">节点<span class="sp"></span>
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
      <span class="raw">\${n.custom ? esc(n.upName) + ' · ' : ''}\${esc(n.raw)}</span>
      <span class="act" onclick="event.stopPropagation()"><button class="ib" data-tip="重命名" onclick="rename(this)">\${icon('edit')}</button>
      <button class="sw" data-on="\${n.off?0:1}" data-tip="\${n.off?'启用':'停用'}" onclick="toggle('\${esc(n.key)}',\${!n.off},this)"><i></i></button></span>
    </div>\`).join('')
    h += '</div></div></div>'
  }
  if (!ST.regions.length) h += '<div class="empty">暂无节点，先添加订阅源</div>'
  return h
}

function upRow(u, i){
  const snapAt = (ST.snaps || {})[u.id]
  return \`<div class="up src \${u.enabled===false?'off':''}" data-id="\${u.id}" data-i="\${i||0}" draggable="false">
      <span class="grip" data-tip="拖动调整顺序">\${icon('grip','s')}</span>
      <span class="dot"></span>
      <span class="nm">\${esc(u.name)}\${u.auto===false?'<span class="tag manual" data-tip="不参与自动刷新，固定使用快照">手动</span>':''}</span>
      <span class="u">\${u.url ? esc(u.url) : '<span class="mute">粘贴导入 · 无链接</span>'}\${snapAt?\`<span class="snap">快照 \${ago(snapAt)}</span>\`:''}</span>
      \${upMeta((ST.meta || {})[u.id], u.id)}
      <button class="sw" data-on="\${u.enabled===false?0:1}" data-tip="\${u.enabled===false?'启用':'停用'}" onclick="upAct('toggle','\${u.id}',this)"><i></i></button>
      <button class="ib" data-tip="编辑" onclick="editUp('\${u.id}')">\${icon('edit')}</button>
      <button class="ib dl" data-tip="删除" onclick="delUp('\${u.id}','\${esc(u.name)}')">\${icon('trash')}</button>
    </div>\`
}
function ago(ts){
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
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
function upMeta(m, id){
  const blank = '<span></span>'
  // 拿不到就直说，并给一个查抓取详情的入口。
  // 以前这里是三个空 span，一片空白，分不清是机场没给还是我们没解析出来。
  if (!m) return blank + blank +
    \`<span class="tgt mute" data-tip="点击查看抓取详情" onclick="probeUp('\${id||''}')">用量未知</span>\`
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

  list.querySelectorAll(itemSel).forEach(row => {
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
  if (card) card.innerHTML = nodeCardInner()
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
      <textarea id="stdd" placeholder="api.example.com">\${esc(st.directDomains.join('\\n'))}</textarea>
      <div class="hint">按域名后缀匹配，子域名自动包含 —— 填 <code>example.com</code> 就等于覆盖了
        <code>a.example.com</code>，不用写 <code>*.</code>。粘完整网址也行，会自动剥成域名。</div></div>
    <div class="fg"><label class="lb">额外直连 IP（每行一个）</label>
      <textarea id="stip" placeholder="203.0.113.10" style="min-height:70px">\${esc(st.directIPs.join('\\n'))}</textarea>
      <div class="hint">自建节点所在服务器的 IP 建议填这里：程序按 IP 直连时匹配不到域名规则，会被兜底送进代理绕一圈。</div></div>
    <div class="fg"><label class="lb">强制走代理的域名（每行一个）</label>
      <textarea id="stpx" placeholder="relay.example.com" style="min-height:70px">\${esc((st.proxyDomains||[]).join('\\n'))}</textarea>
      <div class="hint">规则生成在<b>所有直连规则之前</b>，是唯一能从「整个域名直连」里把个别子域名拎出来的位置。
        用途：某个子域名在直连时被劫持（证书报错、跳到不相干的网站），而同域名下别的服务又必须直连。</div></div>\`
  const box = await modal({ title:'站点设置', html, ok:'保存', wide:true })
  if (!box) return
  const lines = el => box.querySelector(el).value.split('\\n').map(x => x.trim()).filter(Boolean)
  const r = await api('/api/settings', {
    domain: box.querySelector('#stdm').value.trim(),
    directDomains: lines('#stdd'), directIPs: lines('#stip'), proxyDomains: lines('#stpx')
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
window.editDns = async () => {
  const st = (SET && SET.settings) || {}
  const d = { ...(st.dns || {}) }
  const groups = (SET && SET.dnsGroups) || []
  if (!groups.length) return toast('DNS 配置未加载', true)
  const ta = (id, arr, ph) => \`<textarea id="\${id}" placeholder="\${ph}" style="min-height:66px">\${esc((arr||[]).join('\\n'))}</textarea>\`
  const polRow = (p, i) => \`<div class="row" data-pi="\${i}" style="gap:8px;margin-bottom:6px">
    <input class="pdm" value="\${esc(p.domain)}" placeholder="+.example.com" style="flex:1">
    \${selectHTML('pg' + i, groups.map(g => ({ v:g.k, label:g.label })), p.group)}
    <button class="ib dl" data-tip="删除" onclick="this.closest('[data-pi]').remove()">\${icon('trash')}</button></div>\`
  const html = \`
    \${groups.map(g => \`<div class="fg"><label class="lb">\${g.label}（每行一个）</label>
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
      <div class="row"><button class="sw" id="dviap" data-on="\${d.remoteViaProxy === false ? 0 : 1}"><i></i></button>
        <span class="hint" style="margin:0">强烈建议开启。境内直连连不上 Cloudflare / Google 的 DoH，
          连不上就会回落到国内明文 DNS —— 表现是 DNS 泄露检测里冒出运营商的 DNS 出口。
          不会循环依赖：节点地址由「国内 DNS」解析，代理先起得来。</span></div></div>
    <div class="fg"><label class="lb">解析模式</label>
      <div class="row"><button class="sw" id="dfake" data-on="\${d.fakeIp === false ? 0 : 1}"><i></i></button>
        <span class="hint" style="margin:0">开启 fake-ip（推荐）。关掉则用 redir-host 返回真实 IP，兼容性好但会慢一些。</span></div>
      <div class="row" style="margin-top:8px"><button class="sw" id="dv6" data-on="\${d.ipv6 === false ? 0 : 1}"><i></i></button>
        <span class="hint" style="margin:0">解析 IPv6（AAAA）记录。</span></div></div>
    <div class="fg"><label class="lb">额外不走 fake-ip 的域名（每行一个）</label>
      \${ta('dfilter', d.extraFilter, 'example.com')}
      <div class="hint">某些应用要拿到真实 IP 才能工作（如部分游戏、内网服务）。本站域名已自动在列。</div></div>\`
  const box = await modal({ title:'DNS 设置', html, ok:'保存', wide:true, onMount: b => { bindSelect(b); window.__dnsBox = b } })
  if (!box) return
  const lines = sel => [...box.querySelectorAll(sel)].map(e => e.value).join('\\n').split('\\n').map(s => s.trim()).filter(Boolean)
  const next = {
    selfGroup: selValue(box.querySelector('#dself')),
    remoteViaProxy: box.querySelector('#dviap').dataset.on === '1',
    fakeIp: box.querySelector('#dfake').dataset.on === '1',
    ipv6: box.querySelector('#dv6').dataset.on === '1',
    extraFilter: lines('#dfilter'),
    policies: [...box.querySelectorAll('#dpol [data-pi]')].map(r => ({
      domain: r.querySelector('.pdm').value.trim(),
      group: selValue(r.querySelector('.sel'))
    })).filter(x => x.domain)
  }
  for (const g of groups) next[g.k] = lines('#dg_' + g.k)
  const r = await api('/api/settings', { ...st, dns: next })
  if (!r.ok) return toast(r.msg || '保存失败', true)
  SET = { ok:true, settings: r.settings, dnsGroups: groups }
  toast('DNS 设置已保存'); dash(true)
}
window.addDnsPol = () => {
  const b = window.__dnsBox
  if (!b) return
  const groups = (SET && SET.dnsGroups) || []
  const i = 'n' + Date.now()
  b.querySelector('#dpol').insertAdjacentHTML('beforeend', \`<div class="row" data-pi="\${i}" style="gap:8px;margin-bottom:6px">
    <input class="pdm" placeholder="+.example.com" style="flex:1">
    \${selectHTML('pg' + i, groups.map(g => ({ v:g.k, label:g.label })), groups[0].k)}
    <button class="ib dl" data-tip="删除" onclick="this.closest('[data-pi]').remove()">\${icon('trash')}</button></div>\`)
  bindSelect(b)
}

// ---- 链式代理 ----
async function reloadChains(msg){
  const card = document.getElementById('chaincard')
  if (card) card.classList.add('busy')
  CH = await api('/api/chains')
  ST = await api('/api/state')          // 链影响不了节点列表，但策略目标下拉要用最新的
  if (card) { card.classList.remove('busy'); card.innerHTML = chainCardInner() }
  if (msg) toast(msg)
}
window.chainAct = async (act, id) => {
  const r = await api('/api/chains', { act, id })
  if (!r.ok) return toast(r.msg || '操作失败', true)
  await reloadChains()
}
window.delChain = async (id, name) => {
  if (!await modal({ title:'删除链式代理', desc:\`「\${name}」将被移除。指向它的分流策略会回落到「🚀 节点选择」。\`, ok:'删除', danger:true })) return
  await api('/api/chains', { act:'del', id })
  await reloadChains('已删除')
}
window.editChain = async (id) => {
  if (!CH) return
  const c = (CH.chains || []).find(x => x.id === id) || { name:'', via:'', out:'' }
  const vias = CH.vias || [], lands = CH.lands || []
  if (!vias.length || !lands.length) return toast('还没有可用的节点，先添加自有节点或订阅源', true)
  const html = \`
    <div class="fg"><label class="lb">名称</label>
      <input id="cn" value="\${esc(c.name)}" placeholder="如 🔗 AI 家宽链">
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
  }})
  if (!box) return
  const name = box.querySelector('#cn').value.trim()
  const via = selValue(box.querySelector('#cv'))
  const out = selValue(box.querySelector('#co'))
  if (!name) return toast('给这条链起个名字', true)
  const r = await api('/api/chains', { act:'save', id, name, via, out })
  if (!r.ok) return toast(r.msg || '保存失败', true)
  await reloadChains(id ? '已保存' : '已新建')
}

window.changePwd = async () => {
  const html = \`
    <div class="fg"><label class="lb">当前密码</label>
      <input id="p0" type="password" autocomplete="current-password" placeholder="先验证身份"></div>
    <div class="fg"><label class="lb">新密码</label>
      <input id="p1" type="password" autocomplete="new-password" placeholder="至少 8 位"></div>
    <div class="fg"><label class="lb">再输一次</label>
      <input id="p2" type="password" autocomplete="new-password" placeholder="确认新密码">
      <div class="hint">保存后其它设备上的登录会失效，当前这台不用重新登录。</div></div>\`
  const box = await modal({ title:'修改密码', html, ok:'保存', wide:true })
  if (!box) return
  const oldPassword = box.querySelector('#p0').value
  const newPassword = box.querySelector('#p1').value
  // 输错了自己却看不见，只能在下次登录时才发现 —— 所以要求输两遍
  if (newPassword !== box.querySelector('#p2').value) return toast('两次输入的新密码不一致', true)
  if (!oldPassword) return toast('请输入当前密码', true)
  if (newPassword.length < 8) return toast('新密码至少 8 位', true)
  const r = await api('/api/password', { oldPassword, newPassword })
  if (!r.ok) return toast(r.msg || '修改失败', true)
  toast('密码已更新')
}
// 拉不通时的退路对话框。粘了内容就用内容，留空直接保存就是先把源加进来。
// 两件事塞进一个弹窗，是因为用户此刻只关心一件事：怎么才能把它用上。
const pasteBox = async (title, msg) => {
  const html = \`<div class="fg"><label class="lb">粘贴订阅内容</label>
    <textarea id="pt" placeholder="在浏览器里打开订阅链接 → 全选复制 → 粘到这里"></textarea>
    <div class="hint">浏览器是从你自己的网络访问机场的，不经过本站出口，机场拦不住。
      留空直接保存则先把这个源加进来，暂时不会有节点。</div></div>\`
  const b = await modal({ title, desc: msg + '。', html, ok:'保存', danger:true, wide:true })
  return b ? b.querySelector('#pt').value.trim() : null
}

window.addUp = async () => {
  const html = \`
    <div class="fg"><label class="lb">名称</label>
      <input id="un" placeholder="便于区分多个来源"></div>
    <div class="fg"><label class="lb">订阅链接</label>
      <input id="uu" placeholder="https://...">
      <div class="hint">保存前会先试拉一次，确认能解析出节点。</div></div>
    <div class="fg"><label class="lb">或粘贴订阅内容</label>
      <textarea id="ut" placeholder="机场拦住本站时用这个：浏览器打开订阅链接 → 全选复制 → 粘到这里"></textarea>
      <div class="hint">填了这里就不走网络，直接解析贴进来的内容并存成快照。</div></div>\`
  const box = await modal({ title:'添加订阅源', html, ok:'添加', wide:true })
  if (!box) return
  const name = box.querySelector('#un').value.trim()
  const url = box.querySelector('#uu').value.trim()
  const text = box.querySelector('#ut').value.trim()
  if (!url && !text) return toast('订阅链接和订阅内容至少要填一个', true)
  let r = await api('/api/upstreams', {act:'add', name, url, text})
  // 试拉不通就问一句，而不是默默收下一个死链接
  if (!r.ok && (r.canPaste || r.canForce)) {
    const t2 = await pasteBox('这个链接拉不通', r.msg)
    if (t2 === null) return
    r = await api('/api/upstreams', t2 ? {act:'add', name, url, text:t2} : {act:'add', name, url, force:1})
  }
  if (!r.ok) return toast(r.msg, true)
  toast(r.up && r.up.n ? \`已添加，解析到 \${r.up.n} 个节点\` : '已添加订阅源')
  await syncUp(r.up)
}
window.editUp = async (id) => {
  const u = (ST.upstreams || []).find(x => x.id === id)
  if (!u) return
  const auto = u.auto !== false
  const snapAt = (ST.snaps || {})[id]
  const html = \`
    <div class="fg"><label class="lb">名称</label>
      <input id="un" value="\${esc(u.name)}" placeholder="便于区分多个来源"></div>
    <div class="fg"><label class="lb">订阅链接</label>
      <input id="uu" value="\${esc(u.url)}" placeholder="https://...">
      <div class="hint">改动链接会立即拉取一次并刷新快照。</div></div>
    <div class="fg"><label class="lb">更新方式</label>
      \${selectHTML('ua', [
        {v:'1', label:'自动更新 — 每小时拉取最新节点'},
        {v:'0', label:'手动 — 只用快照，不自动拉取'}
      ], auto ? '1' : '0')}
      <div class="hint" id="uah"></div></div>
    <div class="fg"><label class="lb">或粘贴订阅内容</label>
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
  }})
  if (!box) return
  const name = box.querySelector('#un').value.trim()
  const url = box.querySelector('#uu').value.trim()
  const text = box.querySelector('#ut').value.trim()
  const a = selValue(box.querySelector('#ua')) === '1'
  if (!url && !text) return toast('订阅链接和订阅内容至少要填一个', true)
  let r = await api('/api/upstreams', { act:'edit', id, name, url, auto:a, text })
  if (!r.ok && (r.canPaste || r.canForce)) {
    const t2 = await pasteBox('新链接拉不通', r.msg)
    if (t2 === null) return
    r = await api('/api/upstreams', t2
      ? { act:'edit', id, name, url, auto:a, text:t2 }
      : { act:'edit', id, name, url, auto:a, force:1 })
  }
  if (!r.ok) return toast(r.msg, true)
  toast(r.up && r.up.n ? \`已保存，抓到 \${r.up.n} 个节点\` : '已保存')
  await syncUp(null)
}
window.delUp = async (id, name) => {
  if (!await modal({title:'删除订阅源', desc:\`「\${name}」及其全部节点将从订阅中移除。\`, ok:'删除', danger:true})) return
  await api('/api/upstreams', {act:'del', id})
  const row = document.querySelector(\`.uplist.src .up[data-id="\${id}"]\`)
  if (row) row.remove()
  toast('已删除'); await syncUp(null)
}

// 增删订阅源后的局部刷新：新行立刻插入，数据后台重取，
// 只重绘受影响的两处。整页 dash() 会换骨架屏 + 重放入场动画，看着就是「闪一下」。
async function syncUp(nu){
  const list = document.querySelector('.uplist.src')
  if (nu && list) {
    const em = list.querySelector('.empty')
    if (em) em.remove()
    ST.upstreams.push(nu)
    list.insertAdjacentHTML('beforeend', upRow(nu, ST.upstreams.length - 1))
  }
  const card = document.getElementById('nodecard')
  if (card) card.classList.add('busy')
  PRF = null                       // 档案的机场选项依赖它
  const r = await api('/api/state')
  if (card) card.classList.remove('busy')
  if (!r || !r.ok) return
  ST = r
  paintHeader()                    // 顶部「N 个订阅源 · M 个节点」
  if (list) {
    list.innerHTML = ST.upstreams.map(upRow).join('') || '<div class="empty">还没有订阅源</div>'
    bindDrag('.uplist.src', '.up', persistUpOrder)   // 行是新建的，拖拽要重新绑
  }
  if (card) card.innerHTML = nodeCardInner()
}

window.probeUp = async (id) => {
  if (!id) return
  const r = await api('/api/probe', { id })
  if (!r.ok) return toast(r.msg || '诊断失败', true)
  const row = (k, v) => \`<div class="up" style="grid-template-columns:104px minmax(0,1fr)">
    <span class="nm">\${k}</span><span class="u" style="white-space:pre-wrap">\${esc(String(v))}</span></div>\`
  // 每种客户端身份的结果逐条列出：机场拒绝我们、还是给了解析不了的格式，一眼分得清
  const uaName = t => t.ua || '（不带 UA）'
  const tryLine = t => t.err ? \`\${uaName(t)} → 请求失败：\${t.err}\`
    : t.status < 200 || t.status >= 300 ? \`\${uaName(t)} → HTTP \${t.status}\${t.body ? '：' + t.body : ''}\`
    : \`\${uaName(t)} → HTTP \${t.status} · \${t.fmt} · \${t.bytes} 字节 · \${t.n} 个节点\`
  let h = '<div class="uplist" style="grid-template-columns:104px minmax(0,1fr)">'
  if (r.tries && r.tries.length) h += row('逐个身份试拉', r.tries.map(tryLine).join('\\n'))
  if (r.snap) h += row('本地快照', \`\${r.snap.n} 个节点，抓于 \${ago(r.snap.at)}\` + (r.http === 0 ? ' —— 拉不通时订阅仍靠它供节点' : ''))
  if (r.http === 0) {
    h += row('结果', '请求失败：' + (r.err || '未知错误'))
  } else {
    h += row('采用', \`\${uaName(r)} 这一份\`)
    h += row('HTTP', r.http) + row('响应格式', r.fmt) + row('大小', r.bytes + ' 字节') + row('解析到节点', r.nodes + ' 个')
    h += row('Subscription-Userinfo 头', r.hasUserinfo ? r.headers['subscription-userinfo'] : '机场未返回该响应头')
    h += row('识别到的公告行', r.notes.length ? r.notes.join('\\n') : '（无）')
    h += row('最终用量信息', r.meta
      ? \`总量 \${r.meta.total ? fmtSize(r.meta.total) : '未知'} · 已用 \${fmtSize((r.meta.up||0)+(r.meta.down||0))} · 到期 \${r.meta.expire ? new Date(r.meta.expire*1000).toLocaleDateString('zh-CN') : '未知'}\`
      : '解析不出 —— 上面两行都没有可用信息')
    h += row('响应前几行', r.sample.join('\\n'))
  }
  h += '</div>'
  await modal({ title:'抓取诊断 · ' + r.name, desc:'机场到底给了什么，我们又解析出了什么。密钥字段已抹去。', html:h, ok:'知道了', noCancel:true, wide:true })
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
