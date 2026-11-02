import fs from 'node:fs'
import path from 'node:path'

const dist = path.join(process.cwd(), 'dist')
const files = []

function walk(dir, rel = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name)
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      walk(abs, r)
      continue
    }
    const buf = fs.readFileSync(abs)
    const isText = /\.(html|js|css|svg|json|txt|map)$/i.test(ent.name)
    files.push({
      file: r.split(path.sep).join('/'),
      encoding: isText ? 'utf-8' : 'base64',
      data: isText ? buf.toString('utf8') : buf.toString('base64'),
    })
  }
}

walk(dist)
fs.writeFileSync('deploy-dist.json', JSON.stringify(files))
console.log({
  count: files.length,
  chars: JSON.stringify(files).length,
  names: files.map((f) => f.file),
})
