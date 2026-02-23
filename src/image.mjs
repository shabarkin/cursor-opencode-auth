const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mimeToExtension(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  return 'bin'
}

export function parseDataUrl(url) {
  if (typeof url !== 'string') {
    throw new Error('Image URL must be a string')
  }

  const match = DATA_URL_RE.exec(url)
  if (!match) {
    throw new Error('Only base64 data:image URLs are supported')
  }

  const mimeType = match[1]
  const base64 = match[2]
  const data = Buffer.from(base64, 'base64')

  if (data.length === 0) {
    throw new Error('Image data URL payload is empty')
  }

  if (data.length > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(`Image exceeds maximum size of ${MAX_IMAGE_SIZE_BYTES} bytes`)
  }

  return {
    mimeType,
    base64,
    data,
  }
}

export function extractImageParts(content) {
  if (!Array.isArray(content)) {
    return []
  }

  return content.filter((part) => (
    isObject(part) &&
    part.type === 'image_url' &&
    isObject(part.image_url) &&
    typeof part.image_url.url === 'string'
  ))
}

export function fetchImageUrl() {
  throw new Error('Remote image URLs are not supported. Use base64 data:image URLs.')
}

export function buildImageContexts(images) {
  return images.map((part, index) => {
    const parsed = parseDataUrl(part.image_url.url)
    const ext = mimeToExtension(parsed.mimeType)

    return {
      path: `/image-${index + 1}.${ext}`,
      bytes: parsed.data,
      mimeType: parsed.mimeType,
    }
  })
}
