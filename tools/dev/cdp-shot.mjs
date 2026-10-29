/**
 * Drive the dashboard through Chrome DevTools Protocol: click things, set dates,
 * and capture a screenshot. Used to verify real interactions (not guesses).
 *
 *   node tools/cdp-shot.mjs <url> <out.png> [script-json]
 *
 * script-json: array of steps, e.g. [{"click":"nav button[data-tab=campaigns]"},{"click":"#rangeChips .chip[data-mode=custom]"},{"value":["#rangeStart","2026-10-24"]},{"click":"#applyRange"}]
 */
import fs from 'node:fs'

const url = process.argv[2] || 'http://127.0.0.1:8795/'
const outFile = process.argv[3] || 'shot.png'
const rawSteps = process.argv[4] || ``
const steps = rawSteps ? JSON.parse(rawSteps.endsWith(`.json`) ? fs.readFileSync(rawSteps, `utf8`) : rawSteps) : []
const debugPort = Number(process.env.CDP_PORT || 9222)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  let page = null
  for (let attempt = 0; attempt < 40 && !page; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const list = await response.json()
      page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
    } catch { /* not ready */ }
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
  await send('Runtime.enable')
  await send('Page.navigate', { url })
  await sleep(6000)

  for (const step of steps) {
    if (step.wait) await sleep(step.wait)
    if (step.click) {
      const clicked = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(step.click)}); if (!el) return false; el.click(); return true; })()`)
      console.log(`click ${step.click} -> ${clicked}`)
      await sleep(step.after || 800)
    }
    if (step.value) {
      const [selector, value] = step.value
      const ok = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
      console.log(`value ${selector}=${value} -> ${ok}`)
      await sleep(400)
    }
    if (step.move) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: step.move[0], y: step.move[1], buttons: 0 });
      console.log('move ->', step.move.join(','));
      await sleep(step.after || 600);
    }
    if (step.evaluate) {
      const result = await evaluate(step.evaluate)
      console.log(`eval ->`, JSON.stringify(result))
      await sleep(400)
    }
  }

  // give the render a moment (data fetch)
  await sleep(Number(process.env.CDP_SETTLE || 6000))
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: process.env.CDP_FULL !== '0' })
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'))
  console.log('screenshot ->', outFile)
  socket.close()
}

main().catch((error) => {
  console.log('ERROR:', error.message)
  process.exit(1)
})
