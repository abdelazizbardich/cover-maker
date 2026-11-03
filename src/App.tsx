import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { collectPngsFromDrop } from './lib/dropFiles'
import {
  checkEtsyReady,
  ETSY_MIN_SHORT_SIDE,
  ETSY_TARGET_MAX_BYTES,
  formatBytes,
} from './lib/etsy'
import {
  defaultLayerPlacement,
  downloadBlob,
  exportAllMockups,
  exportUserMockup,
  loadMockupBackground,
  loadMockupBackgroundFromBlob,
  paintUserMockup,
  resizeLayerFromCorner,
  sizeFromHeight,
  sizeFromWidth,
  type MockupBackground,
  type MockupLayer,
  type MockupSizeLimits,
} from './lib/mockup'
import {
  clearDefaultMockup,
  loadDefaultMockup,
  saveDefaultMockup,
} from './lib/mockupStore'
import {
  buildCoverPayload,
  buildDesignPayloads,
  emptyListingCopy,
  requestListingCopy,
} from './lib/listingCopy'
import {
  ETSY_TAG_CHAR_MAX,
  ETSY_TAG_MAX,
  ETSY_TITLE_MAX,
  LISTING_FREE_QUOTA,
  clampTitle,
  listingCopyPlainText,
  normalizeTags,
  type ListingCopyResult,
} from './lib/listingLimits'
import {
  loadListingCopyPrefs,
  saveListingCopyPrefs,
} from './lib/listingCopyStore'
import {
  ETSY_VIDEO_MAX_SEC,
  ETSY_VIDEO_MIN_SEC,
  ETSY_VIDEO_TARGET_SEC,
  exportEtsyListingVideo,
  videoFileExtension,
  type VideoSlideSource,
} from './lib/video'

/** Clip id in the listing video timeline: cover sheet or a mockup by PNG name. */
type VideoClipId = 'cover' | `mockup:${string}`

import {
  closeBitmaps,
  drawPackedItem,
  isBitmapLive,
  loadPngFiles,
  packAroundFeatured,
  packImages,
  renderCover,
  type ExportFormat,
  type PackMode,
  type PackOptions,
  type PackedRect,
  type SourceImage,
} from './lib/pack'
import './App.css'

/** Split PNGs into cover sheets. `perCover <= 0` = all on one cover. */
function chunkSourcesForCovers(
  srcs: SourceImage[],
  perCover: number,
): SourceImage[][] {
  if (srcs.length === 0) return []
  const size =
    perCover <= 0 ? srcs.length : Math.max(1, Math.floor(perCover))
  const pages: SourceImage[][] = []
  for (let i = 0; i < srcs.length; i += size) {
    pages.push(srcs.slice(i, i + size))
  }
  return pages
}

/** Survives React Strict Mode remounts so demo PNGs are not loaded twice. */
let demoBootstrapped = false

function ItemThumb({ bitmap, name }: { bitmap: ImageBitmap; name: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node || !isBitmapLive(bitmap)) return
    const tw = 36
    const th = 36
    node.width = tw
    node.height = th
    const c = node.getContext('2d')
    if (!c) return
    c.clearRect(0, 0, tw, th)
    try {
      const scaleT = Math.min(tw / bitmap.width, th / bitmap.height)
      const dw = bitmap.width * scaleT
      const dh = bitmap.height * scaleT
      c.drawImage(bitmap, (tw - dw) / 2, (th - dh) / 2, dw, dh)
    } catch {
      /* detached */
    }
  }, [bitmap, name])

  return <canvas ref={ref} width={36} height={36} />
}

/** Etsy-recommended listing sizes only (short side ≥ 2000; 1st photo square/landscape). */
const PRESETS = [
  { label: '3000 × 3000', w: 3000, h: 3000, tip: 'Best zoom' },
  { label: '2000 × 2000', w: 2000, h: 2000, tip: 'Minimum rec.' },
  { label: '2700 × 2025', w: 2700, h: 2025, tip: '4:3 landscape' },
] as const

type PlacedItem = PackedRect & { id: string }

type Corner = 'nw' | 'ne' | 'sw' | 'se'

type DragState =
  | { mode: 'move'; id: string; offsetX: number; offsetY: number }
  | {
      mode: 'resize'
      id: string
      corner: Corner
      anchorX: number
      anchorY: number
    }

function hitTest(items: PlacedItem[], x: number, y: number): PlacedItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (x >= it.x && x <= it.x + it.width && y >= it.y && y <= it.y + it.height) {
      return it
    }
  }
  return null
}

function handleRadius(item: PlacedItem, canvasWidth: number): number {
  return Math.max(14, Math.min(item.width, item.height) * 0.08, canvasWidth / 120)
}

function cornerPoints(item: PlacedItem): Record<Corner, { x: number; y: number }> {
  return {
    nw: { x: item.x, y: item.y },
    ne: { x: item.x + item.width, y: item.y },
    sw: { x: item.x, y: item.y + item.height },
    se: { x: item.x + item.width, y: item.y + item.height },
  }
}

function hitCorner(
  item: PlacedItem,
  x: number,
  y: number,
  canvasWidth: number,
  /** canvas.cssPx → multiply screen hit target into canvas space */
  displayScale = 1,
): Corner | null {
  // At least ~22px on screen so handles stay grabable on large mockup photos
  const r = Math.max(handleRadius(item, canvasWidth), 22 * displayScale)
  const corners = cornerPoints(item)
  for (const key of Object.keys(corners) as Corner[]) {
    const c = corners[key]
    if (Math.hypot(x - c.x, y - c.y) <= r) return key
  }
  return null
}

function canvasDisplayScale(canvas: HTMLCanvasElement): number {
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0) return 1
  return canvas.width / rect.width
}

function resizeFromCorner(
  item: PlacedItem,
  corner: Corner,
  ptX: number,
  ptY: number,
  sizeMin: number,
  sizeMax: number,
): { x: number; y: number; width: number; height: number } {
  let size: number
  if (corner === 'se') {
    size = Math.max(ptX - item.x, ptY - item.y)
  } else if (corner === 'sw') {
    size = Math.max(item.x + item.width - ptX, ptY - item.y)
  } else if (corner === 'ne') {
    size = Math.max(ptX - item.x, item.y + item.height - ptY)
  } else {
    size = Math.max(item.x + item.width - ptX, item.y + item.height - ptY)
  }

  size = Math.max(sizeMin, Math.min(sizeMax, Math.round(size)))

  // Keep the opposite corner fixed
  if (corner === 'se') {
    return { x: item.x, y: item.y, width: size, height: size }
  }
  if (corner === 'sw') {
    return {
      x: item.x + item.width - size,
      y: item.y,
      width: size,
      height: size,
    }
  }
  if (corner === 'ne') {
    return {
      x: item.x,
      y: item.y + item.height - size,
      width: size,
      height: size,
    }
  }
  return {
    x: item.x + item.width - size,
    y: item.y + item.height - size,
    width: size,
    height: size,
  }
}

function canvasPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  const sx = canvas.width / rect.width
  const sy = canvas.height / rect.height
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  }
}

