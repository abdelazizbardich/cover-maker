# Etsy Cover Maker

Build sticker-sheet **listing covers** for Etsy digital downloads (clipart, fonts, bundles).

## Etsy rules this app follows

- **Size:** short side ≥ **2000px** (presets: 3000×3000, 2000×2000, 2700×2025)
- **1st photo:** square or landscape only (portrait templates are marked *Gallery*)
- **Background:** always opaque (transparency becomes black on Etsy)
- **Export:** JPG by default, auto-compressed toward **&lt;1MB** for reliable uploads

## Run

```bash
npm install
npm run dev
```

Drop a folder of PNGs → pick an Etsy template → download `etsy-cover-….jpg`.

### AI listing copy (title / description / tags)

In **Export**, upload a reference `.txt` (example listing + writing rules). The model sees your cover + design images (not filenames). First **5** generations use the server OpenAI key; then paste your own key.

For local API + UI together:

```bash
# set OPENAI_API_KEY and LISTING_COPY_HMAC_SECRET in .env.local (see .env.example)
npx vercel dev
```

Or run `npm run dev` for the UI only (listing AI needs `/api/listing-copy` on Vercel).
