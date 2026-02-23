import { execSync } from 'child_process'

const WINDOWS_TOKEN_COMMANDS = Object.freeze([
  'powershell -NoProfile -Command "$cred = Get-StoredCredential -Target \"cursor-access-token\"; if ($cred) { $cred.Password }"',
  'powershell -NoProfile -Command "cmdkey /list | Out-String"',
])

export function getWindowsToken({ execFn = execSync } = {}) {
  for (const command of WINDOWS_TOKEN_COMMANDS) {
    try {
      const output = execFn(command, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()

      if (!output) continue

      if (output.includes('Target:')) {
        continue
      }

      return output
    } catch {
      continue
    }
  }

  return null
}

export function getWindowsTroubleshootingHint() {
  return 'Install PowerShell CredentialManager and verify Get-StoredCredential -Target "cursor-access-token".'
}
