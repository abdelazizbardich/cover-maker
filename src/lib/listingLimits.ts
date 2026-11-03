/** Etsy listing text limits for AI-generated copy. */

export const ETSY_TITLE_MAX = 140
export const ETSY_TAG_MAX = 13
export const ETSY_TAG_CHAR_MAX = 20
export const LISTING_FREE_QUOTA = 5

export type ListingCopyResult = {
  title: string
  description: string
  tags: string[]
}

export function clampTitle(title: string): string {
  return title.trim().slice(0, ETSY_TITLE_MAX)
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, ETSY_TAG_CHAR_MAX)
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= ETSY_TAG_MAX) break
  }
  return out
}

export function clampListingCopy(input: ListingCopyResult): ListingCopyResult {
  return {
    title: clampTitle(input.title),
    description: input.description.trim(),
    tags: normalizeTags(input.tags),
  }
}

export function listingCopyPlainText(copy: ListingCopyResult): string {
  return [copy.title, '', copy.description, '', copy.tags.join(', ')].join('\n')
}
