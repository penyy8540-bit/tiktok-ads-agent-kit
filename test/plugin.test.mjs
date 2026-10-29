/**
 * Plugin-level smoke test: load `apply()` with a fake Cordis context and verify
 * every registered definition satisfies DSH's enforced JSON Schema subset
 * (type/oneOf/properties/required/additionalProperties/items/enum/const +
 * annotations). Reproducing the subset here keeps the plugin independent of
 * `@deepseek-ai/dsh-tools` while still failing loudly if a schema drifts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'deprecated', 'readOnly', 'writeOnly', 'examples', 'default'])

function checkSchema(node, at, violations) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${at} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) violations.push(`${at}.${key} is not a supported keyword`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) violations.push(`${at} cannot declare both type and oneOf`)
  if (!hasType && !hasOneOf) violations.push(`${at} must declare type or oneOf`)
  if (hasType && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(node.type)) {
    violations.push(`${at}.type is invalid`)
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required)) violations.push(`${at}.required must be an array`)
    else {
      for (const key of node.required) {
        if (!node.properties || !Object.hasOwn(node.properties, key)) violations.push(`${at}.required names "${key}" which is not in properties`)
      }
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${at}.additionalProperties must be a boolean`)
  }
  if (node.properties) {
    for (const [key, value] of Object.entries(node.properties)) checkSchema(value, `${at}.properties.${key}`, violations)
  }
  if (node.items) checkSchema(node.items, `${at}.items`, violations)
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((value, index) => checkSchema(value, `${at}.oneOf[${index}]`, violations))
}

function fakeContext() {
  const registrations = []
  const effects = []
  const context = {
    tools: {
      register(definition) {
        assert.equal(typeof definition.name, 'string')
        assert.equal(typeof definition.description, 'string')
        assert.equal(typeof definition.output.render, 'function')
        registrations.push(definition)
        return () => {}
      },
    },
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
    logger: { info() {}, warn() {}, debug() {} },
  }
  return { context, registrations, effects }
}

async function loadPlugin(dataDir) {
  const module = await import('../lib/index.js')
  return { module, dataDir }
}

test('the plugin exports the Cordis contract', async () => {
  const { module } = await loadPlugin()
  assert.equal(module.name, 'tiktok-ads')
  assert.deepEqual(module.inject, ['tools'])
  assert.equal(typeof module.apply, 'function')
})

test('apply registers six tools with DSH-supported schemas', async () => {
  const { module } = await loadPlugin()
  const { context, registrations } = fakeContext()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-ads-plugin-'))
  module.apply(context, { dataDir: dir, dashboardEnabled: false })
  try {
    const names = registrations.map((definition) => definition.name).sort()
    assert.deepEqual(names, [
      'tiktok_ads_call',
      'tiktok_ads_connect',
      'tiktok_ads_disconnect',
      'tiktok_ads_panel',
      'tiktok_ads_status',
      'tiktok_ads_tools',
    ])
    for (const definition of registrations) {
      const violations = []
      checkSchema(definition.parameters, `${definition.name}.parameters`, violations)
      checkSchema(definition.output.schema, `${definition.name}.output`, violations)
      assert.deepEqual(violations, [], `${definition.name}: ${violations.join('; ')}`)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(definition.output.schema.type, 'object')
      assert.ok(definition.timeoutMs === undefined || definition.timeoutMs > 0)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('status reports an unauthorized state without touching the network', async () => {
  const { module } = await loadPlugin()
  const { context, registrations } = fakeContext()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-ads-status-'))
  module.apply(context, { dataDir: dir, proxy: 'off', dashboardEnabled: false })
  try {
    const status = registrations.find((definition) => definition.name === 'tiktok_ads_status')
    const value = await status.execute({}, { signal: undefined })
    assert.equal(value.authorized, false)
    assert.equal(value.resource, 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer')
    assert.equal(value.proxy, 'none')
    assert.match(value.message, /tiktok_ads_connect/)
    assert.equal(status.output.render({}, value)[0].type, 'text')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('call rejects unknown tool names without a network round trip', async () => {
  const { module } = await loadPlugin()
  const { context, registrations } = fakeContext()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-ads-call-'))
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ accessToken: 'x', refreshToken: 'y', clientId: 'z', resource: 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer' }))
  module.apply(context, { dataDir: dir, proxy: 'off', dashboardEnabled: false })
  try {
    const call = registrations.find((definition) => definition.name === 'tiktok_ads_call')
    await assert.rejects(call.execute({ tool: '', args: {} }, {}), /tool/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

