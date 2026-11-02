type FileSystemEntryLike = {
  isFile: boolean
  isDirectory: boolean
  name: string
}

type FileSystemFileEntryLike = FileSystemEntryLike & {
  file: (
    success: (file: File) => void,
    error?: (err: DOMException) => void,
  ) => void
}

type FileSystemDirectoryReaderLike = {
  readEntries: (
    success: (entries: FileSystemEntryLike[]) => void,
    error?: (err: DOMException) => void,
  ) => void
}

type FileSystemDirectoryEntryLike = FileSystemEntryLike & {
  createReader: () => FileSystemDirectoryReaderLike
}

function isPngFile(file: File): boolean {
  return (
    file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')
  )
}

function readAllDirectoryEntries(
  reader: FileSystemDirectoryReaderLike,
): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntryLike[] = []
    const readBatch = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all)
            return
          }
          all.push(...batch)
          readBatch()
        },
        reject,
      )
    }
    readBatch()
  })
}

async function entryToFiles(entry: FileSystemEntryLike): Promise<File[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntryLike
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject)
    })
    return isPngFile(file) ? [file] : []
  }

  if (entry.isDirectory) {
    const dir = entry as FileSystemDirectoryEntryLike
    const reader = dir.createReader()
    const children = await readAllDirectoryEntries(reader)
    const nested = await Promise.all(children.map((child) => entryToFiles(child)))
    return nested.flat()
  }

  return []
}

/**
 * Collect PNG files from a drop event.
 * Supports dropped files and folders (via webkitGetAsEntry recursion).
 */
export async function collectPngsFromDrop(
  dataTransfer: DataTransfer,
): Promise<File[]> {
  const items = dataTransfer.items
  const collected: File[] = []

  if (items && items.length > 0) {
    const entryJobs: Promise<File[]>[] = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind !== 'file') continue

      const entry =
        (
          item as DataTransferItem & {
            webkitGetAsEntry?: () => FileSystemEntryLike | null
          }
        ).webkitGetAsEntry?.() ?? null

      if (entry) {
        entryJobs.push(entryToFiles(entry))
      } else {
        const file = item.getAsFile()
        if (file && isPngFile(file)) collected.push(file)
      }
    }

    if (entryJobs.length > 0) {
      const fromEntries = await Promise.all(entryJobs)
      collected.push(...fromEntries.flat())
    }
  }

  // Fallback / merge: some browsers only populate files
  if (collected.length === 0 && dataTransfer.files?.length) {
    for (const file of Array.from(dataTransfer.files)) {
      if (isPngFile(file)) collected.push(file)
    }
  }

  // De-dupe by name + size + lastModified
  const seen = new Set<string>()
  return collected.filter((f) => {
    const key = `${f.name}::${f.size}::${f.lastModified}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
