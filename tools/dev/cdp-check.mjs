/**
 * Verify the KPI tiles are clickable by driving a real Chrome through CDP.
 *
 *   node tools/cdp-check.mjs <url> <debugPort>
 */
const url = process.argv[2] || 'http://127.0.0.1:8795/?tab=watch'
const port = Number(process.argv[3] || 9222)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return response.json()
}

async function main() {
  let page = null
  for (let attempt = 0; attempt < 40 && !page; attempt++) {
    try {
      const list = await targets()
      page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
    } catch { /* chrome not ready */ }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('chrome devtools not reachable')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed')
    return result.result?.value
  }

  await send('Page.enable')
  await send('Page.navigate', { url })
  await sleep(6000)

  // wait until cards render
  for (let attempt = 0; attempt < 30; attempt++) {
    const ready = await evaluate("document.querySelectorAll('[data-kpi-metric]').length")
    if (ready) break
    await sleep(1000)
  }

  const before = await evaluate(`(() => {
    const holder = document.querySelector('[data-module-metrics]');
    return holder ? Array.from(holder.querySelectorAll('[data-kpi-metric]')).map((tile) => tile.dataset.kpiMetric + ':' + tile.classList.contains('on')) : [];
  })()`)
  console.log('选中状态（点之前）:', before.join(' | '))

  // click a tile that is currently NOT selected
  const clicked = await evaluate(`(() => {
    const holder = document.querySelector('[data-module-metrics]');
    if (!holder) return 'no holder';
    const tiles = Array.from(holder.querySelectorAll('[data-kpi-metric]'));
    const target = tiles.find((tile) => !tile.classList.contains('on'));
    if (!target) return 'all selected';
    target.click();
    return target.dataset.kpiMetric;
  })()`)
  console.log('点击的指标:', clicked)
  await sleep(800)

  const after = await evaluate(`(() => {
    const holder = document.querySelector('[data-module-metrics]');
    return holder ? Array.from(holder.querySelectorAll('[data-kpi-metric]')).map((tile) => tile.dataset.kpiMetric + ':' + tile.classList.contains('on')) : [];
  })()`)
  console.log('选中状态（点之后）:', after.join(' | '))

  const legend = await evaluate("document.querySelector('.bcard .legend') ? document.querySelector('.bcard .legend').innerText : ''")
  console.log('图例:', legend.replace(/\\n/g, ' '))

  const saved = await evaluate("fetch('/api/board').then((r) => r.json()).then((d) => JSON.stringify(d.modules[0].metrics))")
  console.log('服务器端已保存的指标:', saved)

  socket.close()
  if (before.join() !== after.join()) console.log('RESULT: 点击生效 ✅')
  else console.log('RESULT: 点击无效 ❌')
}

main().catch((error) => {
  console.log('ERROR:', error.message)
  process.exit(1)
})
