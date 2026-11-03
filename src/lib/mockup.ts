import { isBitmapLive } from './pack'

export type MockupBackground = {
  name: string
  bitmap: ImageBitmap
  width: number
  height: number
}

export type MockupLayer = {
  name: string
  bitmap: ImageBitmap
  x: number
  y: number
  width: number
  height: number
}

export type MockupSizeLimits = {
  maxWidth: number
  maxHeight: number
  minSide?: number
}

/** Fit a design into max W×H while keeping aspect ratio. */
export function fitDesignWithin(
  srcW: number,
  srcH: number,
  limits: MockupSizeLimits,
  preferredLongSide?: number,
): { width: number; height: number } {
  const minSide = limits.minSide ?? 40
  const maxW = Math.max(minSide, limits.maxWidth)
  const maxH = Math.max(minSide, limits.maxHeight)
  if (srcW <= 0 || srcH <= 0) {
    return { width: minSide, height: minSide }
  }

  let scale = Math.min(maxW / srcW, maxH / srcH)
  if (preferredLongSide != null && preferredLongSide > 0) {
    const long = Math.max(srcW, srcH)
    scale = Math.min(scale, preferredLongSide / long)
  }
  // Default ~28% of the tighter max edge if nothing preferred
  if (preferredLongSide == null) {
    const target = Math.min(maxW, maxH) * 0.5
    scale = Math.min(scale, target / Math.max(srcW, srcH))
  }

  let width = srcW * scale
  let height = srcH * scale

  // Enforce minimums without breaking max bounds when possible
  if (Math.min(width, height) < minSide) {
    const up = minSide / Math.min(width, height)
    width *= up
    height *= up
    const down = Math.min(1, maxW / width, maxH / height)
    width *= down
    height *= down
  }

  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  }
}

/** Size from a requested width (aspect locked), clamped to limits. */
export function sizeFromWidth(
  srcW: number,
  srcH: number,
  width: number,
  limits: MockupSizeLimits,
): { width: number; height: number } {
  const aspect = srcW / srcH
  const minSide = limits.minSide ?? 40
  let w = Math.round(width)
  let h = Math.round(w / aspect)
  if (w > limits.maxWidth) {
    w = limits.maxWidth
    h = Math.round(w / aspect)
  }
  if (h > limits.maxHeight) {
    h = limits.maxHeight
    w = Math.round(h * aspect)
  }
  if (w < minSide) {
    w = minSide
    h = Math.round(w / aspect)
  }
  if (h < minSide) {
    h = minSide
    w = Math.round(h * aspect)
  }
  w = Math.min(w, limits.maxWidth)
  h = Math.min(h, limits.maxHeight)
  return { width: Math.max(1, w), height: Math.max(1, h) }
}

/** Size from a requested height (aspect locked), clamped to limits. */
export function sizeFromHeight(
  srcW: number,
  srcH: number,
  height: number,
  limits: MockupSizeLimits,
): { width: number; height: number } {
  const aspect = srcW / srcH
  return sizeFromWidth(srcW, srcH, height * aspect, limits)
}

/** Default placement: centered, within max W×H (or ~28% of mockup). */
export function defaultLayerPlacement(
  bg: MockupBackground,
  design: { width: number; height: number; name: string; bitmap: ImageBitmap },
  limits?: MockupSizeLimits,
): MockupLayer {
  const resolved: MockupSizeLimits = limits ?? {
    maxWidth: Math.floor(bg.width * 0.55),
    maxHeight: Math.floor(bg.height * 0.55),
    minSide: 40,
  }
  const preferred = Math.min(bg.width, bg.height) * 0.28
  const { width, height } = fitDesignWithin(
    design.width,
    design.height,
    resolved,
    preferred,
  )
  return {
    name: design.name,
    bitmap: design.bitmap,
    x: (bg.width - width) / 2,
    y: (bg.height - height) / 2 - bg.height * 0.04,
    width,
    height,
  }
}

/**
 * Paint one mockup: background + a single design (each tagged PNG = its own mockup).
 * `displayScale` = canvas.width / CSS width so handles stay ~18–22px on screen.
 */
