/** Etsy listing image rules the cover maker must respect. */

export const ETSY_MIN_SHORT_SIDE = 2000
export const ETSY_SEARCH_MIN = 635
/** Etsy warns uploads over ~1MB can fail on slow connections. */
export const ETSY_TARGET_MAX_BYTES = 1_000_000

export type EtsyOrientation = 'square' | 'landscape' | 'portrait'

export type EtsyCheck = {
  ok: boolean
  shortSide: number
  orientation: EtsyOrientation
  /** Safe for the first listing photo (square or landscape). */
  primarySafe: boolean
  meetsRecommendedSize: boolean
  opaqueBackground: boolean
  issues: string[]
  tips: string[]
}

export function orientationOf(w: number, h: number): EtsyOrientation {
  if (w === h) return 'square'
  if (w > h) return 'landscape'
  return 'portrait'
}

export function checkEtsyReady(opts: {
  width: number
  height: number
  background: string
}): EtsyCheck {
  const { width, height, background } = opts
  const shortSide = Math.min(width, height)
  const orientation = orientationOf(width, height)
  const primarySafe = orientation !== 'portrait'
  const meetsRecommendedSize = shortSide >= ETSY_MIN_SHORT_SIDE
  const opaqueBackground = !isTransparentColor(background)

  const issues: string[] = []
  const tips: string[] = []

  if (shortSide < ETSY_SEARCH_MIN) {
    issues.push(
      `Too small for search (${shortSide}px). First photo needs at least ${ETSY_SEARCH_MIN}px.`,
    )
  } else if (!meetsRecommendedSize) {
    issues.push(
      `Short side is ${shortSide}px — Etsy recommends ≥${ETSY_MIN_SHORT_SIDE}px for sharp zoom.`,
    )
  }

  if (!primarySafe) {
    issues.push(
      'Portrait orientation — Etsy wants the 1st listing photo square or landscape.',
    )
    tips.push('Use this as a gallery image (#2+), not your main thumbnail.')
  }

  if (!opaqueBackground) {
    issues.push(
      'Transparent backgrounds turn black on Etsy. Use a solid white (or color) fill.',
    )
  }

  if (meetsRecommendedSize && primarySafe && opaqueBackground) {
    tips.push('Ready for a primary listing photo.')
  }

  tips.push('Export JPG under ~1MB for reliable uploads.')

  return {
    ok: issues.length === 0,
    shortSide,
    orientation,
    primarySafe,
    meetsRecommendedSize,
    opaqueBackground,
    issues,
    tips,
  }
}

function isTransparentColor(color: string): boolean {
  const c = color.trim().toLowerCase()
  if (c === 'transparent') return true
  if (c.startsWith('rgba')) {
    const m = c.match(/rgba?\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)/)
    if (m && Number(m[1]) < 1) return true
  }
  if (c.length === 9 && c.startsWith('#') && c.endsWith('00')) return true
  return false
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
