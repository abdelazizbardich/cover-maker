import {
  clampListingCopy,
  LISTING_FREE_QUOTA,
  type ListingCopyResult,
} from './listingLimits'
import type { PackedRect, PackOptions, PackResult, SourceImage } from './pack'
import { isBitmapLive, renderCover } from './pack'

export type ListingImagePayload = {
  mimeType: 'image/jpeg' | 'image/png'
  /** Raw base64 without data: URL prefix */
  base64: string
}

export type ListingCopyRequestBody = {
  cover: ListingImagePayload
  designs: ListingImagePayload[]
  referenceText: string
  guidelines: string
  listingSubject: string
  userApiKey?: string
}

export type ListingCopyApiResponse = {
  title: string
  description: string
  tags: string[]
  needsListingName: boolean
  subjectGuess?: string | null
  freeRemaining: number
  error?: string
  code?: string
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function bitmapToJpeg(
  bitmap: ImageBitmap,
  maxEdge: number,
  quality: number,
): Promise<ListingImagePayload> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))),
      'image/jpeg',
      quality,
    )
  })
  return { mimeType: 'image/jpeg', base64: await blobToBase64(blob) }
}

/** Downscale a cover JPEG blob for the vision API. */
export async function coverBlobToPayload(
  blob: Blob,
  maxEdge = 1024,
): Promise<ListingImagePayload> {
  const bitmap = await createImageBitmap(blob)
  try {
    return await bitmapToJpeg(bitmap, maxEdge, 0.72)
  } finally {
    bitmap.close()
  }
}

export async function buildCoverPayload(
  items: PackedRect[],
  options: PackOptions,
): Promise<ListingImagePayload> {
  const packResult: PackResult = {
    items,
    cellSize: 0,
    columns: 0,
    rows: 0,
    usedHeight: options.canvasHeight,
    mode: options.mode,
    scale: 0,
  }
  const blob = await renderCover(packResult, options, {
    format: 'image/jpeg',
    quality: 0.82,
  })
  return coverBlobToPayload(blob, 1024)
}

export async function buildDesignPayloads(
  sources: SourceImage[],
  maxDesigns = 8,
): Promise<ListingImagePayload[]> {
  const picks = sources.slice(0, maxDesigns)
  const out: ListingImagePayload[] = []
  for (const src of picks) {
    if (!isBitmapLive(src.bitmap)) continue
    out.push(await bitmapToJpeg(src.bitmap, 512, 0.7))
  }
  return out
}

export async function requestListingCopy(
  body: ListingCopyRequestBody,
): Promise<ListingCopyApiResponse> {
  const res = await fetch('/api/listing-copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })

  let data: ListingCopyApiResponse
  try {
    data = (await res.json()) as ListingCopyApiResponse
  } catch {
    throw new Error('Listing AI returned an invalid response.')
  }

  if (!res.ok) {
    const err = new Error(data.error || `Listing AI failed (${res.status})`)
    ;(err as Error & { code?: string; freeRemaining?: number }).code = data.code
    ;(err as Error & { freeRemaining?: number }).freeRemaining =
      data.freeRemaining
    throw err
  }

  if (typeof data.freeRemaining !== 'number') {
    data.freeRemaining = LISTING_FREE_QUOTA
  }

  if (!data.needsListingName) {
    const clamped = clampListingCopy({
      title: data.title ?? '',
      description: data.description ?? '',
      tags: Array.isArray(data.tags) ? data.tags : [],
    })
    data.title = clamped.title
    data.description = clamped.description
    data.tags = clamped.tags
  }

  return data
}

export function emptyListingCopy(): ListingCopyResult {
  return { title: '', description: '', tags: [] }
}
