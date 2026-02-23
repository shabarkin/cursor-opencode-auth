import fs from 'fs'
import path from 'path'

export const CONTEXT_FILE_PATH = path.join(process.cwd(), '.cursor-opencode-context.txt')

export function persistContextFile(content) {
  if (typeof content !== 'string') return

  try {
    fs.writeFileSync(CONTEXT_FILE_PATH, content, 'utf8')
  } catch {
    // Best-effort only.
  }
}

export function remapSyntheticContextPath(filePath) {
  if (typeof filePath !== 'string') return filePath

  const normalized = filePath.trim()
  if (normalized === '/context.txt' || normalized === 'context.txt') {
    return CONTEXT_FILE_PATH
  }

  return filePath
}
