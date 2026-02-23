import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getTokenFromEnv,
  getDefaultTokenPaths,
  getTokenFromFile,
} from '../src/token-store/file-store.mjs'
import { getMacOSToken, getMacOSTroubleshootingHint } from '../src/token-store/macos.mjs'
import { getLinuxToken, getLinuxTroubleshootingHint } from '../src/token-store/linux.mjs'
import { getWindowsToken, getWindowsTroubleshootingHint } from '../src/token-store/windows.mjs'
import { getTokenFromStore } from '../src/token-store/index.mjs'

test('file store reads env token and default path list', () => {
  assert.equal(getTokenFromEnv({ CURSOR_AUTH_TOKEN: '  abc  ' }), 'abc')
  assert.equal(getTokenFromEnv({}), null)

  const paths = getDefaultTokenPaths('/home/tester')
  assert.equal(paths.length >= 3, true)
  assert.equal(paths[0], '/home/tester/.cursor/token')
})

test('file store reads the first available token file', () => {
  const fsModule = {
    existsSync(targetPath) {
      return targetPath === '/tokens/second'
    },
    readFileSync(targetPath) {
      assert.equal(targetPath, '/tokens/second')
      return 'file-token\n'
    },
  }

  const token = getTokenFromFile({
    fsModule,
    paths: ['/tokens/first', '/tokens/second'],
  })

  assert.equal(token, 'file-token')
})

test('platform providers return tokens and troubleshooting hints', () => {
  assert.equal(
    getMacOSToken({ execFn: () => 'mac-token\n' }),
    'mac-token'
  )
  assert.equal(
    getLinuxToken({
      execFn(command) {
        if (command.includes('cursor-access-token')) {
          throw new Error('missing first key')
        }
        return 'linux-token\n'
      },
    }),
    'linux-token'
  )
  assert.equal(
    getWindowsToken({
      execFn(command) {
        if (command.includes('Get-StoredCredential')) {
          return 'Target: cursor-access-token'
        }
        return 'windows-token\n'
      },
    }),
    'windows-token'
  )

  assert.match(getMacOSTroubleshootingHint(), /security find-generic-password/)
  assert.match(getLinuxTroubleshootingHint(), /secret-tool/)
  assert.match(getWindowsTroubleshootingHint(), /Get-StoredCredential/)
})

test('platform providers return null when commands fail', () => {
  assert.equal(getMacOSToken({ execFn: () => { throw new Error('fail') } }), null)
  assert.equal(getLinuxToken({ execFn: () => { throw new Error('fail') } }), null)
  assert.equal(getWindowsToken({ execFn: () => { throw new Error('fail') } }), null)
})

test('getTokenFromStore handles unknown platform and throws helpful error', () => {
  const fsModule = {
    existsSync() {
      return false
    },
    readFileSync() {
      throw new Error('missing')
    },
  }

  assert.throws(
    () => getTokenFromStore({
      platform: 'freebsd',
      env: {},
      fsModule,
      tokenPaths: ['/tmp/missing'],
    }),
    /Set CURSOR_AUTH_TOKEN/
  )
})
