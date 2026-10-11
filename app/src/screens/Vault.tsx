import { useRef, useState } from 'react'
import { useAuth } from '../auth'
import { useOrganize } from '../organize'
import { writeState } from '../lib/account'
import { syncDeps } from '../lib/syncDeps'
import {
  buildExport, exportFilename, OUTCOME_TEXT, OUTCOMES, parseJournal, reportText, runRestore, serialize,
  type ParseResult, type RestoreReport,
} from '../lib/vault'
import { downloadBlob, downloadText, formatBytes, markExported, sinceText, supabaseRpc } from '../lib/vaultRemote'
import {
  buildZipExport, hasPhotoActivity, OpenFileError, openJournalFile, PHOTO_LINES, planPhotos, planSummary, ZipExportError,
  type OpenedFile, type PhotoSummary,
} from '../lib/vaultZip'
import { applyPhotoPlan } from '../lib/photoRestore'
import { backend, photoQueue } from '../lib/photoRuntime'

const CAP = 2 * 1024 * 1024 * 1024

type RestoreState =
  | { step: 'idle' }
  | { step: 'reading'; name: string }
  | { step: 'invalid'; name: string; error: string }
  | { step: 'preview'; name: string; parsed: Extract<ParseResult, { ok: true }>; opened: OpenedFile; report: RestoreReport; photos: PhotoSummary | null }
  | { step: 'merging'; name: string; done: number; total: number; label?: string }
  | { step: 'done'; name: string; report: RestoreReport; photos: PhotoSummary | null; uploading: number }
  | { step: 'failed'; name: string; error: string; parsed?: Extract<ParseResult, { ok: true }>; opened?: OpenedFile }

