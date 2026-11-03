import { createHmac, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import OpenAI from 'openai'

const FREE_QUOTA = 5
const COOKIE = 'listing_free_uses'
const MAX_DESIGNS = 8
const MAX_REF_CHARS = 12_000
const MAX_B64_CHARS = 2_500_000

type ImagePayload = {
  mimeType?: string
  base64?: string
}

type Body = {
  cover?: ImagePayload
  designs?: ImagePayload[]
  referenceText?: string
  guidelines?: string
  listingSubject?: string
  userApiKey?: string
}

function getSecret(): string {
  return (
    process.env.LISTING_COPY_HMAC_SECRET ||
    process.env.OPENAI_API_KEY ||
    'dev-insecure-listing-copy-secret'
  )
}

function sign(used: number): string {
  const payload = String(Math.max(0, Math.min(FREE_QUOTA, used)))
  const sig = createHmac('sha256', getSecret()).update(payload).digest('hex')
  return `${payload}.${sig}`
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

function readUsed(req: VercelRequest): number {
  const cookies = parseCookieHeader(req.headers.cookie)
  const raw = cookies[COOKIE]
  if (!raw) return 0
  const [payload, sig] = raw.split('.')
  if (!payload || !sig) return 0
  const used = Number(payload)
  if (!Number.isFinite(used) || used < 0) return 0
  const expected = createHmac('sha256', getSecret()).update(String(used)).digest('hex')
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 0
  } catch {
    return 0
  }
  return Math.min(FREE_QUOTA, Math.max(0, Math.floor(used)))
}

function setUsedCookie(res: VercelResponse, used: number) {
  const value = encodeURIComponent(sign(used))
  const parts = [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 365}`,
  ]
  if (process.env.VERCEL) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

function freeRemaining(used: number): number {
  return Math.max(0, FREE_QUOTA - used)
}

function asDataUrl(img: ImagePayload): string | null {
  if (!img?.base64 || typeof img.base64 !== 'string') return null
  if (img.base64.length > MAX_B64_CHARS) return null
  const mime =
    img.mimeType === 'image/png' || img.mimeType === 'image/jpeg'
      ? img.mimeType
      : 'image/jpeg'
  // strip accidental data-url prefix
  const b64 = img.base64.includes(',')
    ? img.base64.slice(img.base64.indexOf(',') + 1)
    : img.base64
  return `data:${mime};base64,${b64}`
}

function buildSystemPrompt(): string {
  return `You write Etsy listing copy for digital sticker / SVG / PNG design packs.

Rules:
- Infer the listing subject ONLY from the provided images (cover sheet + design thumbnails). Never invent from filenames (none are provided).
- If the subject is unclear AND no listingSubject was given, set needsListingName to true and leave title/description empty and tags as []. Do not guess a niche when unsure.
- If listingSubject is provided, use it as the product theme even if images are ambiguous.
- Match the tone, structure, and approximate length of the EXAMPLE listing in the reference text.
- Obey any GUIDELINES / writing rules the user supplies.
- Produce a NEW listing for THESE designs — do not copy the example verbatim.
- Title: max 140 characters, searchable, no ALL CAPS spam.
- Tags: up to 13 tags, each max 20 characters, specific and relevant, no duplicates.
- Description: plain text for Etsy (no HTML). Include what's in the pack when visible; keep buyer-focused.`
}

function buildUserText(body: Body, designCount: number): string {
  const subject = (body.listingSubject || '').trim()
  const reference = (body.referenceText || '').trim().slice(0, MAX_REF_CHARS)
  const guidelines = (body.guidelines || '').trim().slice(0, 4000)
  const parts = [
    `Design images attached: 1 cover sheet + ${designCount} design thumbnail(s).`,
    subject
      ? `Listing subject (from seller): ${subject}`
      : 'Listing subject: not provided — infer from images only. If unclear, set needsListingName=true.',
    '',
    '--- REFERENCE (example title / description / tags + any rules in the file) ---',
    reference || '(empty)',
  ]
  if (guidelines) {
    parts.push('', '--- EXTRA GUIDELINES ---', guidelines)
  }
  return parts.join('\n')
}

function clampTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, 20)
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= 13) break
  }
  return out
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed', freeRemaining: FREE_QUOTA })
    return
  }

  const used = readUsed(req)
  const remaining = freeRemaining(used)
  const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Body

  const userKey =
    typeof body.userApiKey === 'string' ? body.userApiKey.trim() : ''
  const serverKey = process.env.OPENAI_API_KEY?.trim() || ''

  let apiKey = ''
  let usingFree = false
  if (remaining > 0 && serverKey) {
    apiKey = serverKey
    usingFree = true
  } else if (userKey) {
    apiKey = userKey
  } else if (remaining <= 0) {
    res.status(402).json({
      error:
        'Free AI uses are used up. Paste your OpenAI API key to keep generating listing copy.',
      code: 'quota_exhausted',
      freeRemaining: 0,
      needsListingName: false,
      title: '',
      description: '',
      tags: [],
    })
    return
  } else {
    res.status(500).json({
      error: 'Server AI is not configured (missing OPENAI_API_KEY).',
      code: 'server_misconfigured',
      freeRemaining: remaining,
      needsListingName: false,
      title: '',
      description: '',
      tags: [],
    })
    return
  }

  const coverUrl = body.cover ? asDataUrl(body.cover) : null
  if (!coverUrl) {
    res.status(400).json({
      error: 'Cover image is required.',
      code: 'bad_request',
      freeRemaining: remaining,
      needsListingName: false,
      title: '',
      description: '',
      tags: [],
    })
    return
  }

  const designUrls: string[] = []
  for (const d of (body.designs || []).slice(0, MAX_DESIGNS)) {
    const url = asDataUrl(d)
    if (url) designUrls.push(url)
  }

  const referenceText = (body.referenceText || '').trim()
  if (!referenceText) {
    res.status(400).json({
      error: 'Upload a reference .txt with an example title, description, and tags.',
      code: 'bad_request',
      freeRemaining: remaining,
      needsListingName: false,
      title: '',
      description: '',
      tags: [],
    })
    return
  }

  const openai = new OpenAI({ apiKey })
  const content: OpenAI.Chat.ChatCompletionContentPart[] = [
    { type: 'text', text: buildUserText(body, designUrls.length) },
    {
      type: 'image_url',
      image_url: { url: coverUrl, detail: 'low' },
    },
    ...designUrls.map(
      (url): OpenAI.Chat.ChatCompletionContentPart => ({
        type: 'image_url',
        image_url: { url, detail: 'low' },
      }),
    ),
  ]

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'etsy_listing_copy',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              needsListingName: { type: 'boolean' },
              subjectGuess: { type: ['string', 'null'] },
              title: { type: 'string' },
              description: { type: 'string' },
              tags: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: [
              'needsListingName',
              'subjectGuess',
              'title',
              'description',
              'tags',
            ],
          },
        },
      },
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content },
      ],
    })

    const raw = completion.choices[0]?.message?.content || '{}'
    const parsed = JSON.parse(raw) as {
      needsListingName?: boolean
      subjectGuess?: string | null
      title?: string
      description?: string
      tags?: string[]
    }

    const needsListingName = Boolean(parsed.needsListingName)
    const title = needsListingName
      ? ''
      : String(parsed.title || '').trim().slice(0, 140)
    const description = needsListingName
      ? ''
      : String(parsed.description || '').trim()
    const tags = needsListingName ? [] : clampTags(parsed.tags)

    let nextRemaining = remaining
    if (usingFree && !needsListingName) {
      const nextUsed = used + 1
      setUsedCookie(res, nextUsed)
      nextRemaining = freeRemaining(nextUsed)
    } else {
      // Refresh cookie / report current remaining
      setUsedCookie(res, used)
      nextRemaining = remaining
    }

    res.status(200).json({
      needsListingName,
      subjectGuess: parsed.subjectGuess ?? null,
      title,
      description,
      tags,
      freeRemaining: usingFree ? nextRemaining : remaining,
    })
  } catch (e) {
    const message =
      e instanceof Error ? e.message : 'OpenAI request failed'
    const lower = message.toLowerCase()
    const code =
      lower.includes('incorrect api key') || lower.includes('invalid api key')
        ? 'invalid_api_key'
        : 'openai_error'
    res.status(code === 'invalid_api_key' ? 401 : 502).json({
      error: message,
      code,
      freeRemaining: remaining,
      needsListingName: false,
      title: '',
      description: '',
      tags: [],
    })
  }
}
