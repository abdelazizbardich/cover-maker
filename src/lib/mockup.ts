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

/** Default placement: centered, ~28% of mockup short side. */
export function defaultLayerPlacement(
  bg: MockupBackground,
  design: { width: number; height: number; name: string; bitmap: ImageBitmap },
): MockupLayer {
  const target = Math.min(bg.width, bg.height) * 0.28
  const scale = Math.min(target / design.width, target / design.height)
  const width = design.width * scale
  const height = design.height * scale
  return {
    name: design.name,
    bitmap: design.bitmap,
    x: (bg.width - width) / 2,
    y: (bg.height - height) / 2 - bg.height * 0.04,
    width,
    height,
  }
}

/** Paint one mockup: background + a single design (each tagged PNG = its own mockup). */
export function paintUserMockup(
  canvas: HTMLCanvasElement,
  bg: MockupBackground,
  layer: MockupLayer | null,
  showHandles = true,
) {
  canvas.width = bg.width
  canvas.height = bg.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.drawImage(bg.bitmap, 0, 0, bg.width, bg.height)

  if (!layer || !isBitmapLive(layer.bitmap)) return

  try {
    ctx.drawImage(layer.bitmap, layer.x, layer.y, layer.width, layer.height)
  } catch {
    return
  }

  if (!showHandles) return

  const pad = Math.max(4, Math.min(layer.width, layer.height) * 0.02)
  const lw = Math.max(2, bg.width / 500)
  const r = Math.max(14, Math.min(layer.width, layer.height) * 0.08, bg.width / 120)
  ctx.save()
  ctx.strokeStyle = '#1ec8d4'
  ctx.lineWidth = lw
  ctx.setLineDash([bg.width / 80, bg.width / 120])
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
    ctx.lineWidth = lw
    ctx.beginPath()
    ctx.rect(c.x - r / 2, c.y - r / 2, r, r)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#1ec8d4'
    ctx.fillRect(c.x - r / 4, c.y - r / 4, r / 2, r / 2)
  }
  ctx.restore()
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

/** Export every tagged design as its own mockup file. */
export async function exportAllMockups(
  bg: MockupBackground,
  layers: MockupLayer[],
  quality = 0.9,
): Promise<number> {
  let n = 0
  for (const layer of layers) {
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