function App() {
  const folderInputId = useId()
  const fileInputId = useId()
  const folderRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const mockupRef = useRef<HTMLCanvasElement>(null)
  const mockupFileRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const itemsRef = useRef<PlacedItem[]>([])
  const mockupLayersRef = useRef<MockupLayer[]>([])
  const sourcesRef = useRef<SourceImage[]>([])
  const loadGenRef = useRef(0)
  const ingestRef = useRef<(files: FileList | File[]) => Promise<void>>(
    async () => {},
  )

  const [sources, setSources] = useState<SourceImage[]>([])
  const [items, setItems] = useState<PlacedItem[]>([])
  const [cellSize, setCellSize] = useState(0)
  const [gridCols, setGridCols] = useState(0)
  const [gridRows, setGridRows] = useState(0)
  const [manualLayout, setManualLayout] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  /** Floating context menu for the selected cover PNG (screen coords). */
  const [coverCtxMenu, setCoverCtxMenu] = useState<{
    id: string
    x: number
    y: number
  } | null>(null)
  const coverCtxMenuRef = useRef<HTMLDivElement>(null)
  const coverDragMovedRef = useRef(false)

  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportingMockup, setExportingMockup] = useState(false)
  const [exportingVideo, setExportingVideo] = useState(false)
  const [videoProgress, setVideoProgress] = useState(0)
  const [videoDurationSec, setVideoDurationSec] = useState(ETSY_VIDEO_TARGET_SEC)
  const [videoOrder, setVideoOrder] = useState<VideoClipId[]>(['cover'])
  const [exportOpen, setExportOpen] = useState(false)
  const exportCloseRef = useRef<HTMLButtonElement>(null)
  const exportTitleId = useId()
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const [listingRefText, setListingRefText] = useState('')
  const [listingRefName, setListingRefName] = useState<string | null>(null)
  const [listingGuidelines, setListingGuidelines] = useState('')
  const [listingSubject, setListingSubject] = useState('')
  const [listingNeedsName, setListingNeedsName] = useState(false)
  const [listingSubjectGuess, setListingSubjectGuess] = useState<string | null>(
    null,
  )
  const [listingCopy, setListingCopy] = useState<ListingCopyResult>(() =>
    emptyListingCopy(),
  )
  const [listingFreeRemaining, setListingFreeRemaining] =
    useState(LISTING_FREE_QUOTA)
  const [listingUserKey, setListingUserKey] = useState('')
  const [listingRememberKey, setListingRememberKey] = useState(false)
  const [listingShowKey, setListingShowKey] = useState(false)
  const [listingGenerating, setListingGenerating] = useState(false)
  const [listingError, setListingError] = useState<string | null>(null)
  const [listingCopied, setListingCopied] = useState<string | null>(null)
  const listingRefInputRef = useRef<HTMLInputElement>(null)

  const [canvasWidth, setCanvasWidth] = useState(3000)
  const [canvasHeight, setCanvasHeight] = useState(3000)
  const [gap, setGap] = useState(20)
  const [margin, setMargin] = useState(40)
  const [columns, setColumns] = useState(0) // 0 = auto
  /** 0 = auto; rows = row height; grid = cell size */
  const [itemSize, setItemSize] = useState(0)
  const [packMode, setPackMode] = useState<PackMode>('grid')
  const [background, setBackground] = useState('#ffffff')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('image/jpeg')
  const [exportQuality, setExportQuality] = useState(0.88)
  const [lastExportBytes, setLastExportBytes] = useState<number | null>(null)
  /** 0 = all PNGs on one cover; otherwise max designs per cover sheet. */
  const [pngsPerCover, setPngsPerCover] = useState(0)
  const [coverPageIndex, setCoverPageIndex] = useState(0)

  /** Filenames tagged for lifestyle mockups (Etsy gallery photos). */
  const [mockupTags, setMockupTags] = useState<Set<string>>(() => new Set())
  const [viewMode, setViewMode] = useState<'cover' | 'mockup'>('cover')
  const [mockupBg, setMockupBg] = useState<MockupBackground | null>(null)
  /** Optional per-PNG mockup photo (overrides the default for that design). */
  const [customMockupBgs, setCustomMockupBgs] = useState<
    Record<string, MockupBackground>
  >({})
  const [mockupLayers, setMockupLayers] = useState<MockupLayer[]>([])
  const [mockupSelected, setMockupSelected] = useState<string | null>(null)
  const [mockupDrag, setMockupDrag] = useState<DragState | null>(null)
  /** Max design box on the mockup photo (user-controlled). */
  const [mockupMaxWidth, setMockupMaxWidth] = useState(800)
  const [mockupMaxHeight, setMockupMaxHeight] = useState(800)
  const customMockupFileRef = useRef<HTMLInputElement>(null)
  const customMockupBgsRef = useRef(customMockupBgs)
  customMockupBgsRef.current = customMockupBgs

  const etsy = checkEtsyReady({
    width: canvasWidth,
    height: canvasHeight,
    background,
  })

  itemsRef.current = items
  sourcesRef.current = sources
  mockupLayersRef.current = mockupLayers

  const options: PackOptions = {
    canvasWidth,
    canvasHeight,
    gap,
    margin,
    background,
    mode: packMode,
    columns,
    itemSize,
  }

  const coverPages = useMemo(
    () => chunkSourcesForCovers(sources, pngsPerCover),
    [sources, pngsPerCover],
  )
  const coverPageCount = Math.max(1, coverPages.length)
  const safeCoverPageIndex = Math.min(
    coverPageIndex,
    Math.max(0, coverPages.length - 1),
  )
  const currentCoverSources = coverPages[safeCoverPageIndex] ?? []

  useEffect(() => {
    if (coverPageIndex !== safeCoverPageIndex) {
      setCoverPageIndex(safeCoverPageIndex)
    }
  }, [coverPageIndex, safeCoverPageIndex])

  const sizeMax = Math.max(80, Math.floor(Math.min(canvasWidth, canvasHeight) * 0.9))
  const sizeMin = 40
  const mockupSizeMin = 40
  const resolveMockupBg = useCallback(
    (name: string | null | undefined): MockupBackground | null => {
      if (!name) return mockupBg
      return customMockupBgs[name] ?? mockupBg
    },
    [customMockupBgs, mockupBg],
  )
  const taggedItems = sources.filter((s) => mockupTags.has(s.name))
  const activeMockupLayer =
    mockupLayers.find((l) => l.name === mockupSelected) ?? null
  const activeMockupBg = resolveMockupBg(mockupSelected)
  const activeHasCustomBg = Boolean(
    mockupSelected && customMockupBgs[mockupSelected],
  )
  const mockupIndex = activeMockupLayer
    ? mockupLayers.findIndex((l) => l.name === activeMockupLayer.name)
    : -1
  const mockupLimits = useMemo<MockupSizeLimits>(() => {
    const bg = activeMockupBg
    return {
      maxWidth: Math.max(
        mockupSizeMin,
        Math.min(mockupMaxWidth, bg ? bg.width : mockupMaxWidth),
      ),
      maxHeight: Math.max(
        mockupSizeMin,
        Math.min(mockupMaxHeight, bg ? bg.height : mockupMaxHeight),
      ),
      minSide: mockupSizeMin,
    }
  }, [activeMockupBg, mockupMaxWidth, mockupMaxHeight])

  const toggleMockupTag = useCallback((name: string) => {
    let added = false
    setMockupTags((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else {
        next.add(name)
        added = true
      }
      return next
    })
    if (added) {
      // Defer so state from tag add settles; selection switches on next paint via effect too.
      setMockupSelected(name)
      setViewMode('mockup')
      const match = itemsRef.current.find((it) => it.name === name)
      if (match) setSelectedId(match.id)
    }
  }, [])

  /** Replace sources without closing bitmaps inside a setState updater (Strict Mode safe). */
  const replaceSources = useCallback((next: SourceImage[]) => {
    const previous = sourcesRef.current
    sourcesRef.current = next
    setSources(next)
    // Close only the previous generation, after React has committed the new ones
    if (previous.length > 0) {
      const live = new Set(next.map((s) => s.bitmap))
      const stale = previous.filter((s) => !live.has(s.bitmap))
      if (stale.length > 0) {
        requestAnimationFrame(() => closeBitmaps(stale))
      }
    }
  }, [])

  const applyPack = useCallback(
    (srcs: SourceImage[], opts: PackOptions) => {
      const result = packImages(srcs, opts)
      if (!result) {
        setItems([])
        setCellSize(0)
        setGridCols(0)
        setGridRows(0)
        setError('Could not fit all images. Try a larger canvas or smaller gap.')
        return
      }
      setError(null)
      setCellSize(result.cellSize)
      setGridCols(result.columns)
      setGridRows(result.rows)
      setItems(
        result.items.map((it, i) => ({
          ...it,
          id: `${it.name}::${i}`,
        })),
      )
      setManualLayout(false)
      setSelectedId(null)
    },
    [],
  )

  const ingestFiles = useCallback(
    async (files: FileList | File[]) => {
      const gen = ++loadGenRef.current
      setLoading(true)
      setError(null)
      try {
        const loaded = await loadPngFiles(files)
        // A newer upload started while we were decoding
        if (gen !== loadGenRef.current) {
          closeBitmaps(loaded)
          return
        }
        if (loaded.length === 0) {
          setError('No PNG files found. Pick a folder (or files) that contain .png images.')
          setItems([])
          setSelectedId(null)
          replaceSources([])
          return
        }
        // Set sources + packed items together; never close `loaded` bitmaps
        replaceSources(loaded)
        setCoverPageIndex(0)
        setManualLayout(false)
        const pages = chunkSourcesForCovers(loaded, pngsPerCover)
        applyPack(pages[0] ?? loaded, {
          canvasWidth,
          canvasHeight,
          gap,
          margin,
          background,
          mode: packMode,
          columns,
          itemSize,
        })
      } catch (e) {
        if (gen !== loadGenRef.current) return
        setError(e instanceof Error ? e.message : 'Failed to load images')
        setItems([])
        setSelectedId(null)
        replaceSources([])
      } finally {
        if (gen === loadGenRef.current) setLoading(false)
      }
    },
    [
      applyPack,
      replaceSources,
      canvasWidth,
      canvasHeight,
      gap,
      margin,
      background,
      packMode,
      columns,
      itemSize,
      pngsPerCover,
    ],
  )

  ingestRef.current = ingestFiles

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('demo')) return
    if (demoBootstrapped) return
    demoBootstrapped = true
    ;(async () => {
      try {
        const res = await fetch('/samples/manifest.json')
        if (!res.ok) return
        const names: string[] = await res.json()
        const files: File[] = []
        for (const name of names) {
          const blob = await fetch(`/samples/${name}`).then((r) => r.blob())
          files.push(new File([blob], name, { type: 'image/png' }))
        }
        await ingestRef.current(files)
      } catch {
        /* demo optional */
      }
    })()
  }, [])

  // Re-auto-pack current cover page when packing settings change (unless user moved things)
  useEffect(() => {
    if (sources.length === 0 || manualLayout) return
    applyPack(currentCoverSources, options)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when pack inputs change
  }, [
    canvasWidth,
    canvasHeight,
    gap,
    margin,
    packMode,
    columns,
    itemSize,
    sources,
    pngsPerCover,
    safeCoverPageIndex,
    manualLayout,
    applyPack,
  ])

  // Draw preview + selection (re-run when returning to Cover — canvas remounts)
  useEffect(() => {
    if (viewMode !== 'cover') return
    const canvas = previewRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = canvasWidth
    canvas.height = canvasHeight

    ctx.fillStyle = background
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)

    for (const item of items) {
      drawPackedItem(ctx, item)
    }

    if (selectedId) {
      const sel = items.find((it) => it.id === selectedId)
      if (sel) {
        const pad = Math.max(4, Math.min(sel.width, sel.height) * 0.02)
        const lw = Math.max(2, canvasWidth / 500)
        ctx.save()
        ctx.strokeStyle = '#1ec8d4'
        ctx.lineWidth = lw
        ctx.setLineDash([canvasWidth / 80, canvasWidth / 120])
        ctx.strokeRect(
          sel.x - pad,
          sel.y - pad,
          sel.width + pad * 2,
          sel.height + pad * 2,
        )
        ctx.setLineDash([])
        // Corner resize handles
        const r = handleRadius(sel, canvasWidth)
        const corners = cornerPoints(sel)
        for (const c of Object.values(corners)) {
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
    }
  }, [viewMode, items, selectedId, canvasWidth, canvasHeight, background])

  // Size the cover <canvas> to fit the wrap exactly — avoids overflow:hidden cropping edges
  useEffect(() => {
    if (viewMode !== 'cover') return
    const wrap = wrapRef.current
    const canvas = previewRef.current
    if (!wrap || !canvas) return

    const fit = () => {
      const rw = wrap.clientWidth
      const rh = wrap.clientHeight
      if (rw < 2 || rh < 2 || canvasWidth < 1 || canvasHeight < 1) return
      const scale = Math.min(rw / canvasWidth, rh / canvasHeight)
      canvas.style.width = `${Math.max(1, Math.floor(canvasWidth * scale))}px`
      canvas.style.height = `${Math.max(1, Math.floor(canvasHeight * scale))}px`
    }

    fit()
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(fit)
        : null
    ro?.observe(wrap)
    return () => ro?.disconnect()
  }, [viewMode, canvasWidth, canvasHeight, safeCoverPageIndex, coverPageCount])

  // When max W/H shrinks, clamp designs that overflow their own mockup box
  useEffect(() => {
    setMockupLayers((prev) => {
      let changed = false
      const next = prev.map((l) => {
        const bg = customMockupBgs[l.name] ?? mockupBg
        if (!bg) return l
        const limits: MockupSizeLimits = {
          maxWidth: Math.max(40, Math.min(mockupMaxWidth, bg.width)),
          maxHeight: Math.max(40, Math.min(mockupMaxHeight, bg.height)),
          minSide: 40,
        }
        if (
          l.width <= limits.maxWidth + 0.5 &&
          l.height <= limits.maxHeight + 0.5
        ) {
          return l
        }
        changed = true
        const sized = sizeFromWidth(
          l.bitmap.width,
          l.bitmap.height,
          l.width,
          limits,
        )
        const cx = l.x + l.width / 2
        const cy = l.y + l.height / 2
        return {
          ...l,
          ...sized,
          x: cx - sized.width / 2,
          y: cy - sized.height / 2,
        }
      })
      return changed ? next : prev
    })
  }, [mockupBg, customMockupBgs, mockupMaxWidth, mockupMaxHeight])

  // Sync mockup layers with tags + bitmaps (keep positions)
  useEffect(() => {
    setMockupLayers((prev) => {
      const byName = new Map(
        sources.map((it) => [
          it.name,
          {
            name: it.name,
            bitmap: it.bitmap,
            width: it.bitmap.width,
            height: it.bitmap.height,
          },
        ]),
      )
      let next = prev
        .filter((l) => mockupTags.has(l.name))
        .map((l) => {
          const src = byName.get(l.name)
          return src ? { ...l, bitmap: src.bitmap } : l
        })

      for (const name of mockupTags) {
        if (next.some((l) => l.name === name)) continue
        const bg = customMockupBgs[name] ?? mockupBg
        if (!bg) continue
        const src = byName.get(name)
        if (!src) continue
        const limits: MockupSizeLimits = {
          maxWidth: Math.max(40, Math.min(mockupMaxWidth, bg.width)),
          maxHeight: Math.max(40, Math.min(mockupMaxHeight, bg.height)),
          minSide: 40,
        }
        next = [...next, defaultLayerPlacement(bg, src, limits)]
      }
      // Drop layers that no longer have any background available
      next = next.filter((l) => Boolean(customMockupBgs[l.name] ?? mockupBg))
      return next
    })
  }, [
    sources,
    mockupTags,
    mockupBg,
    customMockupBgs,
    mockupMaxWidth,
    mockupMaxHeight,
  ])

  // Drop custom backgrounds for PNGs that are no longer tagged
  useEffect(() => {
    setCustomMockupBgs((prev) => {
      const keys = Object.keys(prev)
      const stale = keys.filter((k) => !mockupTags.has(k))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const k of stale) {
        try {
          next[k].bitmap.close()
        } catch {
          /* */
        }
        delete next[k]
      }
      return next
    })
  }, [mockupTags])

  // Draw current mockup only (one PNG per mockup)
  useEffect(() => {
    if (viewMode !== 'mockup' || !activeMockupBg) return
    const canvas = mockupRef.current
    if (!canvas) return
    const layer =
      mockupLayers.find((l) => l.name === mockupSelected) ?? null
    const paint = () => {
      paintUserMockup(
        canvas,
        activeMockupBg,
        layer,
        true,
        canvasDisplayScale(canvas),
      )
    }
    paint()
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => paint())
        : null
    ro?.observe(canvas)
    return () => ro?.disconnect()
  }, [viewMode, activeMockupBg, mockupLayers, mockupSelected])

  useEffect(() => {
    if (mockupSelected && mockupTags.has(mockupSelected)) return
    setMockupSelected([...mockupTags][0] ?? null)
  }, [mockupTags, mockupSelected])

  const moveItem = useCallback((id: string, x: number, y: number) => {
    setManualLayout(true)
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, x, y } : it)),
    )
  }, [])

  /** Resize one PNG. Pass `fromCenter` to keep the center fixed (slider/keyboard). */
  const resizeItem = useCallback(
    (
      id: string,
      size: number,
      opts?: { fromCenter?: boolean; x?: number; y?: number },
    ) => {
      const next = Math.max(sizeMin, Math.min(sizeMax, Math.round(size)))
      setManualLayout(true)
      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== id) return it
          if (opts?.x != null && opts?.y != null) {
            return { ...it, x: opts.x, y: opts.y, width: next, height: next }
          }
          if (opts?.fromCenter === false) {
            return { ...it, width: next, height: next }
          }
          const cx = it.x + it.width / 2
          const cy = it.y + it.height / 2
          return {
            ...it,
            width: next,
            height: next,
            x: cx - next / 2,
            y: cy - next / 2,
          }
        }),
      )
    },
    [sizeMin, sizeMax],
  )

  /**
   * Make the selected PNG ~2× larger (aspect locked), center it, and reflow
   * the other PNGs around it so they are not hidden underneath.
   */
  const doubleAndCenterItem = useCallback(
    (id: string) => {
      setManualLayout(true)
      setSelectedId(id)
      setItems((prev) => {
        const it = prev.find((p) => p.id === id)
        if (!it) return prev
        let w = it.width * 2
        let h = it.height * 2
        // Leave room around the hero for the other stickers
        const maxW = Math.max(40, Math.floor((canvasWidth - margin * 2) * 0.62))
        const maxH = Math.max(40, Math.floor((canvasHeight - margin * 2) * 0.62))
        const fit = Math.min(1, maxW / w, maxH / h)
        w = Math.max(40, Math.round(w * fit))
        h = Math.max(40, Math.round(h * fit))
        const featured: PlacedItem = {
          ...it,
          width: w,
          height: h,
          x: Math.round((canvasWidth - w) / 2),
          y: Math.round((canvasHeight - h) / 2),
        }

        const others = prev.filter((p) => p.id !== id)
        if (others.length === 0) return [featured]

        const otherSources: SourceImage[] = others.map((o) => ({
          name: o.name,
          file: new File([], o.name),
          bitmap: o.bitmap,
          width: o.bitmap.width,
          height: o.bitmap.height,
        }))

        const around = packAroundFeatured(
          otherSources,
          {
            canvasWidth,
            canvasHeight,
            gap,
            margin,
            background,
            mode: packMode,
            columns,
            itemSize: 0,
          },
          featured,
        )

        const byBitmap = new Map(others.map((o) => [o.bitmap, o]))
        const reflowed: PlacedItem[] = around.map((p, i) => {
          const original =
            byBitmap.get(p.bitmap) ??
            others.find((o) => o.name === p.name) ??
            others[i]
          return {
            ...p,
            id: original?.id ?? `${p.name}::around-${i}`,
          }
        })

        // Keep any others that failed to pack (rare) — scale down & park at edge
        const placedIds = new Set(reflowed.map((r) => r.id))
        const leftovers = others
          .filter((o) => !placedIds.has(o.id))
          .map((o, i) => ({
            ...o,
            width: Math.max(40, Math.round(o.width * 0.45)),
            height: Math.max(40, Math.round(o.height * 0.45)),
            x: margin + i * 12,
            y: margin + i * 12,
          }))

        return [...reflowed, ...leftovers, featured]
      })
    },
    [
      canvasWidth,
      canvasHeight,
      margin,
      gap,
      background,
      packMode,
      columns,
    ],
  )

  /** Remove one PNG from the cover (and from sources / mockup tags). */
  const removeItem = useCallback(
    (id: string) => {
      const target = itemsRef.current.find((it) => it.id === id)
      if (!target) return

      const nextSources = sourcesRef.current.filter(
        (s) => s.bitmap !== target.bitmap,
      )
      replaceSources(nextSources)

      setItems((prev) => prev.filter((it) => it.id !== id))
      setSelectedId((sel) => (sel === id ? null : sel))

      setMockupTags((prev) => {
        if (!prev.has(target.name)) return prev
        const stillPresent = itemsRef.current.some(
          (it) => it.id !== id && it.name === target.name,
        )
        if (stillPresent) return prev
        const next = new Set(prev)
        next.delete(target.name)
        return next
      })

      // Auto mode re-packs remaining sources; manual keeps other positions
      if (nextSources.length === 0) {
        setManualLayout(false)
        setCellSize(0)
        setItemSize(0)
      }
    },
    [replaceSources],
  )

  /** Resize every PNG to the same size, keeping centers. */
  const resizeAllItems = useCallback((size: number) => {
    const next = Math.max(sizeMin, Math.min(sizeMax, Math.round(size)))
    setItemSize(next)
    setCellSize(next)
    setManualLayout(true)
    setItems((prev) =>
      prev.map((it) => {
        const cx = it.x + it.width / 2
        const cy = it.y + it.height / 2
        return {
          ...it,
          width: next,
          height: next,
          x: cx - next / 2,
          y: cy - next / 2,
        }
      }),
    )
  }, [sizeMin, sizeMax])

  const setPngSize = useCallback(
    (size: number) => {
      const next = Math.max(sizeMin, Math.min(sizeMax, Math.round(size)))
      setItemSize(next)
      setCellSize(next)
      if (manualLayout) {
        resizeAllItems(next)
      }
      // else auto-pack effect picks up itemSize
    },
    [manualLayout, resizeAllItems, sizeMin, sizeMax],
  )

  const bringToFront = useCallback((id: string) => {
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.id === id)
      if (idx < 0 || idx === prev.length - 1) return prev
      const next = [...prev]
      const [item] = next.splice(idx, 1)
      next.push(item)
      return next
    })
  }, [])

  const clampCoverCtxMenuPos = useCallback((x: number, y: number) => {
    const pad = 8
    const mw = 260
    const mh = 280
    return {
      x: Math.max(pad, Math.min(x, window.innerWidth - mw - pad)),
      y: Math.max(pad, Math.min(y, window.innerHeight - mh - pad)),
    }
  }, [])

  /** Open the cover PNG context menu near a screen point (or beside the item). */
  const openCoverCtxMenu = useCallback(
    (id: string, clientX?: number, clientY?: number) => {
      const canvas = previewRef.current
      const item = itemsRef.current.find((it) => it.id === id)
      let x = clientX ?? 0
      let y = clientY ?? 0
      if ((clientX == null || clientY == null) && canvas && item) {
        const rect = canvas.getBoundingClientRect()
        const sx = rect.width / canvas.width
        const sy = rect.height / canvas.height
        x = rect.left + (item.x + item.width) * sx + 10
        y = rect.top + item.y * sy
      }
      setCoverCtxMenu({ id, ...clampCoverCtxMenuPos(x, y) })
    },
    [clampCoverCtxMenuPos],
  )

  const closeCoverCtxMenu = useCallback(() => setCoverCtxMenu(null), [])

  useEffect(() => {
    if (!coverCtxMenu) return
    const onDown = (e: MouseEvent | PointerEvent) => {
      const node = coverCtxMenuRef.current
      if (node && e.target instanceof Node && node.contains(e.target)) return
      closeCoverCtxMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCoverCtxMenu()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [coverCtxMenu, closeCoverCtxMenu])

  useEffect(() => {
    if (!selectedId) closeCoverCtxMenu()
    else if (coverCtxMenu && coverCtxMenu.id !== selectedId) closeCoverCtxMenu()
  }, [selectedId, coverCtxMenu, closeCoverCtxMenu])

  const onCoverContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = previewRef.current
    if (!canvas || items.length === 0) return
    const pt = canvasPoint(canvas, e.clientX, e.clientY)
    const hit = hitTest(items, pt.x, pt.y)
    if (!hit) {
      setSelectedId(null)
      closeCoverCtxMenu()
      return
    }
    setSelectedId(hit.id)
    bringToFront(hit.id)
    openCoverCtxMenu(hit.id, e.clientX, e.clientY)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = previewRef.current
    if (!canvas || items.length === 0) return
    if (e.button === 2) return
    coverDragMovedRef.current = false
    const pt = canvasPoint(canvas, e.clientX, e.clientY)

    // Prefer resize handles on the current selection
    if (selectedId) {
      const sel = items.find((it) => it.id === selectedId)
      if (sel) {
        const corner = hitCorner(sel, pt.x, pt.y, canvasWidth)
        if (corner) {
          closeCoverCtxMenu()
          setDrag({
            mode: 'resize',
            id: sel.id,
            corner,
            anchorX: pt.x,
            anchorY: pt.y,
          })
          canvas.setPointerCapture(e.pointerId)
          e.preventDefault()
          return
        }
      }
    }

    const hit = hitTest(items, pt.x, pt.y)
    if (!hit) {
      setSelectedId(null)
      closeCoverCtxMenu()
      return
    }

    // Clicking a handle of a newly selected item in the same gesture
    const corner = hitCorner(hit, pt.x, pt.y, canvasWidth)
    setSelectedId(hit.id)
    bringToFront(hit.id)
    if (corner) {
      closeCoverCtxMenu()
      setDrag({
        mode: 'resize',
        id: hit.id,
        corner,
        anchorX: pt.x,
        anchorY: pt.y,
      })
    } else {
      closeCoverCtxMenu()
      setDrag({
        mode: 'move',
        id: hit.id,
        offsetX: pt.x - hit.x,
        offsetY: pt.y - hit.y,
      })
    }
    canvas.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return
    coverDragMovedRef.current = true
    closeCoverCtxMenu()
    const canvas = previewRef.current
    if (!canvas) return
    const pt = canvasPoint(canvas, e.clientX, e.clientY)
    const current = itemsRef.current.find((it) => it.id === drag.id)
    if (!current) return

    if (drag.mode === 'resize') {
      const next = resizeFromCorner(
        current,
        drag.corner,
        pt.x,
        pt.y,
        sizeMin,
        sizeMax,
      )
      resizeItem(drag.id, next.width, { x: next.x, y: next.y })
      return
    }

    const x = Math.round(pt.x - drag.offsetX)
    const y = Math.round(pt.y - drag.offsetY)
    moveItem(drag.id, x, y)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return
    const wasClick = !coverDragMovedRef.current && drag.mode === 'move'
    const id = drag.id
    setDrag(null)
    try {
      previewRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (wasClick) {
      openCoverCtxMenu(id, e.clientX + 8, e.clientY + 8)
    }
  }

  const onCanvasCursor = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag) return
    const canvas = previewRef.current
    if (!canvas || !selectedId) {
      canvas && (canvas.style.cursor = 'grab')
      return
    }
    const sel = itemsRef.current.find((it) => it.id === selectedId)
    if (!sel) return
    const pt = canvasPoint(canvas, e.clientX, e.clientY)
    const corner = hitCorner(sel, pt.x, pt.y, canvasWidth)
    if (corner === 'nw' || corner === 'se') canvas.style.cursor = 'nwse-resize'
    else if (corner === 'ne' || corner === 'sw') canvas.style.cursor = 'nesw-resize'
    else if (hitTest([sel], pt.x, pt.y)) canvas.style.cursor = 'grab'
    else canvas.style.cursor = 'default'
  }

  const onFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) void ingestFiles(e.target.files)
    e.target.value = ''
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) void ingestFiles(e.target.files)
    e.target.value = ''
  }

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only clear highlight when leaving the dropzone itself
    const next = e.relatedTarget as Node | null
    if (next && e.currentTarget.contains(next)) return
    setDragOver(false)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    void (async () => {
      try {
        const files = await collectPngsFromDrop(e.dataTransfer)
        if (files.length === 0) {
          setError('No PNG files found in the drop. Drop a folder or PNG files.')
          return
        }
        await ingestFiles(files)
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Could not read dropped files',
        )
      }
    })()
  }

  const renderCoverBlob = async (
    pageItems: PackedRect[],
    startQuality: number,
  ): Promise<{ blob: Blob; quality: number }> => {
    const packMeta = {
      items: pageItems,
      cellSize: cellSize || pageItems[0]?.height || 0,
      columns: gridCols,
      rows: gridRows,
      usedHeight: canvasHeight,
      mode: packMode,
      scale: cellSize || pageItems[0]?.height || 0,
    }
    const opts = { ...options, background: background || '#ffffff' }
    let quality = startQuality
    let blob = await renderCover(packMeta, opts, {
      format: exportFormat,
      quality,
    })

    if (
      exportFormat === 'image/jpeg' &&
      blob.size > ETSY_TARGET_MAX_BYTES &&
      quality > 0.6
    ) {
      for (const q of [0.8, 0.72, 0.65, 0.58]) {
        if (q >= quality) continue
        blob = await renderCover(packMeta, opts, {
          format: 'image/jpeg',
          quality: q,
        })
        quality = q
        if (blob.size <= ETSY_TARGET_MAX_BYTES) break
      }
    }
    return { blob, quality }
  }

  const download = async () => {
    if (sources.length === 0) return
    const pages =
      coverPages.length > 0 ? coverPages : [sources]
    setExporting(true)
    setError(null)
    try {
      let lastBytes = 0
      const ext = exportFormat === 'image/jpeg' ? 'jpg' : 'png'
      const total = pages.length

      for (let i = 0; i < pages.length; i++) {
        const pageSrcs = pages[i]
        let pageItems: PackedRect[]
        if (i === safeCoverPageIndex && items.length > 0) {
          // Keep the user's current (possibly manual) layout for the open page
          pageItems = items
        } else {
          const packed = packImages(pageSrcs, options)
          if (!packed) {
            throw new Error(
              `Could not pack cover ${i + 1} of ${total}. Try a larger canvas or fewer PNGs per cover.`,
            )
          }
          pageItems = packed.items
        }

        const { blob } = await renderCoverBlob(pageItems, exportQuality)
        lastBytes = blob.size
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download =
          total === 1
            ? `etsy-cover-${canvasWidth}x${canvasHeight}.${ext}`
            : `etsy-cover-${i + 1}-of-${total}-${canvasWidth}x${canvasHeight}.${ext}`
        a.click()
        URL.revokeObjectURL(url)
        if (i < pages.length - 1) {
          await new Promise((r) => setTimeout(r, 280))
        }
      }
      setLastExportBytes(lastBytes)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  const clear = () => {
    loadGenRef.current += 1
    setItems([])
    setSelectedId(null)
    setManualLayout(false)
    setItemSize(0)
    setCellSize(0)
    setCoverPageIndex(0)
    setMockupTags(new Set())
    setMockupLayers([])
    setMockupSelected(null)
    // Keep mockupBg — default photo is stored for reuse across sessions
    setError(null)
    replaceSources([])
  }

  const limitsForBg = (bg: MockupBackground): MockupSizeLimits => ({
    maxWidth: Math.max(
      40,
      Math.min(mockupMaxWidth, Math.floor(bg.width * 0.55), bg.width),
    ),
    maxHeight: Math.max(
      40,
      Math.min(mockupMaxHeight, Math.floor(bg.height * 0.55), bg.height),
    ),
    minSide: 40,
  })

  const applyMockupBackground = useCallback(
    (loaded: MockupBackground) => {
      const limits: MockupSizeLimits = {
        maxWidth: Math.max(40, Math.floor(loaded.width * 0.55)),
        maxHeight: Math.max(40, Math.floor(loaded.height * 0.55)),
        minSide: 40,
      }
      setMockupMaxWidth(limits.maxWidth)
      setMockupMaxHeight(limits.maxHeight)
      setMockupBg((prev) => {
        if (prev) {
          try {
            prev.bitmap.close()
          } catch {
            /* */
          }
        }
        return loaded
      })
      // Re-place only designs that still use the shared default (not custom)
      setMockupLayers((layers) =>
        layers.map((l) => {
          if (customMockupBgsRef.current[l.name]) return l
          return defaultLayerPlacement(
            loaded,
            {
              name: l.name,
              bitmap: l.bitmap,
              width: l.bitmap.width,
              height: l.bitmap.height,
            },
            limits,
          )
        }),
      )
    },
    [],
  )

  const applyCustomMockupFor = useCallback(
    (name: string, loaded: MockupBackground) => {
      setCustomMockupBgs((prev) => {
        const old = prev[name]
        if (old) {
          try {
            old.bitmap.close()
          } catch {
            /* */
          }
        }
        return { ...prev, [name]: loaded }
      })
      const limits: MockupSizeLimits = {
        maxWidth: Math.max(40, Math.floor(loaded.width * 0.55)),
        maxHeight: Math.max(40, Math.floor(loaded.height * 0.55)),
        minSide: 40,
      }
      setMockupMaxWidth(limits.maxWidth)
      setMockupMaxHeight(limits.maxHeight)
      setMockupLayers((layers) => {
        const src = layers.find((l) => l.name === name)
        const bitmap = src?.bitmap
        if (!bitmap) return layers
        const placed = defaultLayerPlacement(
          loaded,
          {
            name,
            bitmap,
            width: bitmap.width,
            height: bitmap.height,
          },
          limits,
        )
        if (src) {
          return layers.map((l) => (l.name === name ? placed : l))
        }
        return [...layers, placed]
      })
      setMockupSelected(name)
      setViewMode('mockup')
    },
    [],
  )

  const clearCustomMockupFor = useCallback(
    (name: string) => {
      setCustomMockupBgs((prev) => {
        const old = prev[name]
        if (old) {
          try {
            old.bitmap.close()
          } catch {
            /* */
          }
        }
        const next = { ...prev }
        delete next[name]
        return next
      })
      setMockupLayers((layers) => {
        if (!mockupBg) {
          return layers.filter((l) => l.name !== name)
        }
        return layers.map((l) => {
          if (l.name !== name) return l
          return defaultLayerPlacement(
            mockupBg,
            {
              name: l.name,
              bitmap: l.bitmap,
              width: l.bitmap.width,
              height: l.bitmap.height,
            },
            limitsForBg(mockupBg),
          )
        })
      })
    },
    [mockupBg, mockupMaxWidth, mockupMaxHeight],
  )

  // Restore last mockup photo so the user doesn’t re-upload every session
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stored = await loadDefaultMockup()
        if (cancelled || !stored) return
        const loaded = await loadMockupBackgroundFromBlob(
          stored.blob,
          stored.name,
        )
        if (cancelled) {
          try {
            loaded.bitmap.close()
          } catch {
            /* */
          }
          return
        }
        applyMockupBackground(loaded)
      } catch {
        /* optional restore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyMockupBackground])

  const onMockupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const loaded = await loadMockupBackground(file)
      applyMockupBackground(loaded)
      try {
        await saveDefaultMockup(file, file.name)
      } catch {
        /* persistence optional — image still works this session */
      }
      setViewMode('mockup')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load mockup image')
    }
  }

  const clearMockupBg = () => {
    if (mockupBg) {
      try {
        mockupBg.bitmap.close()
      } catch {
        /* */
      }
    }
    setMockupBg(null)
    // Keep layers that still have a custom per-PNG mockup
    setMockupLayers((layers) =>
      layers.filter((l) => Boolean(customMockupBgsRef.current[l.name])),
    )
    void clearDefaultMockup().catch(() => {
      /* ignore */
    })
  }

  const onCustomMockupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const name = mockupSelected
    if (!file || !name) return
    try {
      const loaded = await loadMockupBackground(file)
      applyCustomMockupFor(name, loaded)
      setError(null)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not load custom mockup image',
      )
    }
  }

  const moveMockupLayer = useCallback((name: string, x: number, y: number) => {
    setMockupLayers((prev) =>
      prev.map((l) => (l.name === name ? { ...l, x, y } : l)),
    )
  }, [])

  const resizeMockupLayer = useCallback(
    (
      name: string,
      size: number,
      opts?: { x?: number; y?: number; axis?: 'width' | 'height' | 'long' },
    ) => {
      setMockupLayers((prev) =>
        prev.map((l) => {
          if (l.name !== name) return l
          const axis = opts?.axis ?? 'long'
          let sized: { width: number; height: number }
          if (axis === 'width') {
            sized = sizeFromWidth(
              l.bitmap.width,
              l.bitmap.height,
              size,
              mockupLimits,
            )
          } else if (axis === 'height') {
            sized = sizeFromHeight(
              l.bitmap.width,
              l.bitmap.height,
              size,
              mockupLimits,
            )
          } else {
            const long = Math.max(l.bitmap.width, l.bitmap.height)
            const scale = size / long
            sized = sizeFromWidth(
              l.bitmap.width,
              l.bitmap.height,
              l.bitmap.width * scale,
              mockupLimits,
            )
          }
          if (opts?.x != null && opts?.y != null) {
            return { ...l, x: opts.x, y: opts.y, ...sized }
          }
          const cx = l.x + l.width / 2
          const cy = l.y + l.height / 2
          return {
            ...l,
            ...sized,
            x: cx - sized.width / 2,
            y: cy - sized.height / 2,
          }
        }),
      )
    },
    [mockupLimits],
  )

  /** Clamp every mockup design into the current max W×H box. */
  const clampAllMockupSizes = useCallback(() => {
    setMockupLayers((prev) =>
      prev.map((l) => {
        const sized = sizeFromWidth(
          l.bitmap.width,
          l.bitmap.height,
          l.width,
          mockupLimits,
        )
        const cx = l.x + l.width / 2
        const cy = l.y + l.height / 2
        return {
          ...l,
          ...sized,
          x: cx - sized.width / 2,
          y: cy - sized.height / 2,
        }
      }),
    )
  }, [mockupLimits])

  const onMockupPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = mockupRef.current
    const sel = mockupLayersRef.current.find((l) => l.name === mockupSelected)
    const bg = resolveMockupBg(mockupSelected)
    if (!canvas || !bg || !sel) return
    const pt = canvasPoint(canvas, e.clientX, e.clientY)
    const asItem = { ...sel, id: sel.name }
    const scale = canvasDisplayScale(canvas)

    const corner = hitCorner(asItem, pt.x, pt.y, bg.width, scale)
    if (corner) {
      setMockupDrag({
        mode: 'resize',
        id: sel.name,
        corner,
        anchorX: pt.x,
        anchorY: pt.y,
      })
      canvas.setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }

    const hit = hitTest([asItem], pt.x, pt.y)
    if (!hit) return

    setMockupDrag({
      mode: 'move',
      id: sel.name,
      offsetX: pt.x - sel.x,
      offsetY: pt.y - sel.y,
    })
    canvas.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onMockupPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = mockupRef.current
    const bg = resolveMockupBg(mockupSelected)
    if (!canvas || !bg) return
    const pt = canvasPoint(canvas, e.clientX, e.clientY)

    if (!mockupDrag) {
      const sel = mockupLayersRef.current.find((l) => l.name === mockupSelected)
      if (!sel) {
        canvas.style.cursor = 'default'
        return
      }
      const asItem = { ...sel, id: sel.name }
      const corner = hitCorner(
        asItem,
        pt.x,
        pt.y,
        bg.width,
        canvasDisplayScale(canvas),
      )
      if (corner === 'nw' || corner === 'se') canvas.style.cursor = 'nwse-resize'
      else if (corner === 'ne' || corner === 'sw') canvas.style.cursor = 'nesw-resize'
      else if (hitTest([asItem], pt.x, pt.y)) canvas.style.cursor = 'grab'
      else canvas.style.cursor = 'default'
      return
    }

    const current = mockupLayersRef.current.find((l) => l.name === mockupDrag.id)
    if (!current) return

    if (mockupDrag.mode === 'resize') {
      const next = resizeLayerFromCorner(
        current,
        mockupDrag.corner,
        pt.x,
        pt.y,
        mockupLimits,
      )
      setMockupLayers((prev) =>
        prev.map((l) => (l.name === mockupDrag.id ? next : l)),
      )
      return
    }

    moveMockupLayer(
      mockupDrag.id,
      Math.round(pt.x - mockupDrag.offsetX),
      Math.round(pt.y - mockupDrag.offsetY),
    )
  }

  const onMockupPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!mockupDrag) return
    setMockupDrag(null)
    try {
      mockupRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* */
    }
  }

  const selectMockup = useCallback(
    (name: string) => {
      setMockupSelected(name)
      setViewMode('mockup')
      const match = itemsRef.current.find((it) => it.name === name)
      if (match) setSelectedId(match.id)
    },
    [],
  )

  const stepMockup = useCallback(
    (dir: -1 | 1) => {
      const layers = mockupLayersRef.current
      if (layers.length === 0) return
      const cur = mockupSelected
      const i = Math.max(
        0,
        layers.findIndex((l) => l.name === cur),
      )
      const next = (i + dir + layers.length) % layers.length
      selectMockup(layers[next].name)
    },
    [mockupSelected, selectMockup],
  )

  // Arrow-key nudge + [ ] resize (cover or active mockup) · , / . switch mockups
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (viewMode === 'mockup' && mockupLayersRef.current.length > 1) {
        if (e.key === ',' || e.key === 'PageUp') {
          e.preventDefault()
          stepMockup(-1)
          return
        }
        if (e.key === '.' || e.key === 'PageDown') {
          e.preventDefault()
          stepMockup(1)
          return
        }
      }

      if (viewMode === 'mockup') {
        const layer = mockupLayersRef.current.find(
          (l) => l.name === mockupSelected,
        )
        if (!layer) return
        const sizeStep = e.shiftKey ? 20 : 10
        if (e.key === '[' || e.key === '-' || e.key === '_') {
          e.preventDefault()
          resizeMockupLayer(layer.name, layer.width - sizeStep, {
            axis: 'width',
          })
          return
        }
        if (e.key === ']' || e.key === '=' || e.key === '+') {
          e.preventDefault()
          resizeMockupLayer(layer.name, layer.width + sizeStep, {
            axis: 'width',
          })
          return
        }
        const step = e.shiftKey ? 10 : 1
        let dx = 0
        let dy = 0
        if (e.key === 'ArrowLeft') dx = -step
        else if (e.key === 'ArrowRight') dx = step
        else if (e.key === 'ArrowUp') dy = -step
        else if (e.key === 'ArrowDown') dy = step
        else return
        e.preventDefault()
        moveMockupLayer(layer.name, layer.x + dx, layer.y + dy)
        return
      }

      if (!selectedId) return
      const current = itemsRef.current.find((it) => it.id === selectedId)
      if (!current) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        removeItem(selectedId)
        return
      }

      if (e.key === '2') {
        e.preventDefault()
        doubleAndCenterItem(selectedId)
        return
      }

      const sizeStep = e.shiftKey ? 20 : 10
      if (e.key === '[' || e.key === '-' || e.key === '_') {
        e.preventDefault()
        resizeItem(selectedId, current.width - sizeStep)
        return
      }
      if (e.key === ']' || e.key === '=' || e.key === '+') {
        e.preventDefault()
        resizeItem(selectedId, current.width + sizeStep)
        return
      }

      const step = e.shiftKey ? 10 : 1
      let dx = 0
      let dy = 0
      if (e.key === 'ArrowLeft') dx = -step
      else if (e.key === 'ArrowRight') dx = step
      else if (e.key === 'ArrowUp') dy = -step
      else if (e.key === 'ArrowDown') dy = step
      else return

      e.preventDefault()
      moveItem(selectedId, current.x + dx, current.y + dy)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    selectedId,
    viewMode,
    mockupSelected,
    moveItem,
    resizeItem,
    removeItem,
    doubleAndCenterItem,
    moveMockupLayer,
    resizeMockupLayer,
    stepMockup,
  ])

  const mockupScalePct = activeMockupLayer
    ? Math.max(
        1,
        Math.round(
          (activeMockupLayer.width / mockupLimits.maxWidth) * 100,
        ),
      )
    : 50

  const setMockupScalePct = (pct: number) => {
    if (!activeMockupLayer) return
    const targetW = (mockupLimits.maxWidth * Math.max(5, Math.min(100, pct))) / 100
    resizeMockupLayer(activeMockupLayer.name, targetW, { axis: 'width' })
  }

  const centerMockupLayer = (mode: 'both' | 'x' | 'y' = 'both') => {
    if (!activeMockupBg || !activeMockupLayer) return
    const l = activeMockupLayer
    const x = mode === 'y' ? l.x : (activeMockupBg.width - l.width) / 2
    const y =
      mode === 'x'
        ? l.y
        : (activeMockupBg.height - l.height) / 2 - activeMockupBg.height * 0.04
    moveMockupLayer(l.name, Math.round(x), Math.round(y))
  }

  const nudgeMockup = (dx: number, dy: number) => {
    if (!activeMockupLayer) return
    moveMockupLayer(
      activeMockupLayer.name,
      activeMockupLayer.x + dx,
      activeMockupLayer.y + dy,
    )
  }

  /** Copy current design’s position/size onto every mockup. */
  const applyPlacementToAll = () => {
    const src = mockupLayers.find((l) => l.name === mockupSelected)
    if (!src) return
    setMockupLayers((prev) =>
      prev.map((l) => {
        if (l.name === src.name) return l
        const sized = sizeFromWidth(
          l.bitmap.width,
          l.bitmap.height,
          src.width,
          mockupLimits,
        )
        const cx = src.x + src.width / 2
        const cy = src.y + src.height / 2
        return {
          ...l,
          ...sized,
          x: cx - sized.width / 2,
          y: cy - sized.height / 2,
        }
      }),
    )
  }

  const downloadMockup = async () => {
    const layer = mockupLayers.find((l) => l.name === mockupSelected)
    const bg = resolveMockupBg(mockupSelected)
    if (!bg) {
      setError(
        'Upload a default mockup photo, or a custom mockup for this PNG.',
      )
      return
    }
    if (!layer) {
      setError('Tag at least one PNG — each tagged PNG becomes its own mockup.')
      return
    }
    setExportingMockup(true)
    setError(null)
    try {
      const blob = await exportUserMockup(bg, layer, 0.9)
      const stem = layer.name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 60)
      await downloadBlob(blob, `etsy-mockup-${stem || 'design'}.jpg`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mockup export failed')
    } finally {
      setExportingMockup(false)
    }
  }

  const downloadAllMockups = async () => {
    const entries = mockupLayers
      .map((layer) => {
        const bg = resolveMockupBg(layer.name)
        return bg ? { bg, layer } : null
      })
      .filter((e): e is { bg: MockupBackground; layer: MockupLayer } => e != null)
    if (entries.length === 0) {
      setError(
        'Upload a default mockup or custom mockups for tagged PNGs first.',
      )
      return
    }
    setExportingMockup(true)
    setError(null)
    try {
      await exportAllMockups(entries, 0.9)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mockup export failed')
    } finally {
      setExportingMockup(false)
    }
  }

  // Export modal: Escape to close, focus close control on open
  useEffect(() => {
    if (!exportOpen) return
    exportCloseRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (exporting || exportingVideo || listingGenerating) return
      e.preventDefault()
      setExportOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [exportOpen, exporting, exportingVideo, listingGenerating])

  // Restore listing-copy prefs (free uses hint, optional key, last draft)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const prefs = await loadListingCopyPrefs()
        if (cancelled) return
        setListingFreeRemaining(prefs.freeRemaining)
        setListingGuidelines(prefs.guidelines)
        setListingSubject(prefs.listingSubject)
        setListingRememberKey(prefs.rememberKey)
        if (prefs.rememberKey && prefs.userApiKey) {
          setListingUserKey(prefs.userApiKey)
        }
        if (prefs.lastCopy) setListingCopy(prefs.lastCopy)
      } catch {
        /* optional */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Keep video clip list in sync with cover + available mockups
  useEffect(() => {
    setVideoOrder((prev) => {
      const valid = new Set<VideoClipId>()
      if (items.length > 0) valid.add('cover')
      for (const l of mockupLayers) {
        if (resolveMockupBg(l.name)) valid.add(`mockup:${l.name}`)
      }
      const kept = prev.filter((id) => valid.has(id))
      for (const id of valid) {
        if (!kept.includes(id)) {
          if (id === 'cover') kept.unshift(id)
          else kept.push(id)
        }
      }
      return kept
    })
  }, [items.length, mockupLayers, resolveMockupBg])

  const moveVideoClip = (index: number, dir: -1 | 1) => {
    setVideoOrder((prev) => {
      const j = index + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[j]] = [next[j], next[index]]
      return next
    })
  }

  const videoClipLabel = (id: VideoClipId) => {
    if (id === 'cover') return 'Cover sheet'
    return id.slice('mockup:'.length)
  }

  /** Ordered slides (user-controlled) — Etsy listing video (3–15s). */
  const downloadListingVideo = async () => {
    if (videoOrder.length === 0) {
      setError('Add a cover or mockups before making a video.')
      return
    }
    setExportingVideo(true)
    setVideoProgress(0)
    setError(null)
    try {
      const slides: VideoSlideSource[] = []
      for (const id of videoOrder) {
        if (id === 'cover') {
          if (items.length === 0) continue
          slides.push({
            kind: 'cover',
            width: canvasWidth,
            height: canvasHeight,
            background,
            items,
          })
          continue
        }
        const name = id.slice('mockup:'.length)
        const layer = mockupLayers.find((l) => l.name === name)
        const bg = resolveMockupBg(name)
        if (!bg || !layer) continue
        slides.push({ kind: 'mockup', bg, layer })
      }
      if (slides.length === 0) {
        throw new Error('No slides available for the video.')
      }

      const { blob, mimeType } = await exportEtsyListingVideo(slides, {
        totalSec: videoDurationSec,
        onProgress: setVideoProgress,
      })
      const ext = videoFileExtension(mimeType)
      await downloadBlob(blob, `etsy-listing-video.${ext}`)
      setVideoProgress(1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Video export failed')
    } finally {
      setExportingVideo(false)
    }
  }

  const onListingRefFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      setListingRefText(text)
      setListingRefName(file.name)
      setListingError(null)
    } catch {
      setListingError('Could not read the reference text file.')
    }
  }

  const copyListingField = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setListingCopied(label)
      window.setTimeout(() => setListingCopied(null), 1600)
    } catch {
      setListingError('Clipboard copy failed.')
    }
  }

  const generateListingCopy = async () => {
    if (items.length === 0) {
      setListingError('Load PNGs and build a cover first.')
      return
    }
    if (!listingRefText.trim()) {
      setListingError('Upload a reference .txt with an example title, description, and tags.')
      return
    }
    if (listingNeedsName && !listingSubject.trim()) {
      setListingError(
        listingSubjectGuess
          ? `Add a listing subject (maybe: “${listingSubjectGuess}”).`
          : 'Add a short listing subject so the AI knows what these designs are.',
      )
      return
    }

    setListingGenerating(true)
    setListingError(null)
    setListingNeedsName(false)
    try {
      const cover = await buildCoverPayload(items, options)
      const designs = await buildDesignPayloads(sources, 8)
      const needsUserKey = listingFreeRemaining <= 0
      if (needsUserKey && !listingUserKey.trim()) {
        throw Object.assign(
          new Error(
            'Free AI uses are used up. Paste your OpenAI API key to continue.',
          ),
          { code: 'quota_exhausted' },
        )
      }

      const data = await requestListingCopy({
        cover,
        designs,
        referenceText: listingRefText,
        guidelines: listingGuidelines,
        listingSubject: listingSubject.trim(),
        userApiKey: needsUserKey ? listingUserKey.trim() : undefined,
      })

      setListingFreeRemaining(data.freeRemaining)
      if (data.needsListingName) {
        setListingNeedsName(true)
        setListingSubjectGuess(data.subjectGuess ?? null)
        setListingError(
          data.subjectGuess
            ? `Couldn’t confirm the niche from the images. Enter a listing subject (suggestion: “${data.subjectGuess}”) and generate again.`
            : 'Couldn’t tell what these designs are from the images. Enter a short listing subject and generate again.',
        )
        await saveListingCopyPrefs({ freeRemaining: data.freeRemaining })
        return
      }

      const next: ListingCopyResult = {
        title: data.title,
        description: data.description,
        tags: data.tags,
      }
      setListingCopy(next)
      setListingNeedsName(false)
      setListingSubjectGuess(null)
      await saveListingCopyPrefs({
        freeRemaining: data.freeRemaining,
        guidelines: listingGuidelines,
        listingSubject: listingSubject.trim(),
        lastCopy: next,
        rememberKey: listingRememberKey,
        userApiKey: listingRememberKey ? listingUserKey.trim() : undefined,
        clearKey: !listingRememberKey,
      })
    } catch (e) {
      const err = e as Error & { code?: string; freeRemaining?: number }
      if (typeof err.freeRemaining === 'number') {
        setListingFreeRemaining(err.freeRemaining)
      }
      if (err.code === 'quota_exhausted') {
        setListingFreeRemaining(0)
      }
      setListingError(err.message || 'Listing AI failed')
    } finally {
      setListingGenerating(false)
    }
  }

  const autoArrange = () => {
    if (sources.length === 0) return
    setManualLayout(false)
    applyPack(currentCoverSources, options)
  }

  /** Shuffle PNG order, then re-pack into the same grid / row layout. */
  const randomizePositions = () => {
    if (sources.length < 2) return
    const shuffled = [...sources]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    replaceSources(shuffled)
    setCoverPageIndex(0)
    setManualLayout(false)
    const pages = chunkSourcesForCovers(shuffled, pngsPerCover)
    applyPack(pages[0] ?? shuffled, options)
  }

  const goCoverPage = (dir: -1 | 1) => {
    if (coverPages.length < 2) return
    setManualLayout(false)
    setSelectedId(null)
    setCoverPageIndex((i) => {
      const n = coverPages.length
      return (i + dir + n) % n
    })
  }

  const ctxMenuSelected =
    coverCtxMenu != null
      ? (items.find((it) => it.id === coverCtxMenu.id) ?? null)
      : null

  const scrollItemIntoList = (id: string) => {
    const el = document.querySelector<HTMLElement>(
      `[data-item-id="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand" translate="no">
          <span className="brand-mark" aria-hidden="true" />
          Cover&nbsp;Maker
        </div>
        <p className="tagline">
          Build sticker-sheet listing photos that meet Etsy’s size rules —
          then mock them up on your product shots.
        </p>
        <span className="top-pill" title={`Short side ≥ ${ETSY_MIN_SHORT_SIDE}px`}>
          Etsy-ready · ≥{ETSY_MIN_SHORT_SIDE}px
        </span>
      </header>

      <div className="layout">
        <aside className="panel" aria-label="Settings">
          <section className="block">
            <h2>Source</h2>
            <div
              className={`dropzone${dragOver ? ' is-over' : ''}${sources.length ? ' has-files' : ''}`}
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              {loading ? (
                <p className="drop-copy">Loading PNGs…</p>
              ) : dragOver ? (
                <p className="drop-copy drop-copy-active">
                  Drop folder or PNG files to load
                </p>
              ) : sources.length > 0 ? (
                <p className="drop-copy">
                  <strong>{sources.length}</strong> PNG
                  {sources.length === 1 ? '' : 's'} loaded
                  <span className="drop-hint">
                    {' '}
                    — drop another folder or files to replace
                  </span>
                </p>
              ) : (
                <p className="drop-copy">
                  Drop a <strong>folder</strong> or PNG files here
                </p>
              )}
              <div className="drop-actions">
                <input
                  ref={folderRef}
                  id={folderInputId}
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={onFolderChange}
                  {...({
                    webkitdirectory: '',
                    directory: '',
                  } as React.InputHTMLAttributes<HTMLInputElement>)}
                />
                <input
                  ref={fileRef}
                  id={fileInputId}
                  type="file"
                  accept="image/png,.png"
                  multiple
                  className="sr-only"
                  onChange={onFileChange}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => folderRef.current?.click()}
                  disabled={loading}
                >
                  Choose folder…
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => fileRef.current?.click()}
                  disabled={loading}
                >
                  Choose files…
                </button>
                {sources.length > 0 && (
                  <button type="button" className="btn btn-ghost" onClick={clear}>
                    Clear
                  </button>
                )}
              </div>
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </section>

          <section className="block">
            <h2>Etsy size</h2>
            <div className="presets" role="group" aria-label="Etsy size presets">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`chip${canvasWidth === p.w && canvasHeight === p.h ? ' is-active' : ''}`}
                  onClick={() => {
                    setCanvasWidth(p.w)
                    setCanvasHeight(p.h)
                  }}
                  title={p.tip}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="fields">
              <label className="field">
                <span>Width</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={ETSY_MIN_SHORT_SIDE}
                  max={3000}
                  step={50}
                  value={canvasWidth}
                  onChange={(e) => {
                    setCanvasWidth(Number(e.target.value) || 3000)
                  }}
                />
              </label>
              <label className="field">
                <span>Height</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={ETSY_MIN_SHORT_SIDE}
                  max={3000}
                  step={50}
                  value={canvasHeight}
                  onChange={(e) => {
                    setCanvasHeight(Number(e.target.value) || 3000)
                  }}
                />
              </label>
            </div>
            <div
              className={`etsy-status${etsy.ok ? ' is-ready' : ' is-warn'}`}
              role="status"
            >
              <strong>{etsy.ok ? 'Etsy-ready' : 'Needs attention'}</strong>
              <ul>
                {etsy.ok
                  ? etsy.tips.map((t) => <li key={t}>{t}</li>)
                  : etsy.issues.map((t) => <li key={t}>{t}</li>)}
              </ul>
            </div>
          </section>


          <section className="block">
            <h2>{packMode === 'rows' ? 'Row height' : 'PNG size'}</h2>
            <label className="field field-stack">
              <span className="field-row">
                {packMode === 'rows' ? 'Height' : 'Size'}{' '}
                <em>
                  {Math.round(itemSize || cellSize || 0) || '—'}px
                  {itemSize === 0 && cellSize > 0 ? ' (auto)' : ''}
                </em>
              </span>
              <input
                type="range"
                min={sizeMin}
                max={sizeMax}
                step={10}
                value={Math.round(itemSize || cellSize || sizeMin)}
                onChange={(e) => {
                  setPngSize(Number(e.target.value))
                }}
                disabled={sources.length === 0}
              />
            </label>
            <div className="fields">
              <label className="field">
                <span>Pixels</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={sizeMin}
                  max={sizeMax}
                  step={10}
                  value={Math.round(itemSize || cellSize || 0) || ''}
                  placeholder="Auto"
                  disabled={sources.length === 0}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (!Number.isFinite(v) || v <= 0) {
                        setItemSize(0)
                      return
                    }
                    setPngSize(v)
                  }}
                />
              </label>
              <div className="field field-actions">
                <span>Fit</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={sources.length === 0}
                  onClick={() => {
                    setItemSize(0)
                    setManualLayout(false)
                  }}
                >
                  Auto size
                </button>
              </div>
            </div>
            <p className="hint">
              {packMode === 'rows'
                ? 'Stickers share one row height; width follows each PNG’s shape — like your reference covers.'
                : 'PNGs fill a tight grid with no leftover empty bands.'}
            </p>
          </section>

          <section className="block">
            <h2>Layout</h2>
            <div className="presets mode-toggle" role="group" aria-label="Pack mode">
              <button
                type="button"
                className={`chip${packMode === 'rows' ? ' is-active' : ''}`}
                onClick={() => {
                  setPackMode('rows')
                  setManualLayout(false)
                }}
              >
                Sticker rows
              </button>
              <button
                type="button"
                className={`chip${packMode === 'grid' ? ' is-active' : ''}`}
                onClick={() => {
                  setPackMode('grid')
                  setManualLayout(false)
                }}
              >
                Square grid
              </button>
            </div>
            {packMode === 'grid' && (
            <label className="field field-stack">
              <span className="field-row">
                Columns{' '}
                <em>{columns === 0 ? `auto (${gridCols || '…'})` : columns}</em>
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(12, sources.length || 12)}
                value={columns}
                onChange={(e) => {
                  setColumns(Number(e.target.value))
                }}
                disabled={manualLayout || sources.length === 0}
              />
            </label>
            )}
            <label className="field field-stack">
              <span className="field-row">
                PNGs per cover{' '}
                <em>
                  {pngsPerCover <= 0
                    ? 'All (1 cover)'
                    : `${pngsPerCover} → ${coverPages.length || 1} cover${
                        coverPages.length === 1 ? '' : 's'
                      }`}
                </em>
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(sources.length || 50, 50)}
                step={1}
                value={pngsPerCover}
                onChange={(e) => {
                  setPngsPerCover(Number(e.target.value))
                  setCoverPageIndex(0)
                  setManualLayout(false)
                  setSelectedId(null)
                }}
                disabled={sources.length === 0}
                aria-label="Maximum PNGs per cover sheet; 0 means all on one cover"
              />
            </label>
            <div className="fields">
              <label className="field">
                <span>Count</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={Math.max(sources.length || 500, 500)}
                  step={1}
                  value={pngsPerCover}
                  placeholder="0 = all"
                  disabled={sources.length === 0}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setPngsPerCover(
                      Number.isFinite(v) && v > 0 ? Math.floor(v) : 0,
                    )
                    setCoverPageIndex(0)
                    setManualLayout(false)
                    setSelectedId(null)
                  }}
                  aria-label="PNGs per cover; 0 for all on one cover"
                />
              </label>
              <div className="field field-actions">
                <span>Split</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={sources.length === 0}
                  onClick={() => {
                    setPngsPerCover(0)
                    setCoverPageIndex(0)
                    setManualLayout(false)
                  }}
                >
                  All on 1
                </button>
              </div>
            </div>
            {sources.length > 0 && pngsPerCover > 0 && (
              <p className="hint">
                {sources.length} PNG{sources.length === 1 ? '' : 's'} →{' '}
                {coverPages.length} cover{coverPages.length === 1 ? '' : 's'}
                {coverPages.length > 1
                  ? ` (${coverPages
                      .map((p, i) => `${i + 1}: ${p.length}`)
                      .join(' · ')})`
                  : ''}
                . Preview one sheet at a time; export downloads every cover.
              </p>
            )}
            <label className="field field-stack">
              <span className="field-row">
                Gap <em>{gap}px</em>
              </span>
              <input
                type="range"
                min={0}
                max={80}
                value={gap}
                onChange={(e) => {
                  setGap(Number(e.target.value))
                }}
                disabled={manualLayout}
              />
            </label>
            <label className="field field-stack">
              <span className="field-row">
                Margin <em>{margin}px</em>
              </span>
              <input
                type="range"
                min={0}
                max={120}
                value={margin}
                onChange={(e) => {
                  setMargin(Number(e.target.value))
                }}
                disabled={manualLayout}
              />
            </label>
            {manualLayout && (
              <p className="hint">
                Columns/gap/margin apply on auto-arrange after you moved items.
                PNG size still updates live.
              </p>
            )}
            {!manualLayout && cellSize > 0 && (
              <p className="hint">
                {packMode === 'rows'
                  ? `${gridRows} rows · ~${Math.round(cellSize)}px tall`
                  : `Grid ${gridCols}×${gridRows} · ${Math.round(cellSize)}px cells`}
              </p>
            )}
            <label className="field">
              <span>Background (opaque)</span>
              <input
                type="color"
                value={background}
                onChange={(e) => setBackground(e.target.value)}
                aria-label="Background color"
              />
            </label>
            <p className="hint">
              Etsy turns transparent PNG areas black — always export with a solid
              fill (white is standard for clipart covers).
            </p>
          </section>

          {items.length > 0 && (
            <section className="block">
              <div className="block-head">
                <h2>Positions</h2>
                <div className="block-head-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    onClick={randomizePositions}
                  >
                    Randomize
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    onClick={autoArrange}
                  >
                    Auto arrange
                  </button>
                </div>
              </div>
              <p className="hint">
                Click or right-click a PNG on the cover for a context menu (2×
                &amp; center, tag, resize, remove). Keys: [ ] resize · arrows
                nudge · Delete · 2 doubles &amp; centers.
              </p>
              <ul className="item-list" role="listbox" aria-label="PNG positions">
                {items.map((it) => {
                  const active = it.id === selectedId
                  const tagged = mockupTags.has(it.name)
                  return (
                    <li
                      key={it.id}
                      data-item-id={it.id}
                      className={`item-row${active ? ' is-active' : ''}${tagged ? ' is-tagged' : ''}`}
                      role="option"
                      aria-selected={active}
                    >
                      <div className="item-main">
                        <button
                          type="button"
                          className={`tag-pin${tagged ? ' is-on' : ''}`}
                          aria-label={
                            tagged
                              ? `Remove ${it.name} from mockup`
                              : `Tag ${it.name} for mockup`
                          }
                          aria-pressed={tagged}
                          title={tagged ? 'Tagged for mockup' : 'Tag for mockup'}
                          onClick={() => toggleMockupTag(it.name)}
                        >
                          {tagged ? '●' : '○'}
                        </button>
                        <button
                          type="button"
                          className="item-select"
                          onClick={() => {
                            setSelectedId(it.id)
                            scrollItemIntoList(it.id)
                            setViewMode('cover')
                            openCoverCtxMenu(it.id)
                            if (tagged) selectMockup(it.name)
                          }}
                        >
                          <span className="item-thumb" aria-hidden="true">
                            <ItemThumb bitmap={it.bitmap} name={it.name} />
                          </span>
                          <span className="item-name" title={it.name}>
                            {it.name}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="item-remove"
                          aria-label={`Remove ${it.name} from cover`}
                          title="Remove from cover"
                          onClick={() => removeItem(it.id)}
                        >
                          ×
                        </button>
                      </div>
                      <div className="item-xy">
                        <label>
                          <span className="sr-only">X for {it.name}</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            value={Math.round(it.x)}
                            step={1}
                            onFocus={() => setSelectedId(it.id)}
                            onChange={(e) =>
                              moveItem(it.id, Number(e.target.value) || 0, it.y)
                            }
                            aria-label={`X position for ${it.name}`}
                          />
                        </label>
                        <label>
                          <span className="sr-only">Y for {it.name}</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            value={Math.round(it.y)}
                            step={1}
                            onFocus={() => setSelectedId(it.id)}
                            onChange={(e) =>
                              moveItem(it.id, it.x, Number(e.target.value) || 0)
                            }
                            aria-label={`Y position for ${it.name}`}
                          />
                        </label>
                        <label>
                          <span className="sr-only">Size for {it.name}</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            value={Math.round(it.width)}
                            min={sizeMin}
                            max={sizeMax}
                            step={10}
                            onFocus={() => setSelectedId(it.id)}
                            onChange={(e) =>
                              resizeItem(it.id, Number(e.target.value) || sizeMin)
                            }
                            aria-label={`Size for ${it.name}`}
                            title="Size (px)"
                          />
                        </label>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {items.length > 0 && (
            <section className="block">
              <h2>Mockup</h2>
              <p className="hint">
                Upload a default flat-lay (saved in this browser). Optionally set
                a <strong>custom mockup per PNG</strong> when editing that design.
              </p>
              <input
                ref={mockupFileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                className="sr-only"
                onChange={(e) => void onMockupFile(e)}
              />
              <input
                ref={customMockupFileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                className="sr-only"
                onChange={(e) => void onCustomMockupFile(e)}
              />
              <div className="drop-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => mockupFileRef.current?.click()}
                >
                  {mockupBg ? 'Replace default mockup…' : 'Upload default mockup…'}
                </button>
                {mockupBg && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={clearMockupBg}
                  >
                    Clear default mockup
                  </button>
                )}
              </div>
              {mockupBg && (
                <p className="meta" style={{ textAlign: 'left' }}>
                  Default: {mockupBg.name} · {mockupBg.width}×{mockupBg.height}
                  {mockupLayers.length > 0
                    ? ` · ${mockupLayers.length} mockup${mockupLayers.length === 1 ? '' : 's'}`
                    : ''}
                </p>
              )}
              {taggedItems.length === 0 ? (
                <p className="hint">Tag PNGs in the list — one mockup per PNG.</p>
              ) : !mockupBg && Object.keys(customMockupBgs).length === 0 ? (
                <p className="hint">
                  {taggedItems.length} PNG{taggedItems.length === 1 ? '' : 's'}{' '}
                  tagged → upload a default photo, or open a design and set a
                  custom mockup.
                </p>
              ) : (
                <>
                  <div className="mockup-nav">
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      disabled={mockupLayers.length < 2}
                      onClick={() => stepMockup(-1)}
                      aria-label="Previous mockup"
                    >
                      ← Prev
                    </button>
                    <span className="mockup-nav-label" aria-live="polite">
                      {mockupIndex + 1} / {mockupLayers.length}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      disabled={mockupLayers.length < 2}
                      onClick={() => stepMockup(1)}
                      aria-label="Next mockup"
                    >
                      Next →
                    </button>
                  </div>
                  {activeMockupBg && (
                    <div className="mockup-size-controls" style={{ marginTop: 0 }}>
                      <p className="hint" style={{ margin: 0 }}>
                        Max PNG size on mockup (aspect locked)
                      </p>
                      <label className="field field-stack">
                        <span className="field-row">
                          Max width <em>{mockupLimits.maxWidth}px</em>
                        </span>
                        <input
                          type="range"
                          min={mockupSizeMin}
                          max={activeMockupBg.width}
                          step={10}
                          value={Math.min(activeMockupBg.width, mockupMaxWidth)}
                          onChange={(e) =>
                            setMockupMaxWidth(
                              Math.max(
                                mockupSizeMin,
                                Math.min(
                                  activeMockupBg.width,
                                  Number(e.target.value),
                                ),
                              ),
                            )
                          }
                          aria-label="Maximum PNG width on mockup"
                        />
                      </label>
                      <label className="field field-stack">
                        <span className="field-row">
                          Max height <em>{mockupLimits.maxHeight}px</em>
                        </span>
                        <input
                          type="range"
                          min={mockupSizeMin}
                          max={activeMockupBg.height}
                          step={10}
                          value={Math.min(activeMockupBg.height, mockupMaxHeight)}
                          onChange={(e) =>
                            setMockupMaxHeight(
                              Math.max(
                                mockupSizeMin,
                                Math.min(
                                  activeMockupBg.height,
                                  Number(e.target.value),
                                ),
                              ),
                            )
                          }
                          aria-label="Maximum PNG height on mockup"
                        />
                      </label>
                      <div className="fields">
                        <label className="field">
                          <span>Max W</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={mockupSizeMin}
                            max={activeMockupBg.width}
                            step={10}
                            value={mockupMaxWidth}
                            onChange={(e) => {
                              const v = Number(e.target.value) || mockupSizeMin
                              setMockupMaxWidth(
                                Math.max(
                                  mockupSizeMin,
                                  Math.min(activeMockupBg.width, Math.round(v)),
                                ),
                              )
                            }}
                            aria-label="Maximum PNG width in pixels"
                          />
                        </label>
                        <label className="field">
                          <span>Max H</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={mockupSizeMin}
                            max={activeMockupBg.height}
                            step={10}
                            value={mockupMaxHeight}
                            onChange={(e) => {
                              const v = Number(e.target.value) || mockupSizeMin
                              setMockupMaxHeight(
                                Math.max(
                                  mockupSizeMin,
                                  Math.min(
                                    activeMockupBg.height,
                                    Math.round(v),
                                  ),
                                ),
                              )
                            }}
                            aria-label="Maximum PNG height in pixels"
                          />
                        </label>
                      </div>
                      <div className="drop-actions" style={{ margin: 0 }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          onClick={clampAllMockupSizes}
                        >
                          Clamp all to max
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          onClick={() => {
                            if (!activeMockupBg) return
                            setMockupMaxWidth(
                              Math.floor(activeMockupBg.width * 0.55),
                            )
                            setMockupMaxHeight(
                              Math.floor(activeMockupBg.height * 0.55),
                            )
                          }}
                        >
                          Reset max 55%
                        </button>
                      </div>
                    </div>
                  )}
                  <label className="field">
                    <span>Current mockup design</span>
                    <select
                      className="select-input"
                      value={mockupSelected ?? ''}
                      onChange={(e) => selectMockup(e.target.value)}
                    >
                      {mockupLayers.map((l, i) => (
                        <option key={l.name} value={l.name}>
                          {i + 1}. {l.name}
                          {customMockupBgs[l.name] ? ' · custom bg' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {activeMockupLayer && (
                    <div className="mockup-size-controls">
                      <p className="hint" style={{ margin: 0 }}>
                        Background:{' '}
                        <strong>
                          {activeHasCustomBg
                            ? `Custom — ${customMockupBgs[activeMockupLayer.name]?.name}`
                            : mockupBg
                              ? `Default — ${mockupBg.name}`
                              : 'None'}
                        </strong>
                      </p>
                      <div className="drop-actions" style={{ margin: 0 }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          onClick={() => customMockupFileRef.current?.click()}
                        >
                          {activeHasCustomBg
                            ? 'Replace custom mockup…'
                            : 'Custom mockup for this PNG…'}
                        </button>
                        {activeHasCustomBg && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-compact"
                            onClick={() =>
                              clearCustomMockupFor(activeMockupLayer.name)
                            }
                          >
                            Use default mockup
                          </button>
                        )}
                      </div>
                      <p className="hint" style={{ margin: 0 }}>
                        Active design{' '}
                        <strong>
                          {Math.round(activeMockupLayer.width)}×
                          {Math.round(activeMockupLayer.height)}px
                        </strong>{' '}
                        · {mockupScalePct}% of max
                      </p>
                      <div className="fields">
                        <label className="field">
                          <span>W px</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={mockupSizeMin}
                            max={mockupLimits.maxWidth}
                            step={5}
                            value={Math.round(activeMockupLayer.width)}
                            onChange={(e) =>
                              resizeMockupLayer(
                                activeMockupLayer.name,
                                Number(e.target.value) || mockupSizeMin,
                                { axis: 'width' },
                              )
                            }
                          />
                        </label>
                        <label className="field">
                          <span>H px</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={mockupSizeMin}
                            max={mockupLimits.maxHeight}
                            step={5}
                            value={Math.round(activeMockupLayer.height)}
                            onChange={(e) =>
                              resizeMockupLayer(
                                activeMockupLayer.name,
                                Number(e.target.value) || mockupSizeMin,
                                { axis: 'height' },
                              )
                            }
                          />
                        </label>
                      </div>
                      <div className="drop-actions" style={{ margin: 0 }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          onClick={() => centerMockupLayer('both')}
                        >
                          Center
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          onClick={() => setViewMode('mockup')}
                        >
                          Edit on canvas
                        </button>
                      </div>
                    </div>
                  )}
                  {mockupLayers.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ width: '100%', marginBottom: '0.5rem' }}
                      onClick={applyPlacementToAll}
                    >
                      Apply this size &amp; position to all mockups
                    </button>
                  )}
                  <div className="drop-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={exportingMockup || !activeMockupLayer}
                      onClick={() => void downloadMockup()}
                    >
                      {exportingMockup ? 'Exporting…' : 'Download this mockup'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-export"
                      style={{ width: '100%' }}
                      disabled={exportingMockup || mockupLayers.length === 0}
                      onClick={() => void downloadAllMockups()}
                    >
                      {exportingMockup
                        ? 'Exporting…'
                        : `Download all ${mockupLayers.length} mockups`}
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          <div className="export-launch">
            <button
              type="button"
              className="btn btn-export"
              disabled={items.length === 0}
              onClick={() => setExportOpen(true)}
            >
              Export for Etsy…
            </button>
            {items.length > 0 && (
              <p className="meta" aria-live="polite">
                {canvasWidth}×{canvasHeight} · {items.length} PNGs
                {manualLayout ? ' · manual' : ''}
                {lastExportBytes != null
                  ? ` · last export ${formatBytes(lastExportBytes)}`
                  : ''}
              </p>
            )}
          </div>
        </aside>

        <main className="stage" aria-label="Preview">
          {sources.length === 0 ? (
            <div className="empty">
              <div className="empty-frame" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </div>
              <p className="empty-kicker">Your listing cover starts here</p>
              <p>
                Drop a folder of transparent PNGs to pack a sticker sheet that
                looks like a top Etsy photo&nbsp;1.
              </p>
              <ol className="empty-steps">
                <li>
                  <span>1</span>
                  Load PNGs from the panel on the left
                </li>
                <li>
                  <span>2</span>
                  Tweak layout, then download the cover JPG
                </li>
                <li>
                  <span>3</span>
                  Tag designs and place them on your mockup photo
                </li>
              </ol>
            </div>
          ) : (
            <div className="stage-stack">
              <div className="view-tabs-row">
                <div
                  className="view-tabs"
                  role="tablist"
                  aria-label="Preview mode"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === 'cover'}
                    className={`view-tab${viewMode === 'cover' ? ' is-active' : ''}`}
                    onClick={() => setViewMode('cover')}
                  >
                    Cover sheet
                    {coverPages.length > 1
                      ? ` (${safeCoverPageIndex + 1}/${coverPages.length})`
                      : ''}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === 'mockup'}
                    className={`view-tab${viewMode === 'mockup' ? ' is-active' : ''}`}
                    onClick={() => setViewMode('mockup')}
                  >
                    Mockups
                    {mockupLayers.length > 0 ? ` (${mockupLayers.length})` : ''}
                  </button>
                </div>
                {coverPages.length > 1 && viewMode === 'cover' && (
                  <div
                    className="cover-page-nav"
                    role="navigation"
                    aria-label="Cover pages"
                  >
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      onClick={() => goCoverPage(-1)}
                      aria-label="Previous cover"
                    >
                      ←
                    </button>
                    <span className="cover-page-label" aria-live="polite">
                      {safeCoverPageIndex + 1}/{coverPages.length}
                      <em>
                        {' '}
                        · {currentCoverSources.length} PNG
                        {currentCoverSources.length === 1 ? '' : 's'}
                      </em>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      onClick={() => goCoverPage(1)}
                      aria-label="Next cover"
                    >
                      →
                    </button>
                  </div>
                )}
              </div>
              {viewMode === 'cover' ? (
                <div className="preview-wrap" ref={wrapRef}>
                  <canvas
                    ref={previewRef}
                    className={`preview${drag ? ' is-dragging' : ''}${drag?.mode === 'resize' ? ' is-resizing' : ''}`}
                    onPointerDown={onPointerDown}
                    onPointerMove={(e) => {
                      onPointerMove(e)
                      if (!drag) onCanvasCursor(e)
                    }}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onContextMenu={onCoverContextMenu}
                    onPointerLeave={() => {
                      if (previewRef.current && !drag) {
                        previewRef.current.style.cursor = 'grab'
                      }
                    }}
                    role="img"
                    aria-label={`Cover ${safeCoverPageIndex + 1} of ${coverPageCount} — click or right-click a PNG for options`}
                  />
                </div>
              ) : (
                <div className="preview-wrap mockup-wrap">
                  {!mockupBg && Object.keys(customMockupBgs).length === 0 ? (
                    <div className="mockup-empty">
                      <p>
                        Upload a default mockup photo, or tag a PNG and assign a
                        custom mockup for that design only.
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => mockupFileRef.current?.click()}
                      >
                        Upload default mockup…
                      </button>
                    </div>
                  ) : mockupLayers.length === 0 ? (
                    <div className="mockup-empty">
                      <p>
                        Tag PNGs with ○ in the list. 3 tagged designs = 3
                        mockups. Click each one below to place it — and set a
                        custom background per PNG if you want.
                      </p>
                    </div>
                  ) : !activeMockupBg ? (
                    <div className="mockup-empty">
                      <p>
                        This PNG has no mockup photo yet. Upload a default, or
                        choose a custom mockup for it.
                      </p>
                      <div className="drop-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => mockupFileRef.current?.click()}
                        >
                          Upload default…
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => customMockupFileRef.current?.click()}
                        >
                          Custom for this PNG…
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mockup-switcher" role="tablist" aria-label="Mockup designs">
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          disabled={mockupLayers.length < 2}
                          onClick={() => stepMockup(-1)}
                          aria-label="Previous mockup"
                        >
                          ←
                        </button>
                        <div className="mockup-chips">
                          {mockupLayers.map((l, i) => {
                            const src = items.find((it) => it.name === l.name)
                            const active = l.name === mockupSelected
                            const isCustom = Boolean(customMockupBgs[l.name])
                            return (
                              <button
                                key={l.name}
                                type="button"
                                role="tab"
                                aria-selected={active}
                                className={`mockup-chip${active ? ' is-active' : ''}${isCustom ? ' has-custom-bg' : ''}`}
                                onClick={() => selectMockup(l.name)}
                                title={
                                  isCustom
                                    ? `${l.name} (custom mockup)`
                                    : l.name
                                }
                              >
                                <span className="mockup-chip-thumb" aria-hidden="true">
                                  {src ? (
                                    <ItemThumb bitmap={src.bitmap} name={l.name} />
                                  ) : (
                                    i + 1
                                  )}
                                </span>
                                <span className="mockup-chip-meta">
                                  <span className="mockup-chip-index">
                                    {i + 1}/{mockupLayers.length}
                                    {isCustom ? ' · custom' : ''}
                                  </span>
                                  <span className="mockup-chip-name">{l.name}</span>
                                </span>
                              </button>
                            )
                          })}
                        </div>
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          disabled={mockupLayers.length < 2}
                          onClick={() => stepMockup(1)}
                          aria-label="Next mockup"
                        >
                          →
                        </button>
                      </div>
                      {activeMockupLayer && (
                        <div className="mockup-hud" role="toolbar" aria-label="Design size and position">
                          <div className="mockup-hud-bg">
                            <span className="mockup-hud-bg-label">
                              {activeHasCustomBg ? 'Custom bg' : 'Default bg'}
                            </span>
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              onClick={() => customMockupFileRef.current?.click()}
                            >
                              {activeHasCustomBg ? 'Change…' : 'Custom…'}
                            </button>
                            {activeHasCustomBg && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-compact"
                                onClick={() =>
                                  clearCustomMockupFor(activeMockupLayer.name)
                                }
                              >
                                Default
                              </button>
                            )}
                          </div>
                          <div className="mockup-hud-scale">
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              onClick={() => setMockupScalePct(mockupScalePct - 5)}
                              aria-label="Scale down 5 percent"
                            >
                              −
                            </button>
                            <label className="mockup-hud-slider">
                              <span className="sr-only">Scale</span>
                              <input
                                type="range"
                                min={8}
                                max={100}
                                step={1}
                                value={Math.min(100, mockupScalePct)}
                                onChange={(e) =>
                                  setMockupScalePct(Number(e.target.value))
                                }
                                aria-valuetext={`${mockupScalePct} percent of max size`}
                                aria-label="Design scale percent of max size"
                              />
                            </label>
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              onClick={() => setMockupScalePct(mockupScalePct + 5)}
                              aria-label="Scale up 5 percent"
                            >
                              +
                            </button>
                            <span className="mockup-hud-pct" aria-live="polite">
                              {mockupScalePct}%
                            </span>
                          </div>
                          <div className="mockup-hud-presets" role="group" aria-label="Size presets">
                            {[25, 40, 55, 70, 100].map((p) => (
                              <button
                                key={p}
                                type="button"
                                className={`btn btn-ghost btn-compact mockup-preset${
                                  mockupScalePct === p ? ' is-active' : ''
                                }`}
                                onClick={() => setMockupScalePct(p)}
                                aria-pressed={mockupScalePct === p}
                              >
                                {p}%
                              </button>
                            ))}
                          </div>
                          <div className="mockup-hud-meta">
                            <span className="mockup-size-readout">
                              {Math.round(activeMockupLayer.width)}×
                              {Math.round(activeMockupLayer.height)}px
                            </span>
                          </div>
                          <div className="mockup-hud-nudge" role="group" aria-label="Nudge design">
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              onClick={() => nudgeMockup(-10, 0)}
                              aria-label="Nudge left"
                            >
                              ←
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              onClick={() => nudgeMockup(0, -10)}
                              aria-label="Nudge up"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              onClick={() => nudgeMockup(0, 10)}
                              aria-label="Nudge down"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              onClick={() => nudgeMockup(10, 0)}
                              aria-label="Nudge right"
                            >
                              →
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              onClick={() => centerMockupLayer('both')}
                              aria-label="Center on mockup"
                            >
                              Center
                            </button>
                          </div>
                        </div>
                      )}
                      <p className="mockup-editing" aria-live="polite">
                        Drag design to move · corner handles to resize · scale bar for precise size.
                      </p>
                      <canvas
                        ref={mockupRef}
                        className={`preview mockup-preview${mockupDrag ? ' is-dragging' : ''}${mockupDrag?.mode === 'resize' ? ' is-resizing' : ''}`}
                        style={{
                          aspectRatio: `${activeMockupBg.width} / ${activeMockupBg.height}`,
                        }}
                        onPointerDown={onMockupPointerDown}
                        onPointerMove={onMockupPointerMove}
                        onPointerUp={onMockupPointerUp}
                        onPointerCancel={onMockupPointerUp}
                        role="img"
                        aria-label={`Mockup ${mockupIndex + 1} of ${mockupLayers.length}${activeMockupLayer ? `: ${activeMockupLayer.name}` : ''} — drag to move, corners to resize`}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {coverCtxMenu && ctxMenuSelected && viewMode === 'cover' && (
        <div
          ref={coverCtxMenuRef}
          className="cover-context-menu"
          role="menu"
          aria-label={`Actions for ${ctxMenuSelected.name}`}
          style={{ left: coverCtxMenu.x, top: coverCtxMenu.y }}
        >
          <p className="selected-name" title={ctxMenuSelected.name}>
            {ctxMenuSelected.name}
          </p>
          <button
            type="button"
            className="btn btn-primary btn-compact"
            style={{ width: '100%' }}
            role="menuitem"
            onClick={() => {
              doubleAndCenterItem(ctxMenuSelected.id)
            }}
          >
            2× size &amp; center
          </button>
          <button
            type="button"
            className={`btn btn-compact tag-btn${mockupTags.has(ctxMenuSelected.name) ? ' is-tagged' : ''}`}
            style={{ width: '100%' }}
            role="menuitem"
            onClick={() => toggleMockupTag(ctxMenuSelected.name)}
          >
            {mockupTags.has(ctxMenuSelected.name)
              ? 'Tagged for mockup'
              : 'Tag for mockup'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-compact btn-remove"
            style={{ width: '100%' }}
            role="menuitem"
            onClick={() => {
              removeItem(ctxMenuSelected.id)
              closeCoverCtxMenu()
            }}
          >
            Remove from cover
          </button>
          <label className="field field-stack">
            <span className="field-row">
              Resize <em>{Math.round(ctxMenuSelected.width)}px</em>
            </span>
            <input
              type="range"
              min={sizeMin}
              max={sizeMax}
              step={5}
              value={Math.round(ctxMenuSelected.width)}
              onChange={(e) =>
                resizeItem(ctxMenuSelected.id, Number(e.target.value))
              }
              aria-label={`Resize ${ctxMenuSelected.name}`}
            />
          </label>
          <div className="resize-row">
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={() =>
                resizeItem(ctxMenuSelected.id, ctxMenuSelected.width - 20)
              }
              aria-label="Make smaller"
            >
              − Smaller
            </button>
            <input
              type="number"
              inputMode="numeric"
              className="resize-input"
              min={sizeMin}
              max={sizeMax}
              step={5}
              value={Math.round(ctxMenuSelected.width)}
              onChange={(e) =>
                resizeItem(
                  ctxMenuSelected.id,
                  Number(e.target.value) || sizeMin,
                )
              }
              aria-label={`Size in pixels for ${ctxMenuSelected.name}`}
            />
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={() =>
                resizeItem(ctxMenuSelected.id, ctxMenuSelected.width + 20)
              }
              aria-label="Make larger"
            >
              Larger +
            </button>
          </div>
        </div>
      )}

      {exportOpen && (
        <div
          className="modal-root"
          role="presentation"
          onMouseDown={(e) => {
            if (
              e.target === e.currentTarget &&
              !exporting &&
              !exportingVideo &&
              !listingGenerating
            ) {
              setExportOpen(false)
            }
          }}
        >
          <div
            className="modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={exportTitleId}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2 id={exportTitleId}>Export for Etsy</h2>
              <button
                ref={exportCloseRef}
                type="button"
                className="btn btn-ghost btn-compact modal-close"
                onClick={() => setExportOpen(false)}
                disabled={exporting || exportingVideo || listingGenerating}
                aria-label="Close export"
              >
                Close
              </button>
            </div>
            <div className="modal-body">
              <section className="modal-section" aria-label="Cover image">
                <h3>Cover image</h3>
                <div
                  className="presets mode-toggle"
                  role="group"
                  aria-label="Export format"
                >
                  <button
                    type="button"
                    className={`chip${exportFormat === 'image/jpeg' ? ' is-active' : ''}`}
                    onClick={() => setExportFormat('image/jpeg')}
                  >
                    JPG (recommended)
                  </button>
                  <button
                    type="button"
                    className={`chip${exportFormat === 'image/png' ? ' is-active' : ''}`}
                    onClick={() => setExportFormat('image/png')}
                  >
                    PNG
                  </button>
                </div>
                {exportFormat === 'image/jpeg' && (
                  <label className="field field-stack">
                    <span className="field-row">
                      Quality <em>{Math.round(exportQuality * 100)}%</em>
                    </span>
                    <input
                      type="range"
                      min={60}
                      max={95}
                      step={1}
                      value={Math.round(exportQuality * 100)}
                      onChange={(e) =>
                        setExportQuality(Number(e.target.value) / 100)
                      }
                    />
                  </label>
                )}
                <p className="hint">
                  JPG stays smaller for uploads. If the file is over 1&nbsp;MB,
                  quality is auto-reduced.
                </p>
                {coverPages.length > 1 && (
                  <p className="hint">
                    Will download {coverPages.length} covers (
                    {coverPages.map((p) => p.length).join(' + ')} PNGs).
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-export"
                  disabled={sources.length === 0 || exporting || exportingVideo}
                  onClick={() => void download()}
                >
                  {exporting ? (
                    <>
                      <span className="spinner" aria-hidden="true" />
                      Exporting…
                    </>
                  ) : coverPages.length > 1 ? (
                    `Download ${coverPages.length} covers (${exportFormat === 'image/jpeg' ? 'JPG' : 'PNG'})`
                  ) : (
                    `Download Etsy cover (${exportFormat === 'image/jpeg' ? 'JPG' : 'PNG'})`
                  )}
                </button>
              </section>

              <section className="modal-section" aria-label="Listing video">
                <h3>Listing video</h3>
                {videoOrder.length > 0 ? (
                  <div className="video-controls">
                    <label className="field field-stack">
                      <span className="field-row">
                        Video length{' '}
                        <em>
                          {videoDurationSec}s
                          {videoOrder.length > 0
                            ? ` · ~${(videoDurationSec / videoOrder.length).toFixed(1)}s / shot`
                            : ''}
                        </em>
                      </span>
                      <input
                        type="range"
                        min={ETSY_VIDEO_MIN_SEC}
                        max={ETSY_VIDEO_MAX_SEC}
                        step={1}
                        value={videoDurationSec}
                        onChange={(e) =>
                          setVideoDurationSec(Number(e.target.value))
                        }
                        aria-label="Listing video duration in seconds"
                      />
                    </label>
                    <p className="hint">
                      Etsy allows {ETSY_VIDEO_MIN_SEC}–{ETSY_VIDEO_MAX_SEC}s.
                      Reorder shots with the arrows (cover + mockups).
                    </p>
                    <ol className="video-order" aria-label="Video shot order">
                      {videoOrder.map((id, index) => (
                        <li key={id} className="video-order-row">
                          <span className="video-order-index">{index + 1}</span>
                          <span
                            className="video-order-label"
                            title={videoClipLabel(id)}
                          >
                            {id === 'cover' ? (
                              <strong>Cover sheet</strong>
                            ) : (
                              <>
                                <span className="video-order-kind">Mockup</span>{' '}
                                {videoClipLabel(id)}
                              </>
                            )}
                          </span>
                          <div className="video-order-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              disabled={index === 0 || exportingVideo}
                              onClick={() => moveVideoClip(index, -1)}
                              aria-label={`Move ${videoClipLabel(id)} earlier`}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              disabled={
                                index === videoOrder.length - 1 ||
                                exportingVideo
                              }
                              onClick={() => moveVideoClip(index, 1)}
                              aria-label={`Move ${videoClipLabel(id)} later`}
                            >
                              ↓
                            </button>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : (
                  <p className="hint">
                    Build a cover (and optionally tag mockups) to include shots
                    in the video.
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: '100%', marginTop: '0.55rem' }}
                  disabled={
                    videoOrder.length === 0 || exporting || exportingVideo
                  }
                  onClick={() => void downloadListingVideo()}
                >
                  {exportingVideo ? (
                    <>
                      <span className="spinner" aria-hidden="true" />
                      Making video… {Math.round(videoProgress * 100)}%
                    </>
                  ) : (
                    'Download listing video'
                  )}
                </button>
                <p className="hint" style={{ marginTop: '0.55rem' }}>
                  Ideal ≥1080px · MP4 when your browser supports it
                  {mockupLayers.length === 0
                    ? ' · tag PNGs + upload a mockup photo to add lifestyle shots'
                    : ''}
                  .
                </p>
              </section>

              <section className="modal-section" aria-label="Listing copy">
                <h3>Listing copy (AI)</h3>
                <p className="hint">
                  Uses your cover + design images and a reference .txt (example
                  title, description, tags + rules). Filenames are ignored.
                </p>
                <p className="listing-quota" aria-live="polite">
                  Free AI uses left:{' '}
                  <strong>
                    {Math.max(0, listingFreeRemaining)}/{LISTING_FREE_QUOTA}
                  </strong>
                </p>

                <input
                  ref={listingRefInputRef}
                  type="file"
                  accept=".txt,text/plain"
                  className="sr-only"
                  onChange={(e) => void onListingRefFile(e)}
                />
                <div className="drop-actions" style={{ marginBottom: '0.55rem' }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={listingGenerating}
                    onClick={() => listingRefInputRef.current?.click()}
                  >
                    {listingRefName
                      ? `Reference: ${listingRefName}`
                      : 'Upload reference .txt…'}
                  </button>
                  {listingRefText ? (
                    <span className="hint" style={{ margin: 0 }}>
                      {listingRefText.length.toLocaleString()} chars
                    </span>
                  ) : null}
                </div>

                <label className="field field-stack">
                  <span>Extra guidelines (optional)</span>
                  <textarea
                    className="listing-textarea"
                    rows={3}
                    value={listingGuidelines}
                    onChange={(e) => setListingGuidelines(e.target.value)}
                    placeholder="Rules for title, description, and tags…"
                    disabled={listingGenerating}
                  />
                </label>

                <label className="field field-stack">
                  <span>
                    Listing subject{' '}
                    {listingNeedsName ? (
                      <em>(required — AI couldn’t tell from images)</em>
                    ) : (
                      <em>(optional)</em>
                    )}
                  </span>
                  <input
                    type="text"
                    value={listingSubject}
                    onChange={(e) => setListingSubject(e.target.value)}
                    placeholder={
                      listingSubjectGuess
                        ? `e.g. ${listingSubjectGuess}`
                        : 'e.g. Beauty and the Beast SVG stickers'
                    }
                    disabled={listingGenerating}
                    aria-invalid={listingNeedsName && !listingSubject.trim()}
                  />
                </label>

                {listingFreeRemaining <= 0 && (
                  <div className="listing-key-box">
                    <label className="field field-stack">
                      <span className="field-row">
                        Your OpenAI API key
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          onClick={() => setListingShowKey((v) => !v)}
                        >
                          {listingShowKey ? 'Hide' : 'Show'}
                        </button>
                      </span>
                      <input
                        type={listingShowKey ? 'text' : 'password'}
                        autoComplete="off"
                        spellCheck={false}
                        value={listingUserKey}
                        onChange={(e) => setListingUserKey(e.target.value)}
                        placeholder="sk-…"
                        disabled={listingGenerating}
                        aria-label="OpenAI API key"
                      />
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={listingRememberKey}
                        onChange={(e) =>
                          setListingRememberKey(e.target.checked)
                        }
                        disabled={listingGenerating}
                      />
                      <span>Save key in this browser only</span>
                    </label>
                  </div>
                )}

                {listingError && (
                  <p className="error" role="alert">
                    {listingError}
                  </p>
                )}

                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: '100%', marginTop: '0.35rem' }}
                  disabled={
                    listingGenerating ||
                    items.length === 0 ||
                    !listingRefText.trim() ||
                    (listingFreeRemaining <= 0 && !listingUserKey.trim())
                  }
                  onClick={() => void generateListingCopy()}
                >
                  {listingGenerating ? (
                    <>
                      <span className="spinner" aria-hidden="true" />
                      Generating listing copy…
                    </>
                  ) : (
                    'Generate title, description & tags'
                  )}
                </button>

                {(listingCopy.title ||
                  listingCopy.description ||
                  listingCopy.tags.length > 0) && (
                  <div className="listing-results">
                    <label className="field field-stack">
                      <span className="field-row">
                        Title{' '}
                        <em>
                          {listingCopy.title.length}/{ETSY_TITLE_MAX}
                        </em>
                      </span>
                      <input
                        type="text"
                        value={listingCopy.title}
                        maxLength={ETSY_TITLE_MAX}
                        onChange={(e) =>
                          setListingCopy((c) => ({
                            ...c,
                            title: clampTitle(e.target.value),
                          }))
                        }
                      />
                      <button
                        type="button"
                        className="btn btn-ghost btn-compact"
                        onClick={() =>
                          void copyListingField('title', listingCopy.title)
                        }
                      >
                        {listingCopied === 'title' ? 'Copied' : 'Copy title'}
                      </button>
                    </label>

                    <label className="field field-stack">
                      <span className="field-row">Description</span>
                      <textarea
                        className="listing-textarea listing-textarea-lg"
                        rows={8}
                        value={listingCopy.description}
                        onChange={(e) =>
                          setListingCopy((c) => ({
                            ...c,
                            description: e.target.value,
                          }))
                        }
                      />
                      <button
                        type="button"
                        className="btn btn-ghost btn-compact"
                        onClick={() =>
                          void copyListingField(
                            'description',
                            listingCopy.description,
                          )
                        }
                      >
                        {listingCopied === 'description'
                          ? 'Copied'
                          : 'Copy description'}
                      </button>
                    </label>

                    <label className="field field-stack">
                      <span className="field-row">
                        Tags{' '}
                        <em>
                          {listingCopy.tags.length}/{ETSY_TAG_MAX} · max{' '}
                          {ETSY_TAG_CHAR_MAX} chars each
                        </em>
                      </span>
                      <input
                        type="text"
                        value={listingCopy.tags.join(', ')}
                        onChange={(e) =>
                          setListingCopy((c) => ({
                            ...c,
                            tags: normalizeTags(
                              e.target.value.split(/[,|\n]/),
                            ),
                          }))
                        }
                        placeholder="tag one, tag two…"
                      />
                      <div className="listing-tag-chips" aria-hidden="true">
                        {listingCopy.tags.map((t) => (
                          <span key={t} className="listing-tag-chip">
                            {t}
                          </span>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-compact"
                        onClick={() =>
                          void copyListingField(
                            'tags',
                            listingCopy.tags.join(', '),
                          )
                        }
                      >
                        {listingCopied === 'tags' ? 'Copied' : 'Copy tags'}
                      </button>
                    </label>

                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ width: '100%' }}
                      onClick={() =>
                        void copyListingField(
                          'all',
                          listingCopyPlainText(listingCopy),
                        )
                      }
                    >
                      {listingCopied === 'all' ? 'Copied all' : 'Copy all'}
                    </button>
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
