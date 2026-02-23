import { execSync } from 'child_process'

const LINUX_SECRET_TOOL_COMMANDS = Object.freeze([
  'secret-tool lookup service cursor-access-token',
  'secret-tool lookup service cursor token access',
])

export function getLinuxToken({ execFn = execSync } = {}) {
  for (const command of LINUX_SECRET_TOOL_COMMANDS) {
    try {
      const token = execFn(command, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()

      if (token.length > 0) {
        return token
      }
    } catch {
      continue
    }
  }

  return null
}

export function getLinuxTroubleshootingHint() {
  return 'Install libsecret and verify `secret-tool lookup service cursor-access-token` returns a token.'
}