export function paintUserMockup(
  canvas: HTMLCanvasElement,
  bg: MockupBackground,
  layer: MockupLayer | null,
  showHandles = true,
  displayScale = 1,
) {
  if (canvas.width !== bg.width) canvas.width = bg.width
  if (canvas.height !== bg.height) canvas.height = bg.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, bg.width, bg.height)
  ctx.drawImage(bg.bitmap, 0, 0, bg.width, bg.height)

  if (!layer || !isBitmapLive(layer.bitmap)) return

  try {
    ctx.drawImage(layer.bitmap, layer.x, layer.y, layer.width, layer.height)
  } catch {
    return
  }

  if (!showHandles) return

  const scale = Math.max(0.5, displayScale)
  const pad = Math.max(6 * scale, Math.min(layer.width, layer.height) * 0.02)
  const lw = Math.max(2 * scale, 2)
  // ~20px on screen, capped so tiny designs aren’t all handle
  const r = Math.min(
    Math.max(18 * scale, Math.min(layer.width, layer.height) * 0.12),
    Math.min(layer.width, layer.height) * 0.45,
  )
  ctx.save()
  ctx.strokeStyle = '#1ec8d4'
  ctx.lineWidth = lw
  ctx.setLineDash([10 * scale, 8 * scale])
  ctx.strokeRect(
    layer.x - pad,
    layer.y - pad,
    layer.width + pad * 2,
    layer.height + pad * 2,
  )
  ctx.setLineDash([])
  const corners = [
    { x: layer.x, y: layer.y },
    { x: layer.x + layer.width, y: layer.y },
    { x: layer.x, y: layer.y + layer.height },
    { x: layer.x + layer.width, y: layer.y + layer.height },
  ]
  for (const c of corners) {
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#141210'
    ctx.lineWidth = Math.max(1.5 * scale, 1.5)
    ctx.beginPath()
    ctx.roundRect(c.x - r / 2, c.y - r / 2, r, r, 3 * scale)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#1ec8d4'
    ctx.fillRect(c.x - r / 5, c.y - r / 5, (r * 2) / 5, (r * 2) / 5)
  }

  // Size badge under the box (screen-readable)
  const label = `${Math.round(layer.width)}×${Math.round(layer.height)}`
  const fontPx = Math.max(13 * scale, 12)
  ctx.font = `700 ${fontPx}px ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const metrics = ctx.measureText(label)
  const tw = metrics.width + 14 * scale
  const th = fontPx + 10 * scale
  const bx = layer.x + layer.width / 2 - tw / 2
  const by = layer.y + layer.height + pad + 8 * scale
  ctx.fillStyle = 'rgba(20, 18, 16, 0.88)'
  ctx.beginPath()
  ctx.roundRect(bx, by, tw, th, 6 * scale)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.fillText(label, layer.x + layer.width / 2, by + 5 * scale)
  ctx.restore()
}

/** Aspect-locked resize from a corner; opposite corner stays fixed. */
export function resizeLayerFromCorner(
  layer: MockupLayer,
  corner: 'nw' | 'ne' | 'sw' | 'se',
  ptX: number,
  ptY: number,
  limits: MockupSizeLimits,
): MockupLayer {
  const aspect = layer.bitmap.width / layer.bitmap.height
  let width: number
  let height: number
  let x = layer.x
  let y = layer.y

  if (corner === 'se') {
    width = ptX - layer.x
    height = ptY - layer.y
  } else if (corner === 'sw') {
    width = layer.x + layer.width - ptX
    height = ptY - layer.y
  } else if (corner === 'ne') {
    width = ptX - layer.x
    height = layer.y + layer.height - ptY
  } else {
    width = layer.x + layer.width - ptX
    height = layer.y + layer.height - ptY
  }

  // Pick the dominant drag axis, then lock aspect
  if (width <= 0 || height <= 0) {
    return layer
  }
  if (width / height > aspect) {
    height = width / aspect
  } else {
    width = height * aspect
  }

  const sized = sizeFromWidth(layer.bitmap.width, layer.bitmap.height, width, limits)
  width = sized.width
  height = sized.height

  if (corner === 'se') {
    x = layer.x
    y = layer.y
  } else if (corner === 'sw') {
    x = layer.x + layer.width - width
    y = layer.y
  } else if (corner === 'ne') {
    x = layer.x
    y = layer.y + layer.height - height
  } else {
    x = layer.x + layer.width - width
    y = layer.y + layer.height - height
  }

  return { ...layer, x, y, width, height }
}

/** Export one mockup (bg + one design). */
export async function exportUserMockup(
  bg: MockupBackground,
  layer: MockupLayer,
  quality = 0.9,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = bg.width
  canvas.height = bg.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')

  ctx.drawImage(bg.bitmap, 0, 0, bg.width, bg.height)
  if (isBitmapLive(layer.bitmap)) {
    ctx.drawImage(layer.bitmap, layer.x, layer.y, layer.width, layer.height)
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Mockup export failed'))),
      'image/jpeg',
      quality,
    )
  })
}

function safeFileStem(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'design'
}

export async function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Export every tagged design as its own mockup file (each may use a different bg). */
export async function exportAllMockups(
  entries: { bg: MockupBackground; layer: MockupLayer }[],
  quality = 0.9,
): Promise<number> {
  let n = 0
  for (const { bg, layer } of entries) {
    const blob = await exportUserMockup(bg, layer, quality)
    await downloadBlob(blob, `etsy-mockup-${safeFileStem(layer.name)}.jpg`)
    n += 1
    // Let the browser finish starting each download
    await new Promise((r) => setTimeout(r, 250))
  }
  return n
}

export async function loadMockupBackground(file: File): Promise<MockupBackground> {
  return loadMockupBackgroundFromBlob(file, file.name)
}

export async function loadMockupBackgroundFromBlob(
  blob: Blob,
  name: string,
): Promise<MockupBackground> {
  const bitmap = await createImageBitmap(blob)
  return {
    name,
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
  }
}
