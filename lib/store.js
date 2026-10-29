/**
 * Credential storage for the TikTok Ads plugin.
 *
 * Tokens never enter chat history or logs. They live in a single JSON file
 * under the plugin data directory with owner-only permissions.
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE_NAME = 'auth.json'

/**
 * @typedef {object} AuthRecord
 * @property {string} [clientId] dynamic-client-registration client id
 * @property {string} [redirectUri] redirect URI registered with that client
 * @property {string} [accessToken]
 * @property {string} [refreshToken]
 * @property {number} [expiresAt] epoch ms
 * @property {string} [scope]
 * @property {string} [resource] MCP endpoint the token was issued for
 * @property {string} [mode] layer | flat at authorization time
 * @property {number} [authorizedAt] epoch ms
 * @property {string} [accountHint] non-secret display hint (e.g. token suffix)
 */

/**
 * @param {string} dataDir
 */
function filePath(dataDir) {
  return path.join(dataDir, FILE_NAME)
}

/**
 * @param {string} dataDir
 */
function ensureDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
}

/**
 * Read the stored auth record, tolerating a missing or corrupt file.
 * @param {string} dataDir
 * @returns {AuthRecord}
 */
export function readAuth(dataDir) {
  try {
    const text = fs.readFileSync(filePath(dataDir), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Persist the auth record atomically with owner-only permissions.
 * @param {string} dataDir
 * @param {AuthRecord} record
 */
export function writeAuth(dataDir, record) {
  ensureDir(dataDir)
  const target = filePath(dataDir)
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(temporary, 0o600)
  } catch { /* best effort on platforms without POSIX modes */ }
  fs.renameSync(temporary, target)
  return record
}

/**
 * Remove stored credentials.
 * @param {string} dataDir
 */
export function clearAuth(dataDir) {
  try {
    fs.rmSync(filePath(dataDir), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Merge a patch into the stored record.
 * @param {string} dataDir
 * @param {Partial<AuthRecord>} patch
 */
export function updateAuth(dataDir, patch) {
  return writeAuth(dataDir, { ...readAuth(dataDir), ...patch })
}

/**
 * Whether a stored access token is still usable for the given resource.
 * @param {AuthRecord} record
 * @param {string} resource
 * @param {number} skewMs refresh this many ms before expiry
 */
export function isTokenUsable(record, resource, skewMs = 120_000) {
  if (!record.accessToken) return false
  if (record.resource && record.resource !== resource) return false
  if (!record.expiresAt) return true
  return record.expiresAt - Date.now() > skewMs
}

/**
 * Non-secret status summary for tools and logs.
 * @param {AuthRecord} record
 */
export function describeAuth(record) {
  if (!record.accessToken) return { authorized: false }
  const suffix = record.accessToken.slice(-4)
  return {
    authorized: true,
    tokenTail: suffix,
    scope: record.scope || null,
    resource: record.resource || null,
    mode: record.mode || null,
    expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
    expiresInSeconds: record.expiresAt ? Math.max(0, Math.round((record.expiresAt - Date.now()) / 1000)) : null,
    hasRefreshToken: Boolean(record.refreshToken),
  }
}
