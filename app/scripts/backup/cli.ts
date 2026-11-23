/**
 * Daftar nightly backup, the Mac side. The decisions live in `src/lib/backup.ts`; this file signs in, talks to macOS
 * and moves files. Bundled into one file by `vite.backup.config.ts` (`npm run backup:build`).
 *
 *   npm run backup -- login      sign in once with the 6-digit email code, choose the folder
 *   npm run backup -- install    schedule it (nightly 03:30, missed runs happen on wake, and at login)
 *   npm run backup -- run        back up now
 *   npm run backup -- status     last result, next steps if something is wrong
 *   npm run backup -- uninstall  stop the schedule and forget the sign-in (backups stay where they are)
 *
 * Security: it signs in as YOU, with the publishable key, so it can read exactly what you can and RLS applies. No
 * service-role or secret key exists on this Mac. The only secret is your session's refresh token, kept in the login
 * Keychain (item "Daftar backup"). Supabase rotates it on every use, so each run stores the new one before doing
 * anything else. "Sign out everywhere" or a lost token just means: run `login` again.
 *
 * Files: config and state in ~/Library/Application Support/Daftar Backup/ (the scheduled copy of this script lives
 * there too, outside ~/Documents, which macOS guards from background jobs). Log: ~/Library/Logs/Daftar Backup.log.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { emptyState, runBackup, type BackupState } from '../../src/lib/backup'
import type { MediaRow } from '../../src/lib/photoRuntime'

const HOME = homedir()
// DAFTAR_BACKUP_SUPPORT: tests only (a throwaway folder instead of the real one)
const SUPPORT = process.env.DAFTAR_BACKUP_SUPPORT || join(HOME, 'Library', 'Application Support', 'Daftar Backup')
const CONFIG = join(SUPPORT, 'config.json')
const STATE = join(SUPPORT, 'state.json')
const LOCK = join(SUPPORT, 'run.lock')
const INSTALLED_SCRIPT = join(SUPPORT, 'daftar-backup.mjs')
const LOG = join(HOME, 'Library', 'Logs', 'Daftar Backup.log')
const LABEL = 'app.daftar.backup'
const PLIST = join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`)
const KEYCHAIN_SERVICE = 'Daftar backup'
const ICLOUD = join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
const DEFAULT_DIR = join(ICLOUD, 'Daftar Backups')

type Config = { url: string; key: string; email: string; dir: string }

// ---- small helpers ----------------------------------------------------------------------------------------------

const sh = (cmd: string, args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((res) => {
    execFile(cmd, args, (e, out, err) => res({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) }))
  })

const log = (msg: string) => console.log(`${new Date().toISOString()}  ${msg}`)
const exists = (p: string) => stat(p).then(() => true, () => false)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A macOS notification. The text goes in as an argument, never spliced into the script. */
async function notify(text: string) {
  await sh('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Daftar backup"', '-e', 'end run', text])
}

async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(p: string, v: unknown) {
  await mkdir(SUPPORT, { recursive: true })
  await writeFile(p + '.tmp', JSON.stringify(v, null, 2) + '\n', { mode: 0o600 })
  await rename(p + '.tmp', p)
}

const keychain = {
  async get(account: string): Promise<string | null> {
    const r = await sh('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'])
    return r.code === 0 ? r.out.trim() : null
  },
  async set(account: string, token: string) {
    const r = await sh('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', token])
    if (r.code !== 0) throw new Error(`Couldn't save the sign-in to the Keychain: ${r.err.trim()}`)
  },
  async remove(account: string) {
    await sh('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account])
  },
}

function client(cfg: Pick<Config, 'url' | 'key'>): SupabaseClient {
  return createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
}

async function envLocal(): Promise<{ url?: string; key?: string }> {
  for (const p of [resolve('.env.local'), resolve('app/.env.local')]) {
    try {
      const text = await readFile(p, 'utf8')
      const get = (k: string) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '')
      return { url: get('VITE_SUPABASE_URL'), key: get('VITE_SUPABASE_PUBLISHABLE_KEY') }
    } catch {
      /* try the next */
    }
  }
  return {}
}

