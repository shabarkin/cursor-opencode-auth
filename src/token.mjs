/**
 * Cursor auth token extraction from macOS Keychain with TTL caching.
 *
 * The token is read via the `security` CLI (hardcoded command, not injectable)
 * and cached in-process to avoid shelling out on every request.
 */

import { execSync } from 'child_process'
import { TOKEN_CACHE_TTL_MS } from './config.mjs'

const KEYCHAIN_CMD = 'security find-generic-password -s "cursor-access-token" -w'

let cachedToken = null
let cachedAt = 0

/**
 * Returns the Cursor access token, reading from Keychain only if
 * the cache is empty or has expired (default 5 minutes).
 *
 * @returns {string} Bearer token
 * @throws {Error} If the token cannot be read from Keychain
 */
export function getToken() {
  const now = Date.now()

  if (cachedToken && (now - cachedAt) < TOKEN_CACHE_TTL_MS) {
    return cachedToken
  }

  try {
    const token = execSync(KEYCHAIN_CMD, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()

    if (!token) {
      throw new Error('Empty token returned from Keychain')
    }

    cachedToken = token
    cachedAt = now
    return token
  } catch (error) {
    throw new Error(
      `Failed to read Cursor token from macOS Keychain: ${error.message}. ` +
      'Ensure Cursor CLI is installed and you are logged in.'
    )
  }
}

/**
 * Clears the cached token, forcing the next getToken() call
 * to re-read from Keychain. Useful for testing or re-auth.
 */
export function clearTokenCache() {
  cachedToken = null
  cachedAt = 0
}
