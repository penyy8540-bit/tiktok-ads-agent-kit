/**
 * Static checks for the dashboard page embedded in lib/dashboard.js:
 * parse the inline <script>, and verify every $('#id') exists in the markup.
 *
 *   node tools/check-page.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../../lib/dashboard.js', import.meta.url), 'utf8')
const start = source.indexOf('<script>')
const end = source.lastIndexOf('</script>')
if (start < 0 || end < 0) {
  console.log('no inline <script> found')
  process.exit(1)
}
const code = source.slice(start + '<script>'.length, end)
try {
  new vm.Script(code)
  console.log(`inline dashboard script parses ok (${code.length} chars)`)
} catch (error) {
  console.log('INLINE SCRIPT SYNTAX ERROR:', error.message)
  process.exit(1)
}

const ids = new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))
const referenced = new Set([...code.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map((match) => match[1]))
const missing = [...referenced].filter((id) => !ids.has(id))
if (missing.length) {
  console.log('MISSING IDS: ' + missing.join(', '))
  process.exit(1)
}
console.log('all referenced ids exist')
