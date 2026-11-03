/** Prompt text for Etsy listing copy generation (shared conceptually with the API). */

export const LISTING_COPY_SYSTEM = `You write Etsy listing copy for digital sticker / SVG / PNG design packs.

Rules:
- Infer the listing subject ONLY from the provided images (cover sheet + design thumbnails). Never invent from filenames (none are provided).
- If the subject is unclear AND no listingSubject was given, set needsListingName to true and leave title/description/tags empty (or minimal). Do not guess a niche when unsure.
- If listingSubject is provided, use it as the product theme even if images are ambiguous.
- Match the tone, structure, and approximate length of the EXAMPLE listing in the reference text.
- Obey any GUIDELINES / writing rules the user supplies.
- Produce a NEW listing for THESE designs — do not copy the example verbatim.
- Title: max 140 characters, searchable, no ALL CAPS spam.
- Tags: up to 13 tags, each max 20 characters, specific and relevant, no duplicates.
- Description: plain text for Etsy (no HTML). Include what's in the pack when visible; keep buyer-focused.
- Return JSON only matching the schema.`

export function buildListingUserText(opts: {
  referenceText: string
  guidelines: string
  listingSubject: string
  designCount: number
}): string {
  const parts = [
    `Design images attached: 1 cover sheet + ${Math.max(0, opts.designCount)} design thumbnail(s).`,
    opts.listingSubject.trim()
      ? `Listing subject (from seller): ${opts.listingSubject.trim()}`
      : 'Listing subject: not provided — infer from images only. If unclear, set needsListingName=true.',
    '',
    '--- REFERENCE (example title / description / tags + any rules in the file) ---',
    opts.referenceText.trim() || '(empty)',
  ]
  if (opts.guidelines.trim()) {
    parts.push('', '--- EXTRA GUIDELINES ---', opts.guidelines.trim())
  }
  parts.push(
    '',
    'Respond with JSON: { "needsListingName": boolean, "subjectGuess": string|null, "title": string, "description": string, "tags": string[] }',
  )
  return parts.join('\n')
}
