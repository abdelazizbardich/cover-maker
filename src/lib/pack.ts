export type SourceImage = {
  name: string
  file: File
  bitmap: ImageBitmap
  width: number
  height: number
}

export type PackedRect = {
  name: string
  bitmap: ImageBitmap
  x: number
  y: number
  width: number
  height: number
}

export type PackMode = 'rows' | 'grid'

export type PackOptions = {
  canvasWidth: number
  canvasHeight: number
  gap: number
  margin: number
  background: string
  /** rows = sticker-sheet (natural aspect); grid = equal squares */
  mode: PackMode
  /** 0 = auto (pick columns that maximize cell size) — grid mode only */
  columns: number
  /**
   * 0 = auto.
   * rows mode → target row height in px.
   * grid mode → square cell size in px.
   */
  itemSize: number
}

export type PackResult = {
  items: PackedRect[]
  cellSize: number
  columns: number
  rows: number
  usedHeight: number
  mode: PackMode
  /** @deprecated alias of cellSize */
  scale: number
}

/** Natural sort so 2.png comes before 10.png and A before B. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** Scale image to fit inside a box (object-fit: contain), centered. */
export function fitContain(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
): { x: number; y: number; width: number; height: number } {
  if (srcW <= 0 || srcH <= 0 || boxW <= 0 || boxH <= 0) {
    return { x: 0, y: 0, width: boxW, height: boxH }
  }
  const s = Math.min(boxW / srcW, boxH / srcH)
  const width = srcW * s
  const height = srcH * s
  return {
    x: (boxW - width) / 2,
    y: (boxH - height) / 2,
    width,
    height,
  }
}

export function isBitmapLive(bitmap: ImageBitmap): boolean {
  try {
    return bitmap.width > 0 && bitmap.height > 0
  } catch {
    return false
  }
}

export function drawPackedItem(
  ctx: CanvasRenderingContext2D,
  item: PackedRect,
): void {
  if (!isBitmapLive(item.bitmap)) return
  try {
    const fit = fitContain(
      item.bitmap.width,
      item.bitmap.height,
      item.width,
      item.height,
    )
    ctx.drawImage(
      item.bitmap,
      item.x + fit.x,
      item.y + fit.y,
      fit.width,
      fit.height,
    )
  } catch {
    // ImageBitmap may have been closed between the live check and draw
  }
}

