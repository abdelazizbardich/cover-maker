import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const skip = new Set(['node_modules', 'dist', '.git', '.vercel', 'sample-pngs', 'scripts'])
const files = []

function walk(dir, rel = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      ent.name.startsWith('.') &&
      ent.name !== '.gitignore' &&
      ent.name !== '.oxlintrc.json'
    ) {
      continue
    }
    if (skip.has(ent.name)) continue
    const abs = path.join(dir, ent.name)
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      walk(abs, r)
      continue
    }
    const buf = fs.readFileSync(abs)
    const isText =
      /\.(tsx?|jsx?|json|css|html|md|svg|txt|mjs|cjs)$/i.test(ent.name) ||
      ent.name === '.gitignore'
    files.push({
      file: r.replaceAll('\\', '/'),
      encoding: isText ? 'utf-8' : 'base64',
      data: isText ? buf.toString('utf8') : buf.toString('base64'),
      bytes: buf.length,
    })
  }
}

walk(root)
const total = files.reduce((s, f) => s + f.bytes, 0)
fs.writeFileSync(
  path.join(root, 'deploy-files.json'),
  JSON.stringify(files.map(({ file, encoding, data }) => ({ file, encoding, data }))),
)
console.log(
  JSON.stringify(
    { count: files.length, totalBytes: total, names: files.map((f) => f.file) },
    null,
    2,
  ),
)
