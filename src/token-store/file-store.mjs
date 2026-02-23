import fs from 'fs'
import os from 'os'
import path from 'path'

export function getTokenFromEnv(env = process.env) {
  const envToken = typeof env.CURSOR_AUTH_TOKEN === 'string'
    ? env.CURSOR_AUTH_TOKEN.trim()
    : ''

  return envToken.length > 0 ? envToken : null
}

export function getDefaultTokenPaths(homeDir = os.homedir()) {
  return Object.freeze([
    path.join(homeDir, '.cursor', 'token'),
    path.join(homeDir, '.config', 'cursor', 'token'),
    path.join(homeDir, '.cursor', 'auth', 'token'),
  ])
}

export function getTokenFromFile({
  fsModule = fs,
  paths = getDefaultTokenPaths(),
} = {}) {
  for (const tokenPath of paths) {
    try {
      if (!fsModule.existsSync(tokenPath)) {
        continue
      }

      const token = fsModule.readFileSync(tokenPath, 'utf8').trim()
      if (token.length > 0) {
        return token
      }
    } catch {
      // Skip unreadable files and continue fallback chain.
      continue
    }
  }

  return null
}
