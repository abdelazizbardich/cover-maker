import { useCallback, useEffect, useId, useRef, useState } from 'react'
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
  type MockupBackground,
  type MockupLayer,
} from './lib/mockup'
import {
  clearDefaultMockup,
  loadDefaultMockup,
  saveDefaultMockup,
} from './lib/mockupStore'
import {
  closeBitmaps,
  drawPackedItem,
  isBitmapLive,
  loadPngFiles,
  packImages,
  renderCover,
  type ExportFormat,
  type PackMode,
  type PackOptions,
  type PackedRect,
  type SourceImage,
} from './lib/pack'
import './App.css'

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
): Corner | null {
  const r = handleRadius(item, canvasWidth)
  const corners = cornerPoints(item)
  for (const key of Object.keys(corners) as Corner[]) {
    const c = corners[key]
    if (Math.hypot(x - c.x, y - c.y) <= r) return key
  }
  return null
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

  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportingMockup, setExportingMockup] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const [canvasWidth, setCanvasWidth] = useState(3000)
  const [canvasHeight, setCanvasHeight] = useState(3000)
  const [gap, setGap] = useState(20)
  const [margin, setMargin] = useState(40)
  const [columns, setColumns] = useState(0) // 0 = auto
  /** 0 = auto; rows = row height; grid = cell size */
  const [itemSize, setItemSize] = useState(0)
  const [packMode, setPackMode] = useState<PackMode>('rows')
  const [background, setBackground] = useState('#ffffff')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('image/jpeg')
  const [exportQuality, setExportQuality] = useState(0.88)
  const [lastExportBytes, setLastExportBytes] = useState<number | null>(null)

  /** Filenames tagged for lifestyle mockups (Etsy gallery photos). */
  const [mockupTags, setMockupTags] = useState<Set<string>>(() => new Set())
  const [viewMode, setViewMode] = useState<'cover' | 'mockup'>('cover')
  const [mockupBg, setMockupBg] = useState<MockupBackground | null>(null)
  const [mockupLayers, setMockupLayers] = useState<MockupLayer[]>([])
  const [mockupSelected, setMockupSelected] = useState<string | null>(null)
  const [mockupDrag, setMockupDrag] = useState<DragState | null>(null)

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

  const sizeMax = Math.max(80, Math.floor(Math.min(canvasWidth, canvasHeight) * 0.9))
  const sizeMin = 40
  const mockupSizeMin = 40
  const mockupSizeMax = mockupBg
    ? Math.max(80, Math.floor(Math.min(mockupBg.width, mockupBg.height) * 0.95))
    : 2000

  const taggedItems = items.filter((it) => mockupTags.has(it.name))
  const activeMockupLayer =
    mockupLayers.find((l) => l.name === mockupSelected) ?? null
  const mockupIndex = activeMockupLayer
    ? mockupLayers.findIndex((l) => l.name === activeMockupLayer.name)
    : -1

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
        applyPack(loaded, {
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

  // Re-auto-pack when packing settings change (unless user moved things)
  useEffect(() => {
    if (sources.length === 0 || manualLayout) return
    applyPack(sources, options)
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

  // Sync mockup layers with tags + bitmaps (keep positions)
  useEffect(() => {
    setMockupLayers((prev) => {
      const byName = new Map(
        items.map((it) => [
          it.name,
          { name: it.name, bitmap: it.bitmap, width: it.bitmap.width, height: it.bitmap.height },
        ]),
      )
      let next = prev
        .filter((l) => mockupTags.has(l.name))
        .map((l) => {
          const src = byName.get(l.name)
          return src ? { ...l, bitmap: src.bitmap } : l
        })

      if (mockupBg) {
        for (const name of mockupTags) {
          if (next.some((l) => l.name === name)) continue
          const src = byName.get(name)
          if (src) next = [...next, defaultLayerPlacement(mockupBg, src)]
        }
      }
      return next
    })
  }, [items, mockupTags, mockupBg])

  // Draw current mockup only (one PNG per mockup)
  useEffect(() => {
    if (viewMode !== 'mockup' || !mockupBg) return
    const canvas = mockupRef.current
    if (!canvas) return
    const layer =
      mockupLayers.find((l) => l.name === mockupSelected) ?? null
    paintUserMockup(canvas, mockupBg, layer, true)
  }, [viewMode, mockupBg, mockupLayers, mockupSelected])

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

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = previewRef.current
    if (!canvas || items.length === 0) return
    const pt = canvasPoint(canvas, e.clientX, e.clientY)

    // Prefer resize handles on the current selection
    if (selectedId) {
      const sel = items.find((it) => it.id === selectedId)
      if (sel) {
        const corner = hitCorner(sel, pt.x, pt.y, canvasWidth)
        if (corner) {
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
      return
    }

    // Clicking a handle of a newly selected item in the same gesture
    const corner = hitCorner(hit, pt.x, pt.y, canvasWidth)
    setSelectedId(hit.id)
    bringToFront(hit.id)
    if (corner) {
      setDrag({
        mode: 'resize',
        id: hit.id,
        corner,
        anchorX: pt.x,
        anchorY: pt.y,
      })
    } else {
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
    setDrag(null)
    try {
      previewRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
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

  const download = async () => {
    if (items.length === 0) return
    setExporting(true)
    try {
      // Prefer JPEG for Etsy uploads; always bake opaque background
      let quality = exportQuality
      let blob = await renderCover(
        {
          items,
          cellSize: cellSize || items[0]?.height || 0,
          columns: gridCols,
          rows: gridRows,
          usedHeight: canvasHeight,
          mode: packMode,
          scale: cellSize || items[0]?.height || 0,
        },
        { ...options, background: background || '#ffffff' },
        { format: exportFormat, quality },
      )

      // Auto-tighten JPEG if over Etsy's comfortable upload size
      if (
        exportFormat === 'image/jpeg' &&
        blob.size > ETSY_TARGET_MAX_BYTES &&
        quality > 0.6
      ) {
        for (const q of [0.8, 0.72, 0.65, 0.58]) {
          if (q >= quality) continue
          const next = await renderCover(
            {
              items,
              cellSize: cellSize || items[0]?.height || 0,
              columns: gridCols,
              rows: gridRows,
              usedHeight: canvasHeight,
              mode: packMode,
              scale: cellSize || items[0]?.height || 0,
            },
            { ...options, background: background || '#ffffff' },
            { format: 'image/jpeg', quality: q },
          )
          blob = next
          quality = q
          if (blob.size <= ETSY_TARGET_MAX_BYTES) break
        }
      }

      setLastExportBytes(blob.size)
      const ext = exportFormat === 'image/jpeg' ? 'jpg' : 'png'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `etsy-cover-${canvasWidth}x${canvasHeight}.${ext}`
      a.click()
      URL.revokeObjectURL(url)
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
    setMockupTags(new Set())
    setMockupLayers([])
    setMockupSelected(null)
    // Keep mockupBg — default photo is stored for reuse across sessions
    setError(null)
    replaceSources([])
  }

  const applyMockupBackground = useCallback(
    (loaded: MockupBackground) => {
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
      setMockupLayers((layers) =>
        layers.map((l) =>
          defaultLayerPlacement(loaded, {
            name: l.name,
            bitmap: l.bitmap,
            width: l.bitmap.width,
            height: l.bitmap.height,
          }),
        ),
      )
    },
    [],
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
    setMockupLayers((layers) =>
      layers.map((l) => ({ ...l })), // keep tags; positions re-init when new bg loads
    )
    void clearDefaultMockup().catch(() => {
      /* ignore */
    })
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
      opts?: { x?: number; y?: number; fromCenter?: boolean },
    ) => {
      const next = Math.max(mockupSizeMin, Math.min(mockupSizeMax, Math.round(size)))
      setMockupLayers((prev) =>
        prev.map((l) => {
          if (l.name !== name) return l
          // Keep aspect ratio of the design
          const aspect = l.bitmap.width / l.bitmap.height
          let width = next
          let height = next / aspect
          if (aspect < 1) {
            height = next
            width = next * aspect
          }
          if (opts?.x != null && opts?.y != null) {
            return { ...l, x: opts.x, y: opts.y, width, height }
          }
          const cx = l.x + l.width / 2
          const cy = l.y + l.height / 2
          return {
            ...l,
            width,
            height,
            x: cx - width / 2,
            y: cy - height / 2,
          }
        }),
      )
    },
    [mockupSizeMin, mockupSizeMax],
  )

  const onMockupPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = mockupRef.current
    const sel = mockupLayersRef.current.find((l) => l.name === mockupSelected)
    if (!canvas || !mockupBg || !sel) return
    const pt = canvasPoint(canvas, e.clientX, e.clientY)
    const asItem = { ...sel, id: sel.name }

    const corner = hitCorner(asItem, pt.x, pt.y, mockupBg.width)
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
    if (!mockupDrag || !mockupBg) return
    const canvas = mockupRef.current
    if (!canvas) return
    const pt = canvasPoint(canvas, e.clientX, e.clientY)
    const current = mockupLayersRef.current.find((l) => l.name === mockupDrag.id)
    if (!current) return

    if (mockupDrag.mode === 'resize') {
      const asItem = { ...current, id: current.name }
      const next = resizeFromCorner(
        asItem,
        mockupDrag.corner,
        pt.x,
        pt.y,
        mockupSizeMin,
        mockupSizeMax,
      )
      // Preserve aspect from design
      const aspect = current.bitmap.width / current.bitmap.height
      let width = next.width
      let height = width / aspect
      if (mockupDrag.corner === 'se') {
        setMockupLayers((prev) =>
          prev.map((l) =>
            l.name === mockupDrag.id
              ? { ...l, x: current.x, y: current.y, width, height }
              : l,
          ),
        )
      } else if (mockupDrag.corner === 'sw') {
        setMockupLayers((prev) =>
          prev.map((l) =>
            l.name === mockupDrag.id
              ? {
                  ...l,
                  x: current.x + current.width - width,
                  y: current.y,
                  width,
                  height,
                }
              : l,
          ),
        )
      } else if (mockupDrag.corner === 'ne') {
        setMockupLayers((prev) =>
          prev.map((l) =>
            l.name === mockupDrag.id
              ? {
                  ...l,
                  x: current.x,
                  y: current.y + current.height - height,
                  width,
                  height,
                }
              : l,
          ),
        )
      } else {
        setMockupLayers((prev) =>
          prev.map((l) =>
            l.name === mockupDrag.id
              ? {
                  ...l,
                  x: current.x + current.width - width,
                  y: current.y + current.height - height,
                  width,
                  height,
                }
              : l,
          ),
        )
      }
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
          resizeMockupLayer(layer.name, layer.width - sizeStep)
          return
        }
        if (e.key === ']' || e.key === '=' || e.key === '+') {
          e.preventDefault()
          resizeMockupLayer(layer.name, layer.width + sizeStep)
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
    moveMockupLayer,
    resizeMockupLayer,
    stepMockup,
  ])

  /** Copy current design’s position/size onto every mockup. */
  const applyPlacementToAll = () => {
    const src = mockupLayers.find((l) => l.name === mockupSelected)
    if (!src) return
    setMockupLayers((prev) =>
      prev.map((l) => {
        if (l.name === src.name) return l
        const aspect = l.bitmap.width / l.bitmap.height
        const width = src.width
        const height = width / aspect
        const cx = src.x + src.width / 2
        const cy = src.y + src.height / 2
        return {
          ...l,
          width,
          height,
          x: cx - width / 2,
          y: cy - height / 2,
        }
      }),
    )
  }

  const downloadMockup = async () => {
    if (!mockupBg) {
      setError('Upload a mockup image first (your tee flat-lay photo).')
      return
    }
    const layer = mockupLayers.find((l) => l.name === mockupSelected)
    if (!layer) {
      setError('Tag at least one PNG — each tagged PNG becomes its own mockup.')
      return
    }
    setExportingMockup(true)
    setError(null)
    try {
      const blob = await exportUserMockup(mockupBg, layer, 0.9)
      const stem = layer.name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 60)
      await downloadBlob(blob, `etsy-mockup-${stem || 'design'}.jpg`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mockup export failed')
    } finally {
      setExportingMockup(false)
    }
  }

  const downloadAllMockups = async () => {
    if (!mockupBg) {
      setError('Upload a mockup image first (your tee flat-lay photo).')
      return
    }
    if (mockupLayers.length === 0) {
      setError('Tag PNGs first — each one exports as a separate mockup.')
      return
    }
    setExportingMockup(true)
    setError(null)
    try {
      const n = await exportAllMockups(mockupBg, mockupLayers, 0.9)
      setError(null)
      // brief status via meta — reuse error as polite info is awkward; leave clean
      void n
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mockup export failed')
    } finally {
      setExportingMockup(false)
    }
  }

  const autoArrange = () => {
    if (sources.length === 0) return
    applyPack(sources, options)
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
    applyPack(shuffled, options)
  }

  const selected = items.find((it) => it.id === selectedId) ?? null

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
                : 'Every PNG sits in an equal square cell.'}
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
                Select a PNG to move/resize or remove. Randomize shuffles grid
                cells. Keys: [ ] resize · arrows nudge · Delete remove.
              </p>
              {selected && (
                <div className="selected-resize">
                  <p className="selected-name" title={selected.name}>
                    {selected.name}
                  </p>
                  <button
                    type="button"
                    className={`btn btn-compact tag-btn${mockupTags.has(selected.name) ? ' is-tagged' : ''}`}
                    onClick={() => toggleMockupTag(selected.name)}
                  >
                    {mockupTags.has(selected.name)
                      ? 'Tagged for mockup'
                      : 'Tag for mockup'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact btn-remove"
                    onClick={() => removeItem(selected.id)}
                  >
                    Remove from cover
                  </button>
                  <label className="field field-stack">
                    <span className="field-row">
                      Resize <em>{Math.round(selected.width)}px</em>
                    </span>
                    <input
                      type="range"
                      min={sizeMin}
                      max={sizeMax}
                      step={5}
                      value={Math.round(selected.width)}
                      onChange={(e) =>
                        resizeItem(selected.id, Number(e.target.value))
                      }
                      aria-label={`Resize ${selected.name}`}
                    />
                  </label>
                  <div className="resize-row">
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      onClick={() =>
                        resizeItem(selected.id, selected.width - 20)
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
                      value={Math.round(selected.width)}
                      onChange={(e) =>
                        resizeItem(
                          selected.id,
                          Number(e.target.value) || sizeMin,
                        )
                      }
                      aria-label={`Size in pixels for ${selected.name}`}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      onClick={() =>
                        resizeItem(selected.id, selected.width + 20)
                      }
                      aria-label="Make larger"
                    >
                      Larger +
                    </button>
                  </div>
                </div>
              )}
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
                Upload one flat-lay photo — it’s saved in this browser for next
                time. Each tagged PNG becomes its own mockup.
              </p>
              <input
                ref={mockupFileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                className="sr-only"
                onChange={(e) => void onMockupFile(e)}
              />
              <div className="drop-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => mockupFileRef.current?.click()}
                >
                  {mockupBg ? 'Replace mockup image…' : 'Upload mockup image…'}
                </button>
                {mockupBg && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={clearMockupBg}
                  >
                    Clear saved mockup
                  </button>
                )}
              </div>
              {mockupBg && (
                <p className="meta" style={{ textAlign: 'left' }}>
                  {mockupBg.name} · {mockupBg.width}×{mockupBg.height}
                  {mockupLayers.length > 0
                    ? ` · ${mockupLayers.length} mockup${mockupLayers.length === 1 ? '' : 's'}`
                    : ''}
                  {' · '}
                  saved as default
                </p>
              )}
              {taggedItems.length === 0 ? (
                <p className="hint">Tag PNGs in the list — one mockup per PNG.</p>
              ) : !mockupBg ? (
                <p className="hint">
                  {taggedItems.length} PNG{taggedItems.length === 1 ? '' : 's'}{' '}
                  tagged → {taggedItems.length} mockup
                  {taggedItems.length === 1 ? '' : 's'} once you upload a photo.
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
                        </option>
                      ))}
                    </select>
                  </label>
                  {activeMockupLayer && (
                    <label className="field field-stack">
                      <span className="field-row">
                        Design size{' '}
                        <em>{Math.round(activeMockupLayer.width)}px</em>
                      </span>
                      <input
                        type="range"
                        min={mockupSizeMin}
                        max={mockupSizeMax}
                        step={5}
                        value={Math.round(activeMockupLayer.width)}
                        onChange={(e) =>
                          resizeMockupLayer(
                            activeMockupLayer.name,
                            Number(e.target.value),
                          )
                        }
                      />
                    </label>
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
                      className="btn btn-ghost"
                      onClick={() => setViewMode('mockup')}
                    >
                      Edit on canvas
                    </button>
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

          <section className="block export-block">
            <h2>Export for Etsy</h2>
            <div className="presets mode-toggle" role="group" aria-label="Export format">
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
              JPG stays smaller for uploads. If the file is over 1&nbsp;MB, quality
              is auto-reduced.
            </p>
            <button
              type="button"
              className="btn btn-export"
              disabled={items.length === 0 || exporting}
              onClick={() => void download()}
            >
              {exporting ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Exporting…
                </>
              ) : (
                `Download Etsy cover (${exportFormat === 'image/jpeg' ? 'JPG' : 'PNG'})`
              )}
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
          </section>
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
              {viewMode === 'cover' ? (
                <div className="preview-wrap" ref={wrapRef}>
                  <canvas
                    ref={previewRef}
                    className={`preview${drag ? ' is-dragging' : ''}${drag?.mode === 'resize' ? ' is-resizing' : ''}`}
                    style={{ aspectRatio: `${canvasWidth} / ${canvasHeight}` }}
                    onPointerDown={onPointerDown}
                    onPointerMove={(e) => {
                      onPointerMove(e)
                      if (!drag) onCanvasCursor(e)
                    }}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onPointerLeave={() => {
                      if (previewRef.current && !drag) {
                        previewRef.current.style.cursor = 'grab'
                      }
                    }}
                    role="img"
                    aria-label="Cover preview — drag to move, drag corners to resize"
                  />
                </div>
              ) : (
                <div className="preview-wrap mockup-wrap">
                  {!mockupBg ? (
                    <div className="mockup-empty">
                      <p>
                        Upload your mockup photo, then tag PNGs — each tagged
                        file becomes a separate mockup on that photo.
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => mockupFileRef.current?.click()}
                      >
                        Upload mockup image…
                      </button>
                    </div>
                  ) : mockupLayers.length === 0 ? (
                    <div className="mockup-empty">
                      <p>
                        Tag PNGs with ○ in the list. 3 tagged designs = 3
                        mockups. Click each one below to place it on the photo.
                      </p>
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
                            return (
                              <button
                                key={l.name}
                                type="button"
                                role="tab"
                                aria-selected={active}
                                className={`mockup-chip${active ? ' is-active' : ''}`}
                                onClick={() => selectMockup(l.name)}
                                title={l.name}
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
                      <p className="mockup-editing" aria-live="polite">
                        Editing mockup {mockupIndex + 1} of {mockupLayers.length}
                        {activeMockupLayer ? ` — ${activeMockupLayer.name}` : ''}
                        . Drag to move · corners to resize · , / . to switch.
                      </p>
                      <canvas
                        ref={mockupRef}
                        className={`preview mockup-preview${mockupDrag ? ' is-dragging' : ''}${mockupDrag?.mode === 'resize' ? ' is-resizing' : ''}`}
                        style={{
                          aspectRatio: `${mockupBg.width} / ${mockupBg.height}`,
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
    </div>
  )
}

export default App