/** Only one run at a time: two runs would both spend the same refresh token. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(SUPPORT, { recursive: true })
  try {
    await mkdir(LOCK)
  } catch {
    const age = Date.now() - (await stat(LOCK)).mtimeMs
    if (age < 30 * 60_000) throw new Error('Another backup is running right now.')
    await rmdir(LOCK).catch(() => {})
    await mkdir(LOCK)
  }
  try {
    return await fn()
  } finally {
    await rmdir(LOCK).catch(() => {})
  }
}

const isNetwork = (e: unknown) => /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|Couldn't reach/i.test(String((e as Error)?.message ?? e))

// ---- commands ---------------------------------------------------------------------------------------------------

async function login() {
  const env = await envLocal()
  const old = await readJson<Partial<Config>>(CONFIG, {})
  const url = env.url || old.url
  const key = env.key || old.key
  if (!url || !key) throw new Error('No Supabase address found. Run this from the app folder, where .env.local lives.')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const email = (await rl.question(`Email you sign in to Daftar with${old.email ? ` [${old.email}]` : ''}: `)).trim() || old.email || ''
    if (!email.includes('@')) throw new Error('That is not an email address.')
    const defDir = old.dir || DEFAULT_DIR
    const dirIn = (await rl.question(`Folder for backups [${defDir.replace(HOME, '~')}]: `)).trim()
    const dir = dirIn ? resolve(dirIn.replace(/^~(?=\/|$)/, HOME)) : defDir

    const sb = client({ url, key })
    const sent = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
    if (sent.error) throw new Error(`Couldn't send the code: ${sent.error.message}`)
    const code = (await rl.question('Check your email and type the 6-digit code: ')).trim()
    const { data, error } = await sb.auth.verifyOtp({ email, token: code, type: 'email' })
    if (error || !data.session) throw new Error("That code didn't work. It may have expired. Run login again for a new one.")

    await keychain.set(email, data.session.refresh_token)
    await writeJson(CONFIG, { url, key, email, dir } satisfies Config)
    await mkdir(dir, { recursive: true })
    console.log(`\nSigned in as ${email}. Backups go to ${dir}.`)
    console.log('Next: npm run backup -- run      (one now, to check)')
    console.log('      npm run backup -- install  (every night)')
  } finally {
    rl.close()
  }
}

async function runOnce() {
  const cfg = await readJson<Config | null>(CONFIG, null)
  if (!cfg) throw new Error('Not set up yet. Run: npm run backup -- login')
  const prev = await readJson<BackupState>(STATE, emptyState())
  try {
    const result = await withLock(async () => {
      const sb = client(cfg)
      let signedIn = false
      for (let attempt = 1; ; attempt++) {
        try {
          if (!signedIn) {
            const token = await keychain.get(cfg.email)
            if (!token) throw new SignInNeeded()
            const { data, error } = await sb.auth.refreshSession({ refresh_token: token })
            if (error || !data.session) {
              if (error && isNetwork(error)) throw error
              throw new SignInNeeded()
            }
            await keychain.set(cfg.email, data.session.refresh_token) // the old one is spent: save the new one first
            signedIn = true
          }
          return await backupWith(sb, cfg, prev)
        } catch (e) {
          if (e instanceof SignInNeeded || !isNetwork(e) || attempt >= 3) throw e
          log(`Network trouble (${(e as Error).message}); trying again in ${attempt} min.`)
          await sleep(attempt * 60_000)
        }
      }
    })
    await writeJson(STATE, result.state)
    const what = result.outcome === 'saved'
      ? `Saved ${result.file}: ${result.entries} entries, ${result.photos} photos.`
      : `No changes since ${result.file} (${result.entries} entries).`
    log(what + (result.removed.length ? ` Removed old: ${result.removed.join(', ')}.` : ''))
    if (result.warning) {
      log(`WARNING ${result.warning}`)
      await notify(result.warning)
    }
    return result
  } catch (e) {
    const msg = e instanceof SignInNeeded
      ? 'Backups need you to sign in again. In the app folder run: npm run backup -- login'
      : `Last night's backup didn't finish: ${(e as Error).message}`
    await writeJson(STATE, { ...prev, lastError: msg, lastErrorAt: new Date().toISOString() })
    log(`FAILED ${msg}`)
    await notify(msg)
    reported = true
    throw e
  }
}

class SignInNeeded extends Error {
  constructor() {
    super('sign-in needed')
  }
}

async function backupWith(sb: SupabaseClient, cfg: Config, state: BackupState) {
  await mkdir(cfg.dir, { recursive: true })
  const result = await runBackup({
    state,
    rpc: async (fn, args) => {
      const { data, error } = await sb.rpc(fn, args)
      if (error) throw new Error(`${fn}: ${error.message}`)
      return data
    },
    media: {
      async listMediaMany(entryIds) {
        const out: MediaRow[] = []
        for (let i = 0; i < entryIds.length; i += 100) {
          const { data, error } = await sb.from('media')
            .select('id, entry_id, storage_path, thumb_path, width, height, bytes, sha256')
            .in('entry_id', entryIds.slice(i, i + 100)).is('deleted_at', null)
          if (error) throw new Error(`media: ${error.message}`)
          out.push(...((data as MediaRow[]) ?? []))
        }
        return out
      },
      async signedUrls(paths) {
        if (!paths.length) return {}
        const { data, error } = await sb.storage.from('media').createSignedUrls(paths, 3600)
        if (error) throw new Error(`photos: ${error.message}`)
        return Object.fromEntries((data ?? []).filter((d) => d.path && d.signedUrl).map((d) => [d.path!, d.signedUrl]))
      },
    },
    list: async () => readdir(cfg.dir),
    write: async (name, bytes) => {
      const tmp = join(cfg.dir, `.${name}.partial`)
      await writeFile(tmp, bytes)
      await rename(tmp, join(cfg.dir, name))
    },
    read: async (name) => new Uint8Array(await readFile(join(cfg.dir, name))),
    remove: async (name) => unlink(join(cfg.dir, name)),
  })
  // the Desk's "Last backup" line counts this as a backup (best effort: a failure here never fails the run)
  try {
    const { data } = await sb.auth.getUser()
    if (data.user) await sb.from('profiles').update({ last_export_at: new Date().toISOString() }).eq('id', data.user.id)
  } catch {
    /* the backup is on disk; this line is only a courtesy */
  }
  return result
}

