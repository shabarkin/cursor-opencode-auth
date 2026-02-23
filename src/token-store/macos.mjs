import { execSync } from 'child_process'

const KEYCHAIN_CMD = 'security find-generic-password -s "cursor-access-token" -w'

export function getMacOSToken({ execFn = execSync } = {}) {
  try {
    const token = execFn(KEYCHAIN_CMD, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()

    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

export function getMacOSTroubleshootingHint() {
  return 'Run `security find-generic-password -s "cursor-access-token" -w` to verify Keychain access.'
}
