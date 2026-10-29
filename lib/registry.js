/**
 * Tool-catalog helpers: keyword search, deterministic ranking, bounded
 * rendering, and an on-disk cache so the catalog survives a restart without a
 * network round trip.
 */
import fs from 'node:fs'
import path from 'node:path'

const CACHE_FILE = 'tools-cache.json'
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const DESCRIPTION_CHARS = 180

/**
 * @typedef {{ name: string, description?: string, inputSchema?: unknown, annotations?: unknown }} McpTool
 */

/**
 * Split a query into lowercase search terms.
 * @param {string} query
 */
export function termsOf(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,，、|/]+/)
    .map((term) => term.trim())
    .filter(Boolean)
}

/**
 * Score one tool against the search terms. Higher is better; 0 means no match.
 * @param {McpTool} tool
 * @param {string[]} terms
 */
export function scoreTool(tool, terms) {
  const name = String(tool.name || '').toLowerCase()
  const description = String(tool.description || '').toLowerCase()
  let score = 0
  for (const term of terms) {
    let hit = 0
    if (name === term) hit += 100
    else if (name.startsWith(term)) hit += 60
    else if (name.includes(term)) hit += 40
    if (description.includes(term)) hit += 10
    if (hit === 0) return 0
    score += hit
  }
  return score
}

/**
 * Rank and page the catalog.
 * @param {McpTool[]} tools
 * @param {{ query?: string, limit?: number, offset?: number }} options
 */
export function searchTools(tools, { query = '', limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const terms = termsOf(query)
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIMIT))
  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0)
  const matched = []
  tools.forEach((tool, index) => {
    const score = terms.length === 0 ? 1 : scoreTool(tool, terms)
    if (score > 0) matched.push({ tool, score, index })
  })
  matched.sort((left, right) => right.score - left.score || left.index - right.index)
  const page = matched.slice(safeOffset, safeOffset + safeLimit)
  return {
    matchedCount: matched.length,
    total: tools.length,
    offset: safeOffset,
    limit: safeLimit,
    tools: page.map((entry) => entry.tool),
  }
}

/**
 * Render tools as compact lines for a model-facing tool result.
 * @param {McpTool[]} tools
 */
export function renderToolLines(tools) {
  return tools.map((tool) => {
    const description = String(tool.description || '').replace(/\s+/g, ' ').trim()
    const clipped = description.length > DESCRIPTION_CHARS ? `${description.slice(0, DESCRIPTION_CHARS)}…` : description
    return `- ${tool.name}${clipped ? `: ${clipped}` : ''}`
  })
}

/**
 * @param {string} dataDir
 */
function cachePath(dataDir) {
  return path.join(dataDir, CACHE_FILE)
}

/**
 * @param {string} dataDir
 * @param {{ resource: string, syncedAt: number, tools: McpTool[] }} value
 */
export function writeCache(dataDir, value) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const temporary = `${cachePath(dataDir)}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ ...value, tools: value.tools.map(({ name, description }) => ({ name, description })) }), { mode: 0o600 })
    fs.renameSync(temporary, cachePath(dataDir))
  } catch { /* the cache is only an optimization */ }
}

/**
 * @param {string} dataDir
 * @param {string} resource
 * @returns {{ resource: string, syncedAt: number, tools: McpTool[] } | null}
 */
export function readCache(dataDir, resource) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(dataDir), 'utf8'))
    if (!parsed || parsed.resource !== resource || !Array.isArray(parsed.tools)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Suggest near matches for a misspelled tool name.
 * @param {McpTool[]} tools
 * @param {string} name
 * @param {number} count
 */
export function suggestToolNames(tools, name, count = 5) {
  const needle = String(name || '').toLowerCase()
  const scored = tools.map((tool) => {
    const candidate = String(tool.name || '').toLowerCase()
    let score = 0
    if (candidate.includes(needle) || needle.includes(candidate)) score = 2
    else {
      const prefix = commonPrefixLength(candidate, needle)
      if (prefix >= 3) score = 1
    }
    return { name: tool.name, score }
  })
  return scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, count)
    .map((entry) => entry.name)
}

/**
 * @param {string} left
 * @param {string} right
 */
function commonPrefixLength(left, right) {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left[index] === right[index]) index++
  return index
}