export function closeBitmaps(sources: SourceImage[]): void {
  for (const s of sources) {
    try {
      s.bitmap.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Sticker-sheet packer: rows fill the full inner width and the stack fills
 * the full inner height (aspect ratios preserved; extra room becomes spacing).
 */
function packRows(
  sources: SourceImage[],
  options: PackOptions,
): PackResult | null {
  const { canvasWidth, canvasHeight, gap, margin, itemSize: rowHeightOpt } =
    options
  const innerW = canvasWidth - margin * 2
  const innerH = canvasHeight - margin * 2
  if (innerW <= 0 || innerH <= 0 || sources.length === 0) return null

  /** Greedy shelf partition at a trial height (only decides row membership). */
  const buildRows = (trialH: number): SourceImage[][] | null => {
    if (trialH < 8) return null
    const rows: SourceImage[][] = []
    let current: SourceImage[] = []
    let x = 0

    for (const src of sources) {
      const w = (src.width / src.height) * trialH
      if (w > innerW) return null
      if (current.length > 0 && x + w > innerW) {
        rows.push(current)
        current = []
        x = 0
      }
      current.push(src)
      x += w + gap
    }
    if (current.length > 0) rows.push(current)
    return rows
  }

  type LaidOut = { result: PackResult; waste: number }

  /**
   * Layout a partition so equal row heights fill `innerH` and each row spans
   * `innerW` (flex gaps between stickers; aspect ratios preserved).
   */
  const layoutPartition = (
    rows: SourceImage[][],
    baseRowH: number,
  ): LaidOut | null => {
    const R = rows.length
    if (R < 1) return null

    const gapTotal = gap * Math.max(0, R - 1)
    const rowH = (innerH - gapTotal) / R
    if (rowH < 8) return null

    const items: PackedRect[] = []
    let maxCols = 0
    let y = 0
    let waste = 0

    for (let r = 0; r < R; r++) {
      const row = rows[r]
      maxCols = Math.max(maxCols, row.length)

      const sized = row.map((src) => {
        const height = rowH
        const width = (src.width / src.height) * height
        return { src, width, height }
      })

      const rawW = sized.reduce((s, it) => s + it.width, 0)
      const minGaps = gap * Math.max(0, sized.length - 1)

      if (rawW + minGaps > innerW + 0.5) return null

      const free = innerW - rawW - minGaps
      waste += free

      if (sized.length === 1) {
        const it = sized[0]
        // Grow toward full width without exceeding the row band height
        const scale = Math.min(innerW / it.width, 1)
        const width = it.width * scale
        const height = it.height * scale
        items.push({
          name: it.src.name,
          bitmap: it.src.bitmap,
          x: margin + (innerW - width) / 2,
          y: margin + y + (rowH - height) / 2,
          width,
          height,
        })
      } else {
        // Only flex gaps when the row is nearly full — otherwise left-align
        // so a short last row doesn't leave huge empty gaps between stickers.
        const filled = (rawW + minGaps) / innerW
        const useFlex = filled >= 0.72
        let x = 0
        const stepGap = useFlex ? gap + free / (sized.length - 1) : gap
        for (let i = 0; i < sized.length; i++) {
          const it = sized[i]
          let width = it.width
          if (useFlex && i === sized.length - 1) {
            width = Math.max(1, innerW - x)
          }
          items.push({
            name: it.src.name,
            bitmap: it.src.bitmap,
            x: margin + x,
            y: margin + y,
            width,
            height: it.height,
          })
          x += width + stepGap
        }
      }

      y += rowH
      if (r < R - 1) y += gap
    }

    return {
      waste,
      result: {
        items,
        cellSize: baseRowH || rowH,
        columns: maxCols,
        rows: R,
        usedHeight: margin * 2 + innerH,
        mode: 'rows',
        scale: rowH,
      },
    }
  }

  const tryTrial = (trialH: number): LaidOut | null => {
    const rows = buildRows(trialH)
    if (!rows) return null
    return layoutPartition(rows, trialH)
  }

  if (rowHeightOpt > 0) {
    const fixed = tryTrial(rowHeightOpt)
    if (fixed) return fixed.result
  }

  let lo = 8
  let hi = Math.min(
    innerH,
    ...sources.map((s) => (innerW / s.width) * s.height),
  )
  if (!Number.isFinite(hi) || hi < lo) hi = innerH

  let bestResult: PackResult | null = null
  let bestWaste = Infinity
  let bestRows = 0

  const consider = (attempt: LaidOut | null) => {
    if (!attempt) return
    const betterWaste = attempt.waste < bestWaste - 0.5
    const tieMoreRows =
      Math.abs(attempt.waste - bestWaste) <= 0.5 &&
      attempt.result.rows > bestRows
    if (!bestResult || betterWaste || tieMoreRows) {
      bestResult = attempt.result
      bestWaste = attempt.waste
      bestRows = attempt.result.rows
    }
  }

  const samples = 64
  for (let i = 0; i <= samples; i++) {
    consider(tryTrial(lo + ((hi - lo) * i) / samples))
  }

  let blo = lo
  let bhi = hi
  for (let i = 0; i < 28; i++) {
    const mid = (blo + bhi) / 2
    const attempt = tryTrial(mid)
    if (attempt) {
      consider(attempt)
      blo = mid
    } else {
      bhi = mid
    }
  }

  return bestResult
}

/**
 * Full-bleed grid packer: cells fill the entire inner canvas (no unused margins).
 * PNGs are letterboxed inside equal cells via fitContain when drawn.
 */
function packGrid(
  sources: SourceImage[],
  options: PackOptions,
): PackResult | null {
  const {
    canvasWidth,
    canvasHeight,
    gap,
    margin,
    columns: columnsOpt,
    itemSize: itemSizeOpt,
  } = options
  const innerW = canvasWidth - margin * 2
  const innerH = canvasHeight - margin * 2
  const n = sources.length

  if (innerW <= 0 || innerH <= 0 || n < 1) return null

  let columns = 0

  if (itemSizeOpt > 0) {
    if (columnsOpt > 0) {
      columns = Math.min(n, Math.max(1, Math.round(columnsOpt)))
    } else {
      columns = Math.max(
        1,
        Math.min(n, Math.floor((innerW + gap) / (itemSizeOpt + gap))),
      )
    }
  } else {
    let bestCols = 1
    let bestScore = -1
    const candidates: number[] =
      columnsOpt > 0
        ? [Math.min(n, Math.max(1, Math.round(columnsOpt)))]
        : Array.from({ length: n }, (_, i) => i + 1)

    for (const cols of candidates) {
      const rows = Math.ceil(n / cols)
      const cellW = (innerW - gap * (cols - 1)) / cols
      const cellH = (innerH - gap * (rows - 1)) / rows
      if (cellW < 8 || cellH < 8) continue
      const cell = Math.min(cellW, cellH)
      // Prefer fuller last rows so we don't leave a sparse strip of empties
      const rem = n % cols
      const fillBonus = rem === 0 ? cell * 0.12 : (rem / cols) * cell * 0.08
      const score = cell + fillBonus
      if (score > bestScore) {
        bestScore = score
        bestCols = cols
      }
    }
    columns = bestCols
  }

  if (columns < 1) return null

  const rows = Math.ceil(n / columns)
  const cellW = (innerW - gap * Math.max(0, columns - 1)) / columns
  const cellH = (innerH - gap * Math.max(0, rows - 1)) / rows
  if (cellW < 1 || cellH < 1) return null

  const cellSize = Math.min(cellW, cellH)
  const originX = margin
  const originY = margin
  const rem = n % columns
  const lastRowCount = rem === 0 ? columns : rem

  const items: PackedRect[] = sources.map((src, i) => {
    const col = i % columns
    const row = Math.floor(i / columns)
    const isLastRow = row === rows - 1 && lastRowCount < columns
    const colsInRow = isLastRow ? lastRowCount : columns
    const rowCellW = isLastRow
      ? (innerW - gap * Math.max(0, colsInRow - 1)) / colsInRow
      : cellW
    return {
      name: src.name,
      bitmap: src.bitmap,
      x: originX + col * (rowCellW + gap),
      y: originY + row * (cellH + gap),
      width: rowCellW,
      height: cellH,
    }
  })

  return {
    items,
    cellSize,
    columns,
    rows,
    usedHeight: canvasHeight,
    mode: 'grid',
    scale: cellSize,
  }
}

export function packImages(
  sources: SourceImage[],
  options: PackOptions,
): PackResult | null {
  if (sources.length === 0) return null
  if (options.mode === 'grid') return packGrid(sources, options)
  return packRows(sources, options)
}

type Rect = { x: number; y: number; width: number; height: number }

/**
 * Place `others` in dense grids in the bands around a featured hero sticker.
 * Each usable band (top / bottom / left / right) is filled edge-to-edge.
 */
export function packAroundFeatured(
  others: SourceImage[],
  options: PackOptions,
  featured: Rect,
): PackedRect[] {
  if (others.length === 0) return []

  const { canvasWidth, canvasHeight, gap, margin, background } = options
  const inner: Rect = {
    x: margin,
    y: margin,
    width: canvasWidth - margin * 2,
    height: canvasHeight - margin * 2,
  }
  if (inner.width < 8 || inner.height < 8) return []

  const obstacle: Rect = {
    x: Math.max(inner.x, featured.x - gap / 2),
    y: Math.max(inner.y, featured.y - gap / 2),
    width: Math.min(
      featured.width + gap,
      inner.x + inner.width - Math.max(inner.x, featured.x - gap / 2),
    ),
    height: Math.min(
      featured.height + gap,
      inner.y + inner.height - Math.max(inner.y, featured.y - gap / 2),
    ),
  }

  const minBand = 24
  const candidates: Rect[] = [
    {
      // top
      x: inner.x,
      y: inner.y,
      width: inner.width,
      height: Math.max(0, obstacle.y - inner.y),
    },
    {
      // bottom
      x: inner.x,
      y: obstacle.y + obstacle.height,
      width: inner.width,
      height: Math.max(
        0,
        inner.y + inner.height - (obstacle.y + obstacle.height),
      ),
    },
    {
      // left (middle band only)
      x: inner.x,
      y: obstacle.y,
      width: Math.max(0, obstacle.x - inner.x),
      height: obstacle.height,
    },
    {
      // right (middle band only)
      x: obstacle.x + obstacle.width,
      y: obstacle.y,
      width: Math.max(
        0,
        inner.x + inner.width - (obstacle.x + obstacle.width),
      ),
      height: obstacle.height,
    },
  ]

  const bands = candidates.filter(
    (b) => b.width >= minBand && b.height >= minBand,
  )
  if (bands.length === 0) return []

  const areas = bands.map((b) => b.width * b.height)
  const totalArea = areas.reduce((s, a) => s + a, 0)
  const n = others.length

  // Allocate counts proportional to area; largest remainder → exact sum n
  const raw = areas.map((a) => (a / totalArea) * n)
  const counts = raw.map((r) => Math.floor(r))
  let assigned = counts.reduce((s, c) => s + c, 0)
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; assigned < n && k < order.length; k++) {
    counts[order[k].i]++
    assigned++
  }

  const bandOpts = (band: Rect): PackOptions => ({
    canvasWidth: Math.max(1, Math.round(band.width)),
    canvasHeight: Math.max(1, Math.round(band.height)),
    gap,
    margin: 0,
    background,
    mode: 'grid',
    columns: 0,
    itemSize: 0,
  })

  const placed: PackedRect[] = []
  let cursor = 0
  for (let bi = 0; bi < bands.length; bi++) {
    const count = counts[bi]
    if (count <= 0) continue
    const slice = others.slice(cursor, cursor + count)
    cursor += count
    const band = bands[bi]
    const packed = packGrid(slice, bandOpts(band))
    if (!packed) continue
    for (const it of packed.items) {
      const width = Math.max(1, Math.round(it.width))
      const height = Math.max(1, Math.round(it.height))
      let x = Math.round(band.x + it.x)
      let y = Math.round(band.y + it.y)
      // Keep every sticker fully inside the canvas (no edge cropping)
      x = Math.max(0, Math.min(x, canvasWidth - width))
      y = Math.max(0, Math.min(y, canvasHeight - height))
      placed.push({
        ...it,
        x,
        y,
        width,
        height,
      })
    }
  }

  return placed
}

export type ExportFormat = 'image/jpeg' | 'image/png'

export async function renderCover(
  result: PackResult,
  options: PackOptions,
  exportOpts: { format?: ExportFormat; quality?: number } = {},
): Promise<Blob> {
  const format = exportOpts.format ?? 'image/jpeg'
  const quality = exportOpts.quality ?? 0.88

  const canvas = document.createElement('canvas')
  canvas.width = options.canvasWidth
  canvas.height = options.canvasHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')

  // Always paint an opaque fill first — Etsy turns transparency black
  ctx.fillStyle = options.background || '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  for (const item of result.items) {
    drawPackedItem(ctx, item)
  }

  return new Promise((resolve, reject) => {
    const done = (blob: Blob | null) =>
      blob ? resolve(blob) : reject(new Error('Export failed'))
    if (format === 'image/jpeg') {
      canvas.toBlob(done, format, quality)
    } else {
      canvas.toBlob(done, format)
    }
  })
}

/** Crop fully transparent padding so packing uses the visible sticker bounds. */
async function trimTransparent(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const w = bitmap.width
  const h = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return bitmap

  ctx.drawImage(bitmap, 0, 0)
  const { data } = ctx.getImageData(0, 0, w, h)

  let top = h
  let left = w
  let right = 0
  let bottom = 0
  let found = false

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        found = true
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }

  if (!found) return bitmap

  const tw = right - left + 1
  const th = bottom - top + 1
  if (tw >= w && th >= h) return bitmap

  const trimmed = await createImageBitmap(bitmap, left, top, tw, th)
  bitmap.close()
  return trimmed
}

export async function loadPngFiles(files: FileList | File[]): Promise<SourceImage[]> {
  const list = Array.from(files).filter(
    (f) =>
      f.type === 'image/png' ||
      f.name.toLowerCase().endsWith('.png'),
  )

  list.sort((a, b) => naturalCompare(a.name, b.name))

  const sources: SourceImage[] = []
  for (const file of list) {
    let bitmap = await createImageBitmap(file)
    bitmap = await trimTransparent(bitmap)
    sources.push({
      name: file.name,
      file,
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
    })
  }
  return sources
}
