// Runs supabase/migrations/*.sql plus supabase/tests/rls.test.sql against in-memory Postgres (PGlite),
// with a small shim standing in for Supabase's auth and storage schemas.
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase')
const db = new PGlite({ extensions: { pg_trgm } })

await db.exec(readFileSync(join(root, 'tests/shim.sql'), 'utf8'))
for (const f of readdirSync(join(root, 'migrations')).sort()) {
  await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'))
  console.log('applied', f)
}
const results = await db.exec(readFileSync(join(root, 'tests/rls.test.sql'), 'utf8'))
const rows = results.at(-1).rows
let failed = 0
for (const r of rows) {
  if (r.result !== 'PASS') failed++
  console.log(`${r.result}  ${r.test}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log(`\n${rows.length - failed}/${rows.length} passed`)
process.exit(failed ? 1 : 0)
