import { useRef, useState } from 'react'
import { useAuth } from '../auth'
import { useOrganize } from '../organize'
import { writeState } from '../lib/account'
import { syncDeps } from '../lib/syncDeps'
import {
  buildExport, exportFilename, OUTCOME_TEXT, OUTCOMES, parseJournal, reportText, runRestore, serialize,
  type ParseResult, type RestoreReport,
} from '../lib/vault'
import { downloadText, formatBytes, markExported, sinceText, supabaseRpc } from '../lib/vaultRemote'

const CAP = 2 * 1024 * 1024 * 1024

type RestoreState =
  | { step: 'idle' }
  | { step: 'reading'; name: string }
  | { step: 'invalid'; name: string; error: string }
  | { step: 'preview'; name: string; parsed: Extract<ParseResult, { ok: true }>; report: RestoreReport }
  | { step: 'merging'; name: string; done: number; total: number }
  | { step: 'done'; name: string; report: RestoreReport }
  | { step: 'failed'; name: string; error: string; parsed?: Extract<ParseResult, { ok: true }> }

export function Vault() {
  const { session, profile, license, refresh } = useAuth()
  const organize = useOrganize()
  const userId = session!.user.id
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const [exportError, setExportError] = useState('')
  const [restore, setRestore] = useState<RestoreState>({ step: 'idle' })
  const fileInput = useRef<HTMLInputElement>(null)
  const canRestore = writeState(license) !== 'readonly' && writeState(license) !== 'grace'

  async function doExport() {
    setExporting(true)
    setExportError('')
    setExported(null)
    try {
      const drafts = (await syncDeps.store.all()).filter((d) => d.userId === userId)
      const file = await buildExport(supabaseRpc, drafts)
      const text = serialize(file)
      downloadText(exportFilename(), text)
      await markExported(userId).catch(() => {})
      await refresh()
      const n = file.entries.length
      setExported(`Your journal is in your hands. ${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}, ${formatBytes(new Blob([text]).size)}.`)
    } catch {
      setExportError("Couldn't reach the server to export. Your words are safe; try again when you're online.")
    }
    setExporting(false)
  }

  async function pick(file: File) {
    setRestore({ step: 'reading', name: file.name })
    const parsed = parseJournal(await file.text())
    if (!parsed.ok) {
      setRestore({ step: 'invalid', name: file.name, error: parsed.error })
      return
    }
    try {
      const report = await runRestore(supabaseRpc, parsed, { dryRun: true })
      setRestore({ step: 'preview', name: file.name, parsed, report })
    } catch (e) {
      setRestore({ step: 'failed', name: file.name, error: (e as Error).message })
    }
  }

  async function merge(name: string, parsed: Extract<ParseResult, { ok: true }>) {
    setRestore({ step: 'merging', name, done: 0, total: parsed.file.entries.length })
    try {
      const report = await runRestore(supabaseRpc, parsed, {
        dryRun: false,
        onProgress: (done, total) => setRestore({ step: 'merging', name, done, total }),
      })
      setRestore({ step: 'done', name, report })
      await organize.refresh()
    } catch (e) {
      setRestore({ step: 'failed', name, error: (e as Error).message, parsed })
    }
  }

  const used = profile?.storage_bytes_used ?? 0

  return (
    <div className="screen vault">
      <h1 className="screen-title">Vault</h1>
      <p className="screen-sub">Everything you write can leave with you, any time, as a file you can read. Reading and exporting stay free forever.</p>

      <section className="card stack" aria-labelledby="export-h">
        <h2 id="export-h">Export</h2>
        <p>
          Last backup: <strong>{sinceText(profile?.last_export_at ?? null)}</strong>. One JSON file with every entry, tag, chapter and
          sealed letter, plus a note explaining how to read it.
        </p>
        <div className="row">
          <button className="btn btn-primary" onClick={doExport} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export as JSON'}
          </button>
          <span className="fine">Export with photos (.zip) arrives with photos.</span>
        </div>
        {exported && <p role="status" className="done-line">{exported}</p>}
        {exportError && <p role="alert" className="form-error">{exportError}</p>}
      </section>

      <section className="card stack" aria-labelledby="restore-h">
        <h2 id="restore-h">Restore</h2>
        <p>
          Merge a Daftar journal file into this account. You'll see exactly what would change first, and nothing is written until you
          say so. Nothing is ever deleted: if the file has a newer copy of an entry, your current text is kept as an earlier version.
        </p>
        {!canRestore && <p className="fine">Restoring writes entries, so it needs an active trial or an unlock. Reading and export always work.</p>}

        {(restore.step === 'idle' || restore.step === 'invalid' || restore.step === 'done' || restore.step === 'failed') && (
          <div className="row">
            <button className="btn btn-quiet" disabled={!canRestore} onClick={() => fileInput.current?.click()}>
              Choose a journal file…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void pick(f)
              }}
            />
          </div>
        )}

        {restore.step === 'reading' && <p role="status">Reading {restore.name}…</p>}
        {restore.step === 'invalid' && <p role="alert" className="form-error">{restore.error}</p>}

        {restore.step === 'preview' && (
          <div className="restore-preview stack">
            <p>
              <strong>{restore.name}</strong>
              {restore.parsed.file.exported_at && <> · exported {new Date(restore.parsed.file.exported_at).toLocaleDateString()}</>} ·{' '}
              {restore.parsed.file.entries.length.toLocaleString()} entries
            </p>
            <ReportTable report={restore.report} />
            {restore.report.unreadable.length > 0 && (
              <p className="fine">{restore.report.unreadable.length} item(s) in the file couldn't be read and will be left out. The report lists them.</p>
            )}
            <div className="row">
              <button className="btn btn-primary" onClick={() => void merge(restore.name, restore.parsed)}>
                Merge into my journal.
              </button>
              <button className="btn btn-quiet" onClick={() => setRestore({ step: 'idle' })}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {restore.step === 'merging' && (
          <p role="status">
            Merging… {restore.done.toLocaleString()} of {restore.total.toLocaleString()}
          </p>
        )}

        {restore.step === 'done' && (
          <div className="stack">
            <p role="status" className="done-line">Merged. Here's what happened.</p>
            <ReportTable report={restore.report} />
            <div className="row">
              <button
                className="btn btn-quiet"
                onClick={() => downloadText(`daftar-restore-report-${new Date().toISOString().slice(0, 10)}.txt`, reportText(restore.report, restore.name), 'text/plain')}
              >
                Download the report
              </button>
            </div>
          </div>
        )}

        {restore.step === 'failed' && (
          <div className="stack">
            <p role="alert" className="form-error">{restore.error}</p>
            {restore.parsed && (
              <div className="row">
                <button className="btn btn-quiet" onClick={() => void merge(restore.name, restore.parsed!)}>
                  Try the merge again
                </button>
                <span className="fine">Safe to repeat: anything already merged is recognised and left alone.</span>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="storage-h">
        <h2 id="storage-h">Storage</h2>
        <p>
          Photos: {formatBytes(used)} of 2 GB used.
        </p>
        <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={CAP} aria-valuenow={used} aria-label="Photo storage used">
          <i style={{ inlineSize: `${Math.min(100, (used / CAP) * 100)}%` }} />
        </div>
      </section>
    </div>
  )
}

function ReportTable({ report }: { report: RestoreReport }) {
  const rows = OUTCOMES.filter((o) => report.counts[o] > 0)
  const m = report.meta
  const metaNew = m.tracks.new + m.tags.new + m.chapters.new
  const metaRenamed = m.tracks.renamed + m.tags.renamed + m.chapters.renamed
  return (
    <dl className="report">
      {rows.length === 0 && (
        <div>
          <dt>Entries</dt>
          <dd>none in the file</dd>
        </div>
      )}
      {rows.map((o) => (
        <div key={o}>
          <dt>{OUTCOME_TEXT[o]}</dt>
          <dd>{report.counts[o].toLocaleString()}</dd>
        </div>
      ))}
      {report.versionsAdded > 0 && (
        <div>
          <dt>Earlier versions brought along</dt>
          <dd>{report.versionsAdded.toLocaleString()}</dd>
        </div>
      )}
      <div>
        <dt>Tracks, tags and chapters</dt>
        <dd>
          {metaNew} new{metaRenamed ? `, ${metaRenamed} renamed` : ''}
        </dd>
      </div>
      {report.remapped.length > 0 && (
        <div>
          <dt>Saved under a new id (the file came from another account)</dt>
          <dd>{report.remapped.length}</dd>
        </div>
      )}
    </dl>
  )
}
