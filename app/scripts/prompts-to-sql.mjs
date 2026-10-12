// Checks supabase/seed/prompts.json and writes supabase/seed/prompts.sql (idempotent), ready to paste into the SQL Editor.
// Usage: cd app && npm run prompts:sql [path/to/other.json]
// Needs no keys: nothing here talks to Supabase. Node runs the shared TypeScript checks directly.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { validateSeed, seedToSql, summarize } from '../src/lib/promptSeed.ts'

const seedDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'seed')
const input = process.argv[2] ?? join(seedDir, 'prompts.json')
const output = join(seedDir, 'prompts.sql')

let raw
try {
  raw = JSON.parse(readFileSync(input, 'utf8'))
} catch (e) {
  console.error(`Couldn't read ${input} as JSON: ${e.message}`)
  console.error('Tip: every prompt is { "text": "...", "depth": "light" }, separated by commas, inside [ ].')
  process.exit(1)
}
const { prompts, errors, warnings } = validateSeed(raw)
for (const w of warnings) console.warn('note   ' + w)
if (errors.length) {
  for (const e of errors) console.error('FIX    ' + e)
  console.error(`\n${errors.length} problem${errors.length === 1 ? '' : 's'}. Nothing was written.`)
  process.exit(1)
}
writeFileSync(output, seedToSql(prompts))
console.log(summarize(prompts).join('\n'))
console.log(`\nWrote ${output}\nPaste it into Supabase → SQL Editor → Run. Running it again later is safe.`)
