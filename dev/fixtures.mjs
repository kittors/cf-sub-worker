// 示例数据：本地预览（dev/server.mjs）与静态演示页（scripts/build-demo.mjs）共用。
// 全部是保留地址与占位凭据，不对应任何真实服务。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DAY = 86400
const UUID = '11111111-2222-3333-4444-555555555555'
const b64 = s => Buffer.from(s, 'utf8').toString('base64')
// 用量头按「现在」算到期日：演示页过几个月再打开，也不会全都显示已过期
export const userinfo = ([up, down, total, days]) =>
  `upload=${up}; download=${down}; total=${total}; expire=${Math.floor(Date.now() / 1000) + days * DAY}`

// 机场 B：base64 分享链接列表，协议和地区都杂一点，覆盖各条解析路径
const SHARE = [
  `vless://${UUID}@sg1.example.invalid:443?encryption=none&security=reality&sni=www.apple.com&fp=chrome&pbk=PLACEHOLDERPUBKEY00000000000000000000000000&sid=0123abcd&type=tcp&flow=xtls-rprx-vision#${encodeURIComponent('新加坡 01 | 原生')}`,
  'vmess://' + b64(JSON.stringify({ v: '2', ps: '新加坡 02', add: 'sg2.example.invalid', port: '443', id: UUID, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'sg2.example.invalid', path: '/ws', tls: 'tls', sni: 'sg2.example.invalid' })),
  `tuic://${UUID}:tuicpass@sg3.example.invalid:443?congestion_control=bbr&alpn=h3&sni=sg3.example.invalid#${encodeURIComponent('新加坡 03 TUIC')}`,
  `trojan://trojanpass@us1.example.invalid:443?sni=us1.example.invalid&type=tcp#${encodeURIComponent('美国 01 洛杉矶')}`,
  `ss://${b64('aes-256-gcm:sspassword')}@us2.example.invalid:8388#${encodeURIComponent('美国 02 圣何塞')}`,
  `hysteria2://hy2pass@us3.example.invalid:443?sni=us3.example.invalid&obfs=salamander&obfs-password=obfspass#${encodeURIComponent('美国 03 Hy2')}`,
  `vless://${UUID}@us4.example.invalid:443?encryption=none&security=tls&sni=us4.example.invalid&type=ws&host=us4.example.invalid&path=%2Fvl#${encodeURIComponent('美国 04 家宽 | 住宅IP')}`,
  `trojan://trojanpass@tw1.example.invalid:443?sni=tw1.example.invalid#${encodeURIComponent('台湾 01')}`,
  'vmess://' + b64(JSON.stringify({ v: '2', ps: '韩国 01 首尔', add: 'kr1.example.invalid', port: '443', id: UUID, aid: '0', net: 'grpc', type: 'none', path: 'grpcsvc', tls: 'tls', sni: 'kr1.example.invalid' })),
  `ss://${b64('chacha20-ietf-poly1305:sspassword')}@uk1.example.invalid:8388#${encodeURIComponent('英国 01 伦敦')}`,
  `trojan://trojanpass@de1.example.invalid:443?sni=de1.example.invalid#${encodeURIComponent('德国 01 法兰克福')}`,
  `vless://${UUID}@jp9.example.invalid:443?encryption=none&security=tls&sni=jp9.example.invalid&type=grpc&serviceName=gsvc#${encodeURIComponent('日本 东京 IEPL')}`
]

export const FEEDS = {
  // 机场 A：Clash YAML，含流量/到期公告条目与 IPv6 节点
  a: { type: 'text/yaml; charset=utf-8', usage: [98135617755, 321529098078, 1288490188800, 6],
    body: () => fs.readFileSync(path.join(ROOT, 'test', 'fixture.yaml'), 'utf8') },
  // 机场 B：base64 分享链接，用量已经所剩无几
  b: { type: 'text/plain; charset=utf-8', usage: [0, 966367641600, 1073741824000, 180],
    body: () => b64(SHARE.join('\n')) },
  // 模拟机场的 WAF 挡住了 Worker 出站：看抓取诊断、试粘贴导入用
  blocked: { status: 403, type: 'text/html; charset=utf-8',
    body: () => '<html><title>Access denied | Error 1020</title><body>Error 1020 · Access denied · The site owner has banned your access based on your browser\'s signature.</body></html>' }
}

export const SHARE_SAMPLE = SHARE

// origin：示例机场的订阅地址指向谁（本地预览是自己，演示页是一个虚拟域名）
export function seedData(origin) {
  return {
    settings: {
      domain: 'sub.example.com',
      directDomains: ['nas.example.com'],
      directIPs: ['203.0.113.10'],
      proxyDomains: []
    },
    nodes: {
      usV2: { name: '美西-Reality', type: 'vless', s: '203.0.113.10', p: 443, u: UUID, sni: 'www.microsoft.com', pk: 'PLACEHOLDERPUBKEY00000000000000000000000000', sid: '0123456789abcdef', net: 'tcp', flow: 'xtls-rprx-vision' },
      usGoogle: { name: '美西-Google', type: 'vless', s: '203.0.113.25', p: 443, u: UUID, sni: 'addons.mozilla.org', pk: 'PLACEHOLDERPUBKEY1111111111111111111111111A', sid: 'fedcba9876543210', net: 'tcp', flow: 'xtls-rprx-vision' },
      hkHy2: { name: '香港-Hy2', type: 'hysteria2', s: 'hk.example.com', p: 8443, ports: '50000-50100', u: 'hy2password', sni: 'hk.example.com', obfs: 'salamander', opwd: 'obfspassword' }
    },
    upstreams: [
      { id: 'a1', name: '云端加速', url: origin + '/__feed/a', enabled: true },
      { id: 'b2', name: '星链', url: origin + '/__feed/b', enabled: true }
    ],
    profiles: [
      { id: 'main', name: '主订阅', token: 'c0ffee00c0ffee00c0ffee00c0ffee00', enabled: true, own: 'all', ups: 'all', regions: 'all', pols: 'all', policies: 'inherit', mode: 'whitelist', note: '' },
      { id: 'phone', name: '手机', token: 'a11ce0000a11ce0000a11ce0000a11ce', enabled: true, own: ['usV2', 'hkHy2'], ups: 'all', regions: ['jp', 'hk', 'sg', 'us'], pols: 'all', policies: 'inherit', mode: 'whitelist', note: '只留常用地区' },
      { id: 'family', name: '家人', token: 'fa111e5fa111e5fa111e5fa111e5fa11', enabled: true, own: [], ups: ['a1'], regions: 'all', pols: ['youtube', 'media', 'social', 'apple', 'ms', 'misc'], policies: 'inherit', mode: 'blacklist', note: '不含自建节点' }
    ],
    chains: [
      { id: 'c1', name: '🔗 AI 家宽链', via: 'own:usV2', out: 'b2::美国 04 家宽 | 住宅IP', enabled: true }
    ]
  }
}
