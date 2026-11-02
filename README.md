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
