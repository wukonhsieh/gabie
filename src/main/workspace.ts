import { app } from 'electron'
import { createServer, type Server } from 'http'
import { createReadStream } from 'fs'
import { mkdir, readFile, writeFile, readdir, stat, access, rm, rename } from 'fs/promises'
import { join, resolve, dirname, extname, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import {
  isBashCommandDenied,
  isResolvedPathInside,
  wsRunBash as llmWsRunBash,
  wsWriteFile as llmWsWriteFile,
  wsReadFile as llmWsReadFile,
  wsDeleteFile as llmWsDeleteFile,
  type BashResult,
  type SpawnFn
} from 'llm-tools'

export { isBashCommandDenied, isResolvedPathInside }
export type { BashResult, SpawnFn }

let server: Server | null = null
let serverPort = 0
const conversationWorkspaceRoots = new Map<string, string>()

export function workspacesRoot(): string {
  return join(app.getPath('userData'), 'workspaces')
}

export function workspaceDir(conversationId: string): string {
  const registered = conversationWorkspaceRoots.get(sanitizeId(conversationId))
  if (registered) return registered
  return join(workspacesRoot(), sanitizeId(conversationId))
}

export function registerConversationWorkspace(
  conversationId: string,
  workspacePath?: string
): void {
  const key = sanitizeId(conversationId)
  if (!workspacePath) {
    conversationWorkspaceRoots.delete(key)
    return
  }
  const resolved = resolve(workspacePath)
  if (!isAbsolute(resolved)) {
    throw new Error(`Workspace path must be absolute: ${workspacePath}`)
  }
  conversationWorkspaceRoots.set(key, resolved)
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default'
}

export async function ensureWorkspace(conversationId: string): Promise<string> {
  const dir = workspaceDir(conversationId)
  await mkdir(dir, { recursive: true })
  return dir
}

export function assertInWorkspace(base: string, target: string): string {
  const resolved = resolve(base, target)
  if (!isResolvedPathInside(base, resolved)) {
    throw new Error(`Path escapes workspace: ${target}`)
  }
  return resolved
}

export interface WorkspacePathClassification {
  requestedPath: string
  workspaceRoot: string
  resolvedPath: string
  withinWorkspace: boolean
  requiresAsk: boolean
  reason: string
}

export function classifyWorkspacePath(
  conversationId: string,
  requestedPath: string
): WorkspacePathClassification {
  return classifyPathAgainstWorkspace(workspaceDir(conversationId), requestedPath)
}

export function classifyPathAgainstWorkspace(
  workspaceRoot: string,
  requestedPath: string
): WorkspacePathClassification {
  const root = resolve(workspaceRoot)
  const raw = String(requestedPath ?? '')
  const trimmed = raw.trim()
  const resolvedPath = resolve(root, trimmed || '.')
  const withinWorkspace = !!trimmed && isResolvedPathInside(root, resolvedPath)
  const requiresAsk = !withinWorkspace
  let reason = 'Path is inside the workspace.'
  if (!trimmed) {
    reason = 'Path is empty.'
  } else if (requiresAsk) {
    reason = isAbsolute(trimmed)
      ? 'Absolute path is outside the workspace.'
      : 'Relative path escapes the workspace.'
  }
  return {
    requestedPath: raw,
    workspaceRoot: root,
    resolvedPath,
    withinWorkspace,
    requiresAsk,
    reason
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.tsx': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

export async function startWorkspaceServer(): Promise<number> {
  if (server) return serverPort
  await mkdir(workspacesRoot(), { recursive: true })

  server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type')
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      res.setHeader('Pragma', 'no-cache')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const url = new URL(req.url ?? '/', `http://localhost`)
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length === 0) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('gabie workspace server')
        return
      }
      const id = parts[0]
      const root = workspaceDir(id)
      const rel = parts.slice(1).join('/') || ''
      let target: string
      try {
        target = assertInWorkspace(root, rel)
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('Bad path')
        return
      }

      let s
      try {
        s = await stat(target)
      } catch {
        // Maybe it's a root with no index yet — render placeholder
        if (rel === '' || rel === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(renderPlaceholder(id))
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not found')
        return
      }

      if (s.isDirectory()) {
        const indexPath = join(target, 'index.html')
        try {
          await access(indexPath)
          const body = await readFile(indexPath)
          res.writeHead(200, { 'content-type': MIME['.html'] })
          res.end(body)
          return
        } catch {
          // directory listing
          const entries = await readdir(target, { withFileTypes: true })
          const files = entries.map((e) => ({
            name: e.name,
            kind: e.isDirectory() ? 'dir' : 'file'
          }))
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(renderDirList(id, rel, files))
          return
        }
      }

      const ext = extname(target).toLowerCase()
      const mime = MIME[ext] ?? 'application/octet-stream'
      res.writeHead(200, {
        'content-type': mime,
        'content-length': s.size
      })
      createReadStream(target).pipe(res)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end((e as Error).message)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (addr && typeof addr !== 'string') {
    serverPort = addr.port
  }
  return serverPort
}

export function stopWorkspaceServer(): void {
  if (server) {
    server.close()
    server = null
    serverPort = 0
  }
}

export function getWorkspaceServerPort(): number {
  return serverPort
}

export function previewUrl(conversationId: string): string {
  return `http://127.0.0.1:${serverPort}/${sanitizeId(conversationId)}/`
}

function renderPlaceholder(_id: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview</title>
<style>
  html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#0e0e0e;color:#888;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
  .box{max-width:360px;padding:28px;text-align:center}
  .ico{width:44px;height:44px;margin:0 auto 14px;opacity:.35}
  .title{color:#e8e8e8;font-weight:500;margin-bottom:6px}
</style></head><body>
<div class="box">
  <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/></svg>
  <div class="title">No preview yet</div>
  <div>Ask Gemma to create <code style="color:#bbb">index.html</code> to see it here.</div>
</div>
</body></html>`
}

function renderDirList(
  id: string,
  rel: string,
  files: Array<{ name: string; kind: string }>
): string {
  const rows = files
    .map(
      (f) =>
        `<li><a href="/${id}/${rel}${rel ? '/' : ''}${f.name}">${escapeHtml(f.name)}</a> <span class="k">${f.kind}</span></li>`
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(rel || id)}</title>
<style>
  body{margin:0;padding:24px 28px;background:#0e0e0e;color:#e8e8e8;font:13.5px/1.6 -apple-system,BlinkMacSystemFont,sans-serif}
  h1{font-size:13px;color:#888;font-weight:500;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em}
  ul{list-style:none;padding:0;margin:0}
  li{padding:6px 0;border-bottom:1px solid #1a1a1a}
  a{color:#e8e8e8;text-decoration:none}
  a:hover{color:#7aa2f7}
  .k{color:#555;font-size:11px;margin-left:8px}
</style></head><body>
<h1>/${escapeHtml(rel || '')}</h1>
<ul>${rows}</ul>
</body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface FileEntry {
  path: string
  kind: 'file' | 'dir'
  size?: number
}

export async function listTree(base: string, max = 200): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    if (out.length >= max) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.name === 'node_modules') continue
      const p = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        out.push({ path: p, kind: 'dir' })
        await walk(join(dir, e.name), p)
      } else {
        try {
          const s = await stat(join(dir, e.name))
          out.push({ path: p, kind: 'file', size: s.size })
        } catch {
          out.push({ path: p, kind: 'file' })
        }
      }
      if (out.length >= max) return
    }
  }
  await walk(base, '')
  return out
}

export const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  '.next',
  '.cache',
  '.turbo',
  'coverage'
]

function globToRegex(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i += 2
        if (glob[i] === '/') i++
      } else {
        re += '[^/]*'
        i++
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c
      i++
    } else {
      re += c
      i++
    }
  }
  return new RegExp('^' + re + '$', 'i')
}

export interface FindFilesOptions {
  pattern: string
  limit?: number
  includeHidden?: boolean
  includeIgnored?: boolean
}

export interface FindFilesResult {
  matches: string[]
  truncated: boolean
  total: number
}

export async function findFiles(base: string, opts: FindFilesOptions): Promise<FindFilesResult> {
  const limit = opts.limit ?? 50
  const includeHidden = opts.includeHidden ?? false
  const includeIgnored = opts.includeIgnored ?? false
  const pattern = opts.pattern.trim()
  const isGlob = /[*?\[\]]/.test(pattern)
  const matcher = isGlob ? globToRegex(pattern) : null
  const needle = pattern.toLowerCase()
  const matches: string[] = []
  let total = 0

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!includeHidden && e.name.startsWith('.')) continue
      if (!includeIgnored && e.isDirectory() && DEFAULT_IGNORE_DIRS.includes(e.name)) continue
      const p = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        await walk(join(dir, e.name), p)
      } else {
        const hit = matcher ? matcher.test(p) || matcher.test(e.name) : p.toLowerCase().includes(needle)
        if (hit) {
          total++
          if (matches.length < limit) matches.push(p)
        }
      }
    }
  }
  await walk(base, '')
  return { matches, truncated: total > matches.length, total }
}

export interface WorkspaceAccessOptions {
  allowOutsideWorkspace?: boolean
}

export async function wsWriteFile(
  conversationId: string,
  path: string,
  content: string,
  options: WorkspaceAccessOptions = {}
): Promise<string> {
  const base = workspaceDir(conversationId)
  if (options.allowOutsideWorkspace) {
    const classification = classifyPathAgainstWorkspace(base, path)
    const target = classification.resolvedPath
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(tmp, content, 'utf-8')
      await rename(tmp, target)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw new Error(`write_file failed for ${path}: ${(err as Error).message}`)
    }
    return target
  }
  return llmWsWriteFile(base, path, content)
}

export async function wsReadFile(
  conversationId: string,
  path: string,
  options: WorkspaceAccessOptions = {}
): Promise<string> {
  const base = workspaceDir(conversationId)
  if (options.allowOutsideWorkspace) {
    const classification = classifyPathAgainstWorkspace(base, path)
    return readFile(classification.resolvedPath, 'utf-8')
  }
  return llmWsReadFile(base, path)
}

export async function wsEditFile(
  conversationId: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll = false,
  options: WorkspaceAccessOptions = {}
): Promise<{ occurrences: number }> {
  const content = await wsReadFile(conversationId, path, options)
  if (replaceAll) {
    const parts = content.split(oldString)
    if (parts.length === 1) throw new Error(`old_string not found in ${path}`)
    const next = parts.join(newString)
    await wsWriteFile(conversationId, path, next, options)
    return { occurrences: parts.length - 1 }
  }
  const idx = content.indexOf(oldString)
  if (idx < 0) throw new Error(`old_string not found in ${path}`)
  const second = content.indexOf(oldString, idx + oldString.length)
  if (second >= 0) {
    throw new Error(`old_string appears multiple times in ${path}. Use replace_all or add context.`)
  }
  const next = content.slice(0, idx) + newString + content.slice(idx + oldString.length)
  await wsWriteFile(conversationId, path, next, options)
  return { occurrences: 1 }
}

export async function wsDeleteFile(
  conversationId: string,
  path: string,
  options: WorkspaceAccessOptions = {}
): Promise<void> {
  const base = workspaceDir(conversationId)
  if (options.allowOutsideWorkspace) {
    const classification = classifyPathAgainstWorkspace(base, path)
    await rm(classification.resolvedPath, { recursive: true, force: true })
    return
  }
  return llmWsDeleteFile(base, path)
}

export async function wsRunBash(
  conversationId: string,
  command: string,
  timeoutMs = 60000,
  maxBytes = 16000
): Promise<BashResult> {
  return llmWsRunBash(workspaceDir(conversationId), command, timeoutMs, maxBytes)
}
