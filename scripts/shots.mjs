// 重新生成 README 里的截图：用本机 Chrome 的无头模式打开 docs/demo.html，逐页截图。
//
//   node scripts/build-demo.mjs && node scripts/shots.mjs
//   CHROME=/path/to/chrome node scripts/shots.mjs
//
// 截的是演示页，数据全是示例，不会碰到任何真实配置。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launch, sleep } from './cdp.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEMO = pathToFileURL(path.join(ROOT, 'docs', 'demo.html')).href
if (!fs.existsSync(new URL(DEMO))) { console.error('先运行 node scripts/build-demo.mjs'); process.exit(1) }

// 每张截图：打开哪一页、多大的窗口、要不要先点开什么
const SHOTS = [
  { file: '01-nodes.png', hash: 'node', w: 1080, h: 1000 },
  { file: '02-subs.png', hash: 'sub', w: 1080, h: 1000 },
  { file: '03-policies.png', hash: 'pol', w: 1080, h: 1000 },
  { file: '04-editor.png', hash: 'pol', w: 1080, h: 1000, js: 'editPol(3)' },
  { file: '05-preview.png', hash: 'sub', w: 1080, h: 1000, js: 'previewSub(0)', wait: 900 },
  { file: '06-match.png', hash: 'pol', w: 1080, h: 1000,
    js: `document.getElementById('mq').scrollIntoView({block:'end'}); window.scrollBy(0, 360); await runMatch('gemini.google.com')` },
  { file: '07-mobile.png', hash: 'sub', w: 390, h: 844, mobile: true },
  // 暗色选策略页：节点列表里有台湾节点，🇹🇼 在中国区的 macOS 上渲染成 ☒，截成图谁看都像是坏了
  { file: '08-dark.png', hash: 'pol', w: 1080, h: 1000, dark: true }
]

const b = await launch()
try {
  for (const s of SHOTS) {
    await b.viewport(s.w, s.h, { scale: 2, mobile: s.mobile, dark: s.dark })
    await b.open(`${DEMO}#${s.hash}`)
    // 每张图都从干净的示例数据开始；去掉动画与演示横幅，截出来的才稳定
    await b.run(`sessionStorage.clear()
      document.head.insertAdjacentHTML('beforeend', '<style>*{animation:none!important;transition:none!important;caret-color:transparent!important}#demobar{display:none!important}</style>')
      window.scrollTo(0, 0)`)
    if (s.js) await b.run(s.js)
    await sleep(s.wait || 400)
    const { data } = await b.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(ROOT, 'docs', s.file), Buffer.from(data, 'base64'))
    console.log(`  ✓ docs/${s.file}`)
  }
  if (b.errors.length) { console.error('页面脚本报错：\n  ' + b.errors.slice(0, 5).join('\n  ')); process.exitCode = 1 }
} catch (e) {
  console.error('截图失败：', e.message)
  process.exitCode = 1
} finally {
  b.close()
}