const plist = (node: string, script: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${script}</string><string>run</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`

async function install() {
  if (!(await exists(CONFIG))) throw new Error('Sign in first: npm run backup -- login')
  await mkdir(SUPPORT, { recursive: true })
  await mkdir(join(HOME, 'Library', 'LaunchAgents'), { recursive: true })
  await mkdir(join(HOME, 'Library', 'Logs'), { recursive: true })
  await copyFile(process.argv[1], INSTALLED_SCRIPT)
  const uid = String(process.getuid?.() ?? '')
  await sh('launchctl', ['bootout', `gui/${uid}/${LABEL}`])
  await writeFile(PLIST, plist(process.execPath, INSTALLED_SCRIPT))
  const r = await sh('launchctl', ['bootstrap', `gui/${uid}`, PLIST])
  if (r.code !== 0) throw new Error(`launchctl couldn't load the schedule: ${r.err.trim()}`)
  console.log('Scheduled: every night at 03:30 (a missed night runs when the Mac wakes), and at login.')
  console.log('A first run has started in the background. In a minute: npm run backup -- status')
  console.log(`If macOS asks whether "node" may use iCloud Drive or a folder, allow it; that is this backup.`)
  console.log(`Uses ${process.execPath}. If you upgrade or move Node, run install again.`)
}

async function uninstall() {
  const uid = String(process.getuid?.() ?? '')
  await sh('launchctl', ['bootout', `gui/${uid}/${LABEL}`])
  await rm(PLIST, { force: true })
  await rm(INSTALLED_SCRIPT, { force: true })
  const cfg = await readJson<Config | null>(CONFIG, null)
  if (cfg) await keychain.remove(cfg.email)
  console.log('Stopped the nightly backup and removed its sign-in from the Keychain.')
  if (cfg) console.log(`Your backups are still in ${cfg.dir}.`)
}

async function status() {
  const cfg = await readJson<Config | null>(CONFIG, null)
  if (!cfg) return console.log('Not set up. Run: npm run backup -- login')
  const s = await readJson<BackupState>(STATE, emptyState())
  const uid = String(process.getuid?.() ?? '')
  const scheduled = (await sh('launchctl', ['print', `gui/${uid}/${LABEL}`])).code === 0
  const signedIn = !!(await keychain.get(cfg.email))
  const since = (iso: string | null) => (iso ? `${new Date(iso).toLocaleString()}` : 'never')
  console.log(`Account:      ${cfg.email}${signedIn ? '' : '  (signed out: run login)'}`)
  console.log(`Folder:       ${cfg.dir}`)
  console.log(`Schedule:     ${scheduled ? 'nightly at 03:30 and at login' : 'not scheduled (run install)'}`)
  console.log(`Last success: ${since(s.lastSuccessAt)}`)
  if (s.lastFile) console.log(`Latest file:  ${s.lastFile} (${s.lastEntries} entries, ${s.lastPhotos} photos)`)
  if (s.lastError && (!s.lastSuccessAt || s.lastErrorAt! > s.lastSuccessAt)) console.log(`Last problem: ${s.lastError} (${since(s.lastErrorAt)})`)
  if (s.lastSuccessAt && Date.now() - Date.parse(s.lastSuccessAt) > 3 * 86_400_000) console.log('Note: no successful backup for over 3 days.')
  console.log(`Log:          ${LOG}`)
}

let reported = false
const commands: Record<string, () => Promise<unknown>> = { login, run: runOnce, install, uninstall, status }
const cmd = process.argv[2] ?? 'status'
const run = commands[cmd]
if (!run) {
  console.log('Usage: npm run backup -- login | run | install | status | uninstall')
  process.exit(2)
}
run().then(
  () => process.exit(0),
  (e) => {
    if (!reported) console.error((e as Error).message)
    process.exit(1)
  },
)
