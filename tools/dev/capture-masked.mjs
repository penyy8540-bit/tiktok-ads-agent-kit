import fs from 'node:fs'
import { spawn } from 'node:child_process'

const NODE = process.execPath
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL_BASE = 'http://127.0.0.1:8795/'
const TMP = process.env.TEMP
const OUT_DIR = 'docs/images/overview'

// 需要打码的选择器：账户名 / 广告组名 / SKU / 商品名 / 建议动作里的组名
const BLUR_SELECTORS = [
  '.chip',
  '.btitle',
  '#campaignTable tbody td:nth-child(1)',
  '#campaignTable tbody td:nth-child(2)',
  '#drillTitle',
  '#drillSku tbody td:nth-child(1)',
  '#drillCreative tbody td:nth-child(3)',
  '#drillCreative tbody td:nth-child(4)',
  '#aiActions',
  '.boostMini b',
  '.boostMini span:first-child',
  '#tab-products table tbody td:nth-child(1)',
  '#tab-products table tbody td:nth-child(2)',
  '#prodMeta'
]

const injectBlur = `(() => {
  const id = 'privacy-blur';
  document.getElementById(id)?.remove();
  const style = document.createElement('style');
  style.id = id;
  style.textContent = ${JSON.stringify(BLUR_SELECTORS.join(','))} + '{filter:blur(6px) !important;}';
  document.head.appendChild(style);
  return 'blurred';
})()`

const steps = (tab, extra = []) => [
  { evaluate: `(() => { const nav = document.querySelector('nav button[data-tab=${tab}]'); if (nav) nav.click(); return '${tab}'; })()` },
  { evaluate: `new Promise((resolve) => { const start = Date.now(); const timer = setInterval(() => { if (document.querySelector('.bcard, #campaignTable tbody tr, #boostView svg, #tab-products table tbody tr') || Date.now() - start > 150000) { clearInterval(timer); resolve(true); } }, 700); })` },
  { wait: 2500 },
  ...extra,
  { evaluate: injectBlur },
  { wait: 600 }
]

const tabs = [
  {
    name: '01-watch.png',
    tab: 'watch',
    extra: [{ wait: 2000 }],
  },
  {
    name: '02-drill-sku.png',
    tab: 'campaigns',
    extra: [
      { evaluate: `(() => { const tr = document.querySelector('#campaignTable tbody tr'); if (tr) tr.click(); return 'drill'; })()` },
      { evaluate: `new Promise((resolve) => { const start = Date.now(); const timer = setInterval(() => { const rows = document.querySelectorAll('#drillCreative tbody tr'); if (rows.length || Date.now() - start > 150000) { clearInterval(timer); resolve(rows.length); } }, 800); })` },
      { wait: 2000 },
      { evaluate: `(() => { document.getElementById('drillCard')?.scrollIntoView({ block: 'start' }); return 'scrolled'; })()` },
      { wait: 800 },
    ],
  },
  {
    name: '03-ai.png',
    tab: 'ai',
    extra: [
      { evaluate: `new Promise((resolve) => { const start = Date.now(); const timer = setInterval(() => { if (document.querySelector('#boostPickSelect option') || Date.now() - start > 120000) { clearInterval(timer); resolve(true); } }, 700); })` },
      { evaluate: `(() => { const sel = document.getElementById('boostPickSelect'); if (sel && sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change')); } return 'picked'; })()` },
      { evaluate: `new Promise((resolve) => { const start = Date.now(); const timer = setInterval(() => { const svg = document.querySelector('#boostView svg'); if (svg || Date.now() - start > 180000) { clearInterval(timer); resolve(!!svg); } }, 900); })` },
      { wait: 1500 },
      { evaluate: `(() => { document.getElementById('boostCard')?.scrollIntoView({ block: 'center' }); return 'scrolled'; })()` },
      { wait: 800 },
    ],
  },
  {
    name: '04-export.png',
    tab: 'export',
    extra: [{ wait: 1500 }],
  },
  {
    name: '05-products.png',
    tab: 'products',
    extra: [
      { evaluate: `new Promise((resolve) => { const start = Date.now(); const timer = setInterval(() => { if (document.querySelector('#tab-products table tbody tr') || Date.now() - start > 150000) { clearInterval(timer); resolve(true); } }, 800); })` },
      { wait: 1500 },
    ],
  },
]

const run = (cmd, args) => new Promise((resolve) => {
  const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: true })
  child.on('close', (code) => resolve(code))
})

// 启动 headless chrome
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=9222',
  `--user-data-dir=${TMP}\\chr-mask`,
  '--window-size=1500,1000', 'about:blank',
], { detached: true, stdio: 'ignore', windowsHide: true })
chrome.unref()
await new Promise((r) => setTimeout(r, 6000))

for (const item of tabs) {
  const stepsPath = `${TMP}\\steps-mask-${item.name.replace('.png', '')}.json`
  const outPath = `${TMP}\\masked-${item.name}`
  fs.writeFileSync(stepsPath, JSON.stringify(steps(item.tab, item.extra)))
  console.log(`\n===== ${item.name} =====`)
  const code = await run(NODE, ['tools/dev/cdp-shot.mjs', URL_BASE, outPath, stepsPath])
  console.log(`exit=${code}`)
  if (code === 0 && fs.existsSync(outPath)) {
    fs.copyFileSync(outPath, `${OUT_DIR}/${item.name}`)
    console.log(`saved ${OUT_DIR}/${item.name}`)
  }
}
