import { getTokenFromEnv, getTokenFromFile } from './file-store.mjs'
import { getMacOSToken, getMacOSTroubleshootingHint } from './macos.mjs'
import { getLinuxToken, getLinuxTroubleshootingHint } from './linux.mjs'
import { getWindowsToken, getWindowsTroubleshootingHint } from './windows.mjs'

function platformHint(platform) {
  if (platform === 'darwin') return getMacOSTroubleshootingHint()
  if (platform === 'linux') return getLinuxTroubleshootingHint()
  if (platform === 'win32') return getWindowsTroubleshootingHint()
  return 'Set CURSOR_AUTH_TOKEN or create a token file in ~/.cursor/token.'
}

function readPlatformToken(platform, execFn) {
  if (platform === 'darwin') {
    return getMacOSToken({ execFn })
  }

  if (platform === 'linux') {
    return getLinuxToken({ execFn })
  }

  if (platform === 'win32') {
    return getWindowsToken({ execFn })
  }

  return null
}

export function getTokenFromStore({
  platform = process.platform,
  execFn,
  env = process.env,
  fsModule,
  tokenPaths,
} = {}) {
  const envToken = getTokenFromEnv(env)
  if (envToken) {
    return envToken
  }

  const platformToken = readPlatformToken(platform, execFn)
  if (platformToken) {
    return platformToken
  }

  const fileToken = getTokenFromFile({ fsModule, paths: tokenPaths })
  if (fileToken) {
    return fileToken
  }

  throw new Error(
    `Failed to load Cursor auth token on platform "${platform}". ` +
    `Set CURSOR_AUTH_TOKEN or configure platform credentials. ${platformHint(platform)}`
  )
}
