import { isBitmapLive, type PackedRect, drawPackedItem } from './pack'
import type { MockupBackground, MockupLayer } from './mockup'

/** Etsy listing videos: 3–15s, ≤100MB, ideal ≥1080px, MP4. */
export const ETSY_VIDEO_MIN_SEC = 3
export const ETSY_VIDEO_MAX_SEC = 15
export const ETSY_VIDEO_TARGET_SEC = 12
export const ETSY_VIDEO_MAX_EDGE = 1080

export type VideoSlideSource =
  | {
      kind: 'cover'
      width: number
      height: number
      background: string
      items: PackedRect[]
    }
  | {
      kind: 'mockup'
      bg: MockupBackground
      layer: MockupLayer
    }

function pickRecorderMime(): string {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  for (const type of candidates) {
    if (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported(type)
    ) {
      return type
    }
  }
  return 'video/webm'
}

export function videoFileExtension(mime: string): 'mp4' | 'webm' {
  return mime.includes('mp4') ? 'mp4' : 'webm'
}

/** Fit source into dest with contain + opaque fill. */
function drawContain(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
  fill = '#ffffff',
) {
  ctx.fillStyle = fill
  ctx.fillRect(0, 0, destW, destH)
  const scale = Math.min(destW / srcW, destH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  const x = (destW - w) / 2
  const y = (destH - h) / 2
  ctx.drawImage(source, x, y, w, h)
}

function renderSlideToCanvas(
  slide: VideoSlideSource,
  outW: number,
  outH: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')

  if (slide.kind === 'cover') {
    const src = document.createElement('canvas')
    src.width = slide.width
    src.height = slide.height
    const sctx = src.getContext('2d')
    if (!sctx) throw new Error('Canvas not supported')
    sctx.fillStyle = slide.background || '#ffffff'
    sctx.fillRect(0, 0, slide.width, slide.height)
    for (const item of slide.items) {
      drawPackedItem(sctx, item)
    }
    drawContain(ctx, src, slide.width, slide.height, outW, outH, '#ffffff')
    return canvas
  }

  const { bg, layer } = slide
  const src = document.createElement('canvas')
  src.width = bg.width
  src.height = bg.height
  const sctx = src.getContext('2d')
  if (!sctx) throw new Error('Canvas not supported')
  sctx.drawImage(bg.bitmap, 0, 0, bg.width, bg.height)
  if (isBitmapLive(layer.bitmap)) {
    try {
      sctx.drawImage(layer.bitmap, layer.x, layer.y, layer.width, layer.height)
    } catch {
      /* detached */
    }
  }
  drawContain(ctx, src, bg.width, bg.height, outW, outH, '#ffffff')
  return canvas
}

/** Split total duration evenly across slides (order is caller-controlled). */
export function slideDurationsMs(
  slideCount: number,
  totalSec = ETSY_VIDEO_TARGET_SEC,
): number[] {
  const n = Math.max(1, slideCount)
  const total = Math.min(
    ETSY_VIDEO_MAX_SEC,
    Math.max(ETSY_VIDEO_MIN_SEC, totalSec),
  )
  const totalMs = Math.round(total * 1000)

  if (n === 1) return [totalMs]

  const each = Math.floor(totalMs / n)
  const durations = Array.from({ length: n }, () => each)
  durations[durations.length - 1] += totalMs - each * n
  return durations
}

export function pickOutputSize(
  srcW: number,
  srcH: number,
  maxEdge = ETSY_VIDEO_MAX_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH))
  return {
    width: Math.max(500, Math.round(srcW * scale)),
    height: Math.max(500, Math.round(srcH * scale)),
  }
}

/**
 * Record an Etsy listing video from ordered slides.
 * Uses MediaRecorder (MP4 when the browser supports it, else WebM).
 */
export async function exportEtsyListingVideo(
  slides: VideoSlideSource[],
  opts?: {
    totalSec?: number
    fps?: number
    onProgress?: (ratio: number) => void
  },
): Promise<{ blob: Blob; mimeType: string; durationSec: number }> {
  if (slides.length === 0) {
    throw new Error('Add a cover (and optionally mockups) before making a video.')
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser cannot record video. Try Chrome or Edge.')
  }

  const first = slides[0]
  const srcW =
    first.kind === 'cover' ? first.width : first.bg.width
  const srcH =
    first.kind === 'cover' ? first.height : first.bg.height
  const { width: outW, height: outH } = pickOutputSize(srcW, srcH)

  const durations = slideDurationsMs(slides.length, opts?.totalSec)
  const totalMs = durations.reduce((a, b) => a + b, 0)
  const fps = opts?.fps ?? 30
  const frameMs = 1000 / fps

  const frames = slides.map((slide) => renderSlideToCanvas(slide, outW, outH))

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')

  // Seed first frame before captureStream so the recorder has content
  ctx.drawImage(frames[0], 0, 0)

  const stream = canvas.captureStream(fps)
  const mimeType = pickRecorderMime()
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 5_000_000,
  })

  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('Video recording failed'))
    recorder.onstop = () => {
      for (const t of stream.getTracks()) t.stop()
      resolve(new Blob(chunks, { type: mimeType }))
    }
  })

  recorder.start(200)

  let elapsed = 0
  let slideIndex = 0
  let slideElapsed = 0

  await new Promise<void>((resolve) => {
    const tick = () => {
      if (slideIndex >= frames.length) {
        opts?.onProgress?.(1)
        resolve()
        return
      }

      ctx.drawImage(frames[slideIndex], 0, 0)
      slideElapsed += frameMs
      elapsed += frameMs
      opts?.onProgress?.(Math.min(0.99, elapsed / totalMs))

      if (slideElapsed >= durations[slideIndex]) {
        slideElapsed = 0
        slideIndex += 1
      }

      if (slideIndex >= frames.length) {
        opts?.onProgress?.(1)
        resolve()
        return
      }

      window.setTimeout(tick, frameMs)
    }
    tick()
  })

  // Hold last frame a beat so the recorder flushes cleanly
  await new Promise((r) => setTimeout(r, 120))
  if (recorder.state !== 'inactive') recorder.stop()

  const blob = await stopped
  return {
    blob,
    mimeType,
    durationSec: totalMs / 1000,
  }
}
