// Checks that every link to the documentation site points at a page that the built site has, and that the guides
// link to each other by files that exist. Links are found in the READMEs, the guides and the sources of the apps
// and packages (the interface links to the docs too).
//
//   node scripts/check-doc-links.mjs [dist]      (build the site first: npm run build -w @bsp/docs; dist defaults to docs/dist)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.resolve(process.argv[2] ?? path.join(root, 'docs', 'dist'))

if (!fs.existsSync(dist)) {
  console.error(`The built site is missing: ${dist}`)
  process.exit(1)
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

const guidesDir = path.join(root, 'docs', 'src')
const guides = fs.readdirSync(guidesDir).filter((name) => name.endsWith('.md'))
const files = [
  ...[...walk(guidesDir)].filter((file) => file.endsWith('.md')),
  ...['apps', 'packages'].flatMap((dir) => [...walk(path.join(root, dir))].filter((file) => /\.(ts|tsx)$/.test(file))),
].filter((file) => fs.existsSync(file))

const pageExists = (urlPath) => {
  const clean = decodeURIComponent(urlPath.split(/[?#]/)[0])
  const target = path.join(dist, clean)
  if (clean.endsWith('/')) return fs.existsSync(path.join(target, 'index.html'))
  return fs.existsSync(target) || fs.existsSync(`${target}.html`) || fs.existsSync(path.join(target, 'index.html'))
}

const problems = []
const siteLink = /https:\/\/docs\.betterstatuspage\.dev(\/[^\s)"'`<>\]\\]*)?/g
const guideLink = /\]\(([A-Za-z0-9_-]+\.md)(?:#[^)]*)?\)/g
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const rel = path.relative(root, file).split(path.sep).join('/')
  for (const match of text.matchAll(siteLink)) {
    const urlPath = match[1] ?? '/'
    // A template such as `<slug>` or a `${...}` interpolation is not a link.
    if (/[<${]/.test(urlPath)) continue
    if (!pageExists(urlPath)) problems.push(`${rel}: ${match[0]} has no page in the built site`)
  }
  if (path.dirname(file) === guidesDir && file.endsWith('.md')) {
    for (const match of text.matchAll(guideLink)) {
      if (!guides.includes(match[1])) problems.push(`${rel}: link to ${match[1]}, which is not a guide in docs/src/`)
    }
  }
}

if (problems.length) {
  console.error(`${problems.length} broken documentation link(s):\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`Documentation links are fine (${files.length} files checked).`)