export function Vault() {
  const { session, profile, license, refresh } = useAuth()
  const organize = useOrganize()
  const userId = session!.user.id
  const [exporting, setExporting] = useState<null | 'json' | 'zip'>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  const [exportError, setExportError] = useState('')
  const [restore, setRestore] = useState<RestoreState>({ step: 'idle' })
  const fileInput = useRef<HTMLInputElement>(null)
  const canRestore = writeState(license) !== 'readonly' && writeState(license) !== 'grace'

  async function doExport(kind: 'json' | 'zip') {
    setExporting(kind)
    setExportError('')
    setExported(null)
    setProgress(null)
    try {
      const drafts = (await syncDeps.store.all()).filter((d) => d.userId === userId)
      if (kind === 'json') {
        const file = await buildExport(supabaseRpc, drafts)
        const text = serialize(file)
        downloadText(exportFilename(), text)
        const n = file.entries.length
        const photos = file.entries.reduce((c, e) => c + e.media.length, 0)
        setExported(
          `Your journal is in your hands. ${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}, ${formatBytes(new Blob([text]).size)}.` +
            (photos ? ` It lists ${photos.toLocaleString()} ${photos === 1 ? 'photo' : 'photos'} but doesn't contain them: use the .zip for those.` : ''),
        )
      } else {
        const z = await buildZipExport(supabaseRpc, drafts, photoQueue.pending(userId), backend(), { onProgress: (done, total) => setProgress({ done, total }) })
        downloadBlob(z.name, z.blob)
        const n = z.json.entries.length
        setExported(`Your journal is in your hands. ${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'} and ${z.photos.toLocaleString()} ${z.photos === 1 ? 'photo' : 'photos'}, ${formatBytes(z.blob.size)}.`)
      }
      await markExported(userId).catch(() => {})
      await refresh()
    } catch (e) {
      setExportError(e instanceof ZipExportError ? e.message : "Couldn't reach the server to export. Your words are safe; try again when you're online.")
    }
    setExporting(null)
    setProgress(null)
  }

  /** What a restore would do with photos, or null when the file lists none. */
  async function photoPreview(parsed: Extract<ParseResult, { ok: true }>, opened: OpenedFile, results: RestoreReport['entries']): Promise<{ summary: PhotoSummary | null; plan: ReturnType<typeof planPhotos> }> {
    const withPhotos = parsed.file.entries.filter((e) => e.media.length > 0)
    const targets = [...new Set(results.filter((r) => withPhotos.some((e) => e.id === r.id)).map((r) => r.stored_as))]
    const rows = targets.length ? await backend().listMediaMany(targets).catch(() => []) : []
    const shas = new Map<string, Set<string>>()
    const counts = new Map<string, number>()
    for (const r of rows) {
      shas.set(r.entry_id, (shas.get(r.entry_id) ?? new Set()).add(r.sha256))
      counts.set(r.entry_id, (counts.get(r.entry_id) ?? 0) + 1)
    }
    const plan = planPhotos(parsed.file, results, shas, counts, profile?.storage_bytes_used ?? 0, opened.hasPhoto)
    const summary = planSummary(plan)
    return { summary: hasPhotoActivity(summary) ? summary : null, plan }
  }

  async function pick(file: File) {
    setRestore({ step: 'reading', name: file.name })
    let opened: OpenedFile
    try {
      opened = await openJournalFile(file)
    } catch (e) {
      setRestore({ step: 'invalid', name: file.name, error: e instanceof OpenFileError ? e.message : "This file couldn't be read. Nothing was changed." })
      return
    }
    const parsed = parseJournal(opened.text)
    if (!parsed.ok) {
      setRestore({ step: 'invalid', name: file.name, error: parsed.error })
      return
    }
    try {
      const report = await runRestore(supabaseRpc, parsed, { dryRun: true })
      const { summary } = await photoPreview(parsed, opened, report.entries)
      setRestore({ step: 'preview', name: file.name, parsed, opened, report, photos: summary })
    } catch (e) {
      setRestore({ step: 'failed', name: file.name, error: (e as Error).message })
    }
  }

  async function merge(name: string, parsed: Extract<ParseResult, { ok: true }>, opened: OpenedFile) {
    setRestore({ step: 'merging', name, done: 0, total: parsed.file.entries.length })
    try {
      const report = await runRestore(supabaseRpc, parsed, {
        dryRun: false,
        onProgress: (done, total) => setRestore({ step: 'merging', name, done, total }),
      })
      // photos: planned from what the merge ACTUALLY did (entries may have been stored under new ids)
      let photos: PhotoSummary | null = null
      let uploading = 0
      if (parsed.file.entries.some((e) => e.media.length > 0)) {
        const { summary, plan } = await photoPreview(parsed, opened, report.entries)
        if (plan.upload.length) {
          setRestore({ step: 'merging', name, done: 0, total: plan.upload.length, label: 'Preparing photos' })
          const res = await applyPhotoPlan(plan, opened, userId, (done, total) => setRestore({ step: 'merging', name, done, total, label: 'Preparing photos' }))
          uploading = res.queued
          photos = summary ? { ...summary, damaged: res.damaged } : null
        } else photos = summary
      }
      setRestore({ step: 'done', name, report, photos, uploading })
      await organize.refresh()
    } catch (e) {
      setRestore({ step: 'failed', name, error: (e as Error).message, parsed, opened })
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
          Last backup: <strong>{sinceText(profile?.last_export_at ?? null)}</strong>. Every entry, tag, chapter and sealed letter, with a note
          explaining how to read it. The .zip also holds your photos.
        </p>
        <div className="row">
          <button className="btn btn-primary" onClick={() => void doExport('zip')} disabled={!!exporting}>
            {exporting === 'zip' ? (progress ? `Collecting photos… ${progress.done} of ${progress.total}` : 'Exporting…') : 'Export with photos (.zip)'}
          </button>
          <button className="btn btn-tint" onClick={() => void doExport('json')} disabled={!!exporting}>
            {exporting === 'json' ? 'Exporting…' : 'Text only (.json)'}
          </button>
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
            <button className="btn btn-tint" disabled={!canRestore} onClick={() => fileInput.current?.click()}>
              Choose a journal file…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,.zip,application/json,application/zip"
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
            {restore.photos && <PhotoLines summary={restore.photos} />}
            {restore.report.unreadable.length > 0 && (
              <p className="fine">{restore.report.unreadable.length} item(s) in the file couldn't be read and will be left out. The report lists them.</p>
            )}
            <div className="row">
              <button className="btn btn-primary" onClick={() => void merge(restore.name, restore.parsed, restore.opened)}>
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
            {restore.label ?? 'Merging'}… {restore.done.toLocaleString()} of {restore.total.toLocaleString()}
          </p>
        )}

        {restore.step === 'done' && (
          <div className="stack">
            <p role="status" className="done-line">Merged. Here's what happened.</p>
            <ReportTable report={restore.report} />
            {restore.photos && <PhotoLines summary={restore.photos} />}
            {restore.uploading > 0 && (
              <p className="fine">
                {restore.uploading.toLocaleString()} {restore.uploading === 1 ? 'photo is' : 'photos are'} uploading in the background. You can keep writing; if you close the app, they carry on next time it opens.
              </p>
            )}
            <div className="row">
              <button
                className="btn btn-quiet"
                onClick={() => downloadText(`daftar-restore-report-${new Date().toISOString().slice(0, 10)}.txt`, reportText(restore.report, restore.name) + (restore.photos ? '\nPhotos\n' + PHOTO_LINES(restore.photos).map((l) => '  ' + l).join('\n') + '\n' : ''), 'text/plain')}
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
                <button className="btn btn-quiet" onClick={() => void merge(restore.name, restore.parsed!, restore.opened!)}>
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

function PhotoLines({ summary }: { summary: PhotoSummary }) {
  return (
    <ul className="photo-lines">
      {PHOTO_LINES(summary).map((l) => <li key={l}>{l}</li>)}
    </ul>
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
