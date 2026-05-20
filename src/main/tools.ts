import {
  wsWriteFile,
  wsReadFile,
  wsEditFile,
  wsDeleteFile,
  wsRunBash,
  ensureWorkspace,
  listTree,
  findFiles,
  previewUrl
} from './workspace'

export interface ToolContext {
  conversationId: string
  onFileChange?: () => void
  allowOutsideWorkspace?: boolean
  /** Names of skills available in the current conversation, used to give a
   *  clearer error when the assistant mistakenly tries to call a skill as a tool. */
  skillNames?: ReadonlySet<string>
}

export interface ToolSpec {
  name: string
  description: string
  params: Array<{ name: string; description: string; required?: boolean; multiline?: boolean }>
  example: string
  mode: 'chat' | 'code' | 'both'
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

async function webSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').trim()
  if (!query) return 'Error: missing query'
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } })
  if (!res.ok) return `Search failed: ${res.status} ${res.statusText}`
  const html = await res.text()
  const results = parseDuckDuckGoResults(html).slice(0, 6)
  if (results.length === 0) return 'No results found.'
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
    .join('\n\n')
}

function parseDuckDuckGoResults(
  html: string
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const blockRe = /<div class="result[^"]*?"[^>]*>([\s\S]*?)<div class="clear"/g
  const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/

  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html))) {
    const block = m[1]
    const t = titleRe.exec(block)
    const s = snippetRe.exec(block)
    if (!t) continue
    const rawUrl = decodeURIComponent(t[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, ''))
      .split('&rut=')[0]
      .split('&amp;')[0]
    const cleanUrl = rawUrl.split('&')[0]
    const title = stripTags(t[2]).trim()
    const snippet = s ? stripTags(s[1]).trim() : ''
    if (title && cleanUrl.startsWith('http')) {
      results.push({ title, url: cleanUrl, snippet })
    }
    if (results.length >= 10) break
  }
  return results
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '0.0.0.0') return true
  const stripped = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
  if (stripped === '::1') return true
  if (stripped.startsWith('::ffff:')) return true
  const parts = stripped.split('.').map(Number)
  if (parts.length === 4 && parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) return true
  }
  return false
}

async function fetchUrl(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '').trim()
  if (!url) return 'Error: missing url'
  if (!/^https?:\/\//.test(url)) return 'Error: url must be http(s)'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Error: invalid URL'
  }
  if (isPrivateHost(parsed.hostname)) {
    return 'Error: fetching localhost or private addresses is not allowed'
  }
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA } })
    if (!res.ok) return `Fetch failed: ${res.status} ${res.statusText}`
    const ct = res.headers.get('content-type') || ''
    const text = await res.text()
    if (ct.includes('html')) {
      return htmlToText(text).slice(0, 8000)
    }
    return text.slice(0, 8000)
  } catch (e) {
    return `Error fetching: ${(e as Error).message}`
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function calc(args: Record<string, unknown>): Promise<string> {
  const expr = String(args.expression ?? '').trim()
  if (!expr) return 'Error: missing expression'
  if (!/^[0-9+\-*/().\s^%,eE]*$/.test(expr)) {
    return 'Error: only numeric expressions allowed'
  }
  try {
    const sanitized = expr.replace(/\^/g, '**')
    const result = Function(`"use strict"; return (${sanitized})`)()
    return String(result)
  } catch (e) {
    return `Error: ${(e as Error).message}`
  }
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  const raw = typeof args.content === 'string' ? args.content : ''
  if (!path) return 'Error: missing <path>'
  const content = cleanFileContent(raw, path)
  await wsWriteFile(ctx.conversationId, path, content, {
    allowOutsideWorkspace: ctx.allowOutsideWorkspace
  })
  ctx.onFileChange?.()
  const lines = content.split('\n').length
  return `Wrote ${path} (${content.length} bytes, ${lines} lines).`
}

export function cleanFileContent(raw: string, path: string): string {
  let s = raw

  // Case 1: fully wrapped in ```lang ... ```
  const full = s.trim().match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```[\s\S]*$/)
  if (full) {
    s = full[1]
  } else {
    // Case 2: just a leading fence ```lang\n
    const lead = s.match(/^\s*```[a-zA-Z0-9_-]*\n/)
    if (lead) {
      s = s.slice(lead[0].length)
      // If there's a trailing fence somewhere, cut everything from there
      const trail = s.search(/\n```(?:\s|$)/)
      if (trail >= 0) s = s.slice(0, trail)
    }
  }

  // Case 3: file-type-aware truncation of post-file commentary
  const lower = path.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const end = s.toLowerCase().lastIndexOf('</html>')
    if (end >= 0) s = s.slice(0, end + '</html>'.length) + '\n'
  } else if (lower.endsWith('.svg')) {
    const end = s.toLowerCase().lastIndexOf('</svg>')
    if (end >= 0) s = s.slice(0, end + '</svg>'.length) + '\n'
  } else if (lower.endsWith('.json')) {
    // Trim anything after a trailing } or ]
    const trimmed = s.trim()
    const lastBrace = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
    if (lastBrace >= 0) s = trimmed.slice(0, lastBrace + 1) + '\n'
  }

  return s
}

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  if (!path) return 'Error: missing <path>'
  try {
    const content = await wsReadFile(ctx.conversationId, path, {
      allowOutsideWorkspace: ctx.allowOutsideWorkspace
    })
    if (content.length > 20_000) {
      return content.slice(0, 20_000) + '\n[…truncated]'
    }
    return content
  } catch (e) {
    return `Error reading ${path}: ${(e as Error).message}`
  }
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  const oldStr = typeof args.old_string === 'string' ? args.old_string : ''
  const newStr = typeof args.new_string === 'string' ? args.new_string : ''
  const replaceAll = args.replace_all === true || args.replace_all === 'true'
  if (!path) return 'Error: missing <path>'
  if (!oldStr) return 'Error: missing <old_string>'
  try {
    const r = await wsEditFile(ctx.conversationId, path, oldStr, newStr, replaceAll, {
      allowOutsideWorkspace: ctx.allowOutsideWorkspace
    })
    ctx.onFileChange?.()
    return `Edited ${path} (${r.occurrences} replacement${r.occurrences === 1 ? '' : 's'}).`
  } catch (e) {
    return `Error editing ${path}: ${(e as Error).message}`
  }
}

async function listFiles(
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const base = await ensureWorkspace(ctx.conversationId)
  const tree = await listTree(base, 200)
  if (tree.length === 0) return '(workspace is empty)'
  return tree
    .map((e) =>
      e.kind === 'dir' ? `${e.path}/` : `${e.path}${e.size != null ? ` (${e.size}B)` : ''}`
    )
    .join('\n')
}

async function findFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = String(args.pattern ?? '').trim()
  if (!pattern) return 'Error: missing <pattern>'
  const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50
  const includeHidden = args.include_hidden === true || args.include_hidden === 'true'
  const includeIgnored = args.include_ignored === true || args.include_ignored === 'true'
  const base = await ensureWorkspace(ctx.conversationId)
  const r = await findFiles(base, { pattern, limit, includeHidden, includeIgnored })
  if (r.matches.length === 0) return `(no files matching "${pattern}")`
  const lines = [...r.matches]
  if (r.truncated) {
    lines.push(`... (truncated, ${r.total - r.matches.length} more match${r.total - r.matches.length === 1 ? '' : 'es'}; refine pattern or raise limit)`)
  }
  return lines.join('\n')
}

async function deleteFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  if (!path) return 'Error: missing <path>'
  try {
    await wsDeleteFile(ctx.conversationId, path, {
      allowOutsideWorkspace: ctx.allowOutsideWorkspace
    })
    ctx.onFileChange?.()
    return `Deleted ${path}.`
  } catch (e) {
    return `Error deleting ${path}: ${(e as Error).message}`
  }
}

async function runBash(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const command = String(args.command ?? '').trim()
  const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 60_000
  if (!command) return 'Error: missing <command>'
  try {
    const r = await wsRunBash(ctx.conversationId, command, timeout)
    ctx.onFileChange?.()
    const parts: string[] = []
    parts.push(`exit=${r.exitCode ?? 'killed'} (${r.durationMs}ms)`)
    if (r.stdout) parts.push('stdout:\n' + r.stdout)
    if (r.stderr) parts.push('stderr:\n' + r.stderr)
    if (r.truncated) parts.push('[output was truncated]')
    return parts.join('\n')
  } catch (e) {
    return `Error: ${(e as Error).message}`
  }
}

async function openPreview(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const url = previewUrl(ctx.conversationId)
  return `Preview is live at ${url}. The Canvas pane on the right shows it.`
}

export const TOOLS: Record<string, ToolSpec> = {
  web_search: {
    name: 'web_search',
    description: 'Search the web via DuckDuckGo. Returns a numbered list of results.',
    params: [{ name: 'query', description: 'what to search for', required: true }],
    example: '@@web_search\nquery: latest tensorflow release notes\n@@end',
    mode: 'both',
    run: webSearch
  },
  fetch_url: {
    name: 'fetch_url',
    description: 'Fetch a web page and return its text content (truncated to ~8KB).',
    params: [{ name: 'url', description: 'absolute http(s) URL', required: true }],
    example: '@@fetch_url\nurl: https://example.com\n@@end',
    mode: 'both',
    run: fetchUrl
  },
  calc: {
    name: 'calc',
    description: 'Evaluate a numeric expression.',
    params: [{ name: 'expression', description: 'math expression', required: true }],
    example: '@@calc\nexpression: 2 + 2 * 3\n@@end',
    mode: 'both',
    run: calc
  },
  write_file: {
    name: 'write_file',
    description:
      'Create or overwrite a file in the workspace. Use this to generate code, HTML, CSS, JSON, etc.',
    params: [
      { name: 'path', description: 'path relative to workspace (e.g. index.html)', required: true },
      { name: 'content', description: 'full file text', required: true, multiline: true }
    ],
    example:
      '@@write_file\npath: index.html\ncontent <<EOF\n<!doctype html>\n<html>\n<body>Hello</body>\n</html>\nEOF\n@@end',
    mode: 'code',
    run: writeFile
  },
  read_file: {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    params: [{ name: 'path', description: 'path relative to workspace', required: true }],
    example: '@@read_file\npath: index.html\n@@end',
    mode: 'code',
    run: readFile
  },
  edit_file: {
    name: 'edit_file',
    description:
      'Replace a snippet in an existing file. old_string must appear exactly once, or set replace_all: true.',
    params: [
      { name: 'path', description: 'file path', required: true },
      { name: 'old_string', description: 'exact text to find', required: true, multiline: true },
      { name: 'new_string', description: 'replacement text', required: true, multiline: true },
      { name: 'replace_all', description: 'true to replace every occurrence' }
    ],
    example:
      '@@edit_file\npath: index.html\nold_string <<OLD\nHello\nOLD\nnew_string <<NEW\nHello, world\nNEW\n@@end',
    mode: 'code',
    run: editFile
  },
  list_files: {
    name: 'list_files',
    description: 'List every file in the workspace.',
    params: [],
    example: '@@list_files\n@@end',
    mode: 'code',
    run: listFiles
  },
  find_file: {
    name: 'find_file',
    description:
      'Find files by name. Pattern accepts globs (*, **, ?) or a plain substring (case-insensitive). Skips hidden files and common build dirs (node_modules, dist, build, out, .git, ...) by default.',
    params: [
      { name: 'pattern', description: 'glob (e.g. "**/*.ts") or substring (e.g. "Button")', required: true },
      { name: 'limit', description: 'max results (default 50, max 500)' },
      { name: 'include_hidden', description: 'true to include dotfiles/dotdirs' },
      { name: 'include_ignored', description: 'true to include node_modules, dist, build, etc.' }
    ],
    example: '@@find_file\npattern: **/*.tsx\n@@end',
    mode: 'code',
    run: findFile
  },
  delete_file: {
    name: 'delete_file',
    description: 'Delete a file or directory from the workspace.',
    params: [{ name: 'path', description: 'path to delete', required: true }],
    example: '@@delete_file\npath: old.html\n@@end',
    mode: 'code',
    run: deleteFile
  },
  run_bash: {
    name: 'run_bash',
    description:
      'Run a bash command inside the workspace directory. Use for npm install, git, formatters, quick checks. Commands must not access external networks or send data outside the workspace.',
    params: [
      { name: 'command', description: 'shell command', required: true, multiline: true }
    ],
    example: '@@run_bash\ncommand: ls -la\n@@end',
    mode: 'code',
    run: runBash
  },
  open_preview: {
    name: 'open_preview',
    description:
      'Reveal the Canvas preview. Call after creating or updating index.html so the user sees the result.',
    params: [],
    example: '@@open_preview\n@@end',
    mode: 'code',
    run: openPreview
  }
}

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

function renderToolHelp(mode: 'chat' | 'code'): string {
  const wanted = (t: ToolSpec): boolean => t.mode === 'both' || t.mode === mode
  const lines: string[] = []
  for (const t of Object.values(TOOLS)) {
    if (!wanted(t)) continue
    lines.push(`### ${t.name}`)
    lines.push(t.description)
    if (t.params.length) {
      lines.push('Parameters:')
      for (const p of t.params) {
        const req = p.required ? ' (required)' : ''
        const multi = p.multiline ? ' — use heredoc' : ''
        lines.push(`  ${p.name}: ${p.description}${req}${multi}`)
      }
    } else {
      lines.push('No parameters.')
    }
    lines.push('Example:')
    lines.push(t.example)
    lines.push('')
  }
  return lines.join('\n')
}

function languageInstruction(lang?: string): string {
  switch (lang) {
    case 'zh-TW': return 'Always respond in Traditional Chinese (繁體中文).'
    case 'ja':    return 'Always respond in Japanese (日本語).'
    case 'ko':    return 'Always respond in Korean (한국어).'
    default:      return ''
  }
}

export function chatSystemPrompt(enableTools: boolean, chatLanguage?: string): string {
  const now = new Date().toISOString()
  const day = new Date().toLocaleDateString('en-US', { weekday: 'long' })
  const inst = languageInstruction(chatLanguage)
  if (!enableTools) {
    return [
      "You are Gemma, an AI assistant running 100% locally on the user's Mac.",
      `Current date/time: ${now} (${day}). Timezone: ${tz()}.`,
      'Be clear, concise, and helpful. Use markdown for formatting when useful.',
      ...(inst ? ['', inst] : [])
    ].join('\n')
  }
  return [
    "You are Gemma, an AI assistant running 100% locally on the user's Mac.",
    `Current date/time: ${now} (${day}). Timezone: ${tz()}.`,
    '',
    'TOOL USE',
    '========',
    'When a tool helps, emit ONE action block and STOP. You will receive the result in a `=== tool_result ===` block, then you may continue or call another tool.',
    '',
    'Action format (bash heredoc style):',
    '@@<tool_name>',
    'param_name: single-line-value',
    'param_name <<MARKER',
    'multi-line value',
    'goes here',
    'MARKER',
    '@@end',
    '',
    'Rules:',
    '- Action lines (@@<tool_name>, key: value, MARKER, @@end) MUST each be on their own line.',
    '- Inside a heredoc body, write content exactly as-is — no escaping needed. Any character is fine, including <, >, {, }, ", \\.',
    '- The MARKER is any identifier you choose (e.g. EOF, FILE, CMD). The same MARKER must appear alone on its own line to close the heredoc.',
    '- Never wrap actions in markdown code fences.',
    '- After writing @@end, STOP. Wait for the result before continuing.',
    '- When finished, write a short plain-text answer and emit no more actions.',
    '',
    'Tools:',
    '',
    renderToolHelp('chat'),
    ...(inst ? ['', inst] : [])
  ].join('\n')
}

export function codeSystemPrompt(workspacePath: string, previewHref: string, chatLanguage?: string): string {
  const now = new Date().toISOString()
  const day = new Date().toLocaleDateString('en-US', { weekday: 'long' })
  const inst = languageInstruction(chatLanguage)
  return [
    "You are Gemma, a local coding agent running entirely on the user's Mac.",
    `Date: ${now} (${day}). Workspace: ${workspacePath}. Preview: ${previewHref}`,
    '',
    'INTENT GATE',
    'Only build, edit, or write files when the user clearly asks you to create, modify, implement, debug, or inspect an app, page, demo, script, or project.',
    'If the user is asking a general question, chatting, brainstorming, or asking about the app itself, answer normally in plain text and do NOT emit write_file, edit_file, run_bash, or open_preview actions.',
    'When in doubt, ask one concise clarifying question instead of creating files.',
    '',
    'WHAT TO BUILD',
    'When the user clearly wants something built, you build small apps, pages, demos, and scripts. Quality matters — the user is watching.',
    '- Modern, polished design by default: clean typography, generous whitespace, subtle gradients, rounded corners, smooth transitions. Dark-mode-friendly when it fits.',
    '- Real-feeling copy, not lorem ipsum. Invent brand names and details.',
    '- Make it actually work: click handlers wired, animations smooth, forms usable.',
    '- Fetch real images only when asked; otherwise use CSS/SVG for illustrations.',
    '',
    'FILE STRUCTURE — PREFER MULTI-FILE FOR ANYTHING NON-TRIVIAL',
    '- Tiny demos can be a single `index.html` with inline style/script tags.',
    '- Landing pages, apps with state, anything > ~200 lines → split into:',
    '    `index.html` — structure; link the stylesheet and load the script externally',
    '    `style.css`  — all styling',
    '    `app.js`     — all behavior',
    '- Multi-file is easier to read, edit later, and shows off modular thinking. Emit a separate write_file action for each file.',
    '',
    'HOW YOU WORK',
    '1. For clear build requests, start with ONE sentence describing your plan (e.g., "I\'ll split this into index.html, style.css, and app.js."). Then IMMEDIATELY emit your first write_file action in the SAME response. Do NOT stop after planning — start building right away.',
    '2. After each action, STOP and wait for the result. The result arrives in a `=== tool_result ===` block. In subsequent turns, one sentence of narration (e.g., "Now the stylesheet."), then the action, then STOP.',
    '3. After all files are written, call `open_preview`, then write a one-sentence plain-text summary. Emit no further actions.',
    '',
    'CRITICAL FOR BUILD REQUESTS: You MUST emit a write_file action in your VERY FIRST response. Never respond with only a plan or description. Always start coding immediately.',
    '',
    'ACTION FORMAT — bash heredoc style',
    '@@<tool_name>',
    'key: single-line-value',
    'key <<MARKER',
    'multi-line value',
    'MARKER',
    '@@end',
    '',
    'HEREDOC RULES — READ TWICE',
    'Inside a heredoc body (between `key <<MARKER` and the closing `MARKER` line), text is WRITTEN TO DISK LITERALLY. No escaping. Any character is allowed: <, >, {, }, ", \\, /, anything.',
    '- NEVER put ``` fences at the start or end of a file content heredoc. Not ``` alone, not ```html, not ```js. None.',
    '- NEVER put explanatory text, "Key Features", "Instructions to Use", or any commentary inside a file content heredoc. Only the actual file contents.',
    '- The closing MARKER must be on its own line, exactly matching the opening MARKER. No leading/trailing chars on that line.',
    '- After the closing MARKER, close the action with `@@end` on its own line.',
    '- The < character in code (e.g. `i < n`, `y < arr.length`, `a < b`) is a comparison operator — write it verbatim. The heredoc body is plain text, NOT XML.',
    '',
    'EXAMPLE — first write_file response',
    '',
    "I'll start with the core logic in app.js, then add a small HTML shell that loads it.",
    '',
    '@@write_file',
    'path: app.js',
    'content <<EOF',
    'const numbers = [1, 2, 3, 4, 5]',
    'const doubled = []',
    'for (let i = 0; i < numbers.length; i++) {',
    '  doubled.push(numbers[i] * 2)',
    '}',
    'console.log(doubled)',
    'EOF',
    '@@end',
    '',
    'HARD RULES',
    '- If and only if the user clearly wants something built, start coding in your first response. Never reply with only a plan for a build request.',
    '- For non-build requests, answer normally and do not call workspace tools.',
    '- Never paste file contents in your chat reply — only inside a heredoc body.',
    '- Never wrap action blocks in ``` code fences.',
    '- Paths are relative to the workspace (no leading slashes).',
    '- One action per response, then STOP and wait.',
    '',
    'AVAILABLE TOOLS',
    '',
    renderToolHelp('code'),
    ...(inst ? ['', inst] : [])
  ].join('\n')
}

export interface ParsedAction {
  name: string
  args: Record<string, unknown>
  raw: string
  start: number
  end: number
}

export function findNextAction(text: string, from = 0): ParsedAction | 'incomplete' | null {
  // Try heredoc format first (new primary format).
  const here = findNextHeredocAction(text, from)
  if (here !== null) return here
  // Fall back to legacy XML format for old conversations.
  return findNextXmlAction(text, from)
}

// New primary format: bash-style heredoc.
//
//   @@<tool_name>
//   key: value           (single-line param)
//   key <<MARKER         (heredoc multi-line param)
//   ...content...
//   MARKER
//   @@end
//
// Inside a heredoc body, anything goes — no escaping. The marker must appear
// alone on its own line to close the body.
function findNextHeredocAction(text: string, from: number): ParsedAction | 'incomplete' | null {
  let scanFrom = from
  while (scanFrom <= text.length) {
    const atIdx = text.indexOf('@@', scanFrom)
    if (atIdx < 0) return null
    // Must be at start of line (or start of text)
    if (atIdx > 0 && text[atIdx - 1] !== '\n') {
      scanFrom = atIdx + 2
      continue
    }
    const nlIdx = text.indexOf('\n', atIdx)
    if (nlIdx < 0) {
      // Possibly still streaming the opening line — defer.
      return 'incomplete'
    }
    const firstLine = text.slice(atIdx + 2, nlIdx).trim()
    // Skip orphan @@end markers
    if (firstLine === 'end' || firstLine === '') {
      scanFrom = nlIdx + 1
      continue
    }
    const nameMatch = firstLine.match(/^([a-zA-Z_][\w]*)$/)
    if (!nameMatch) {
      scanFrom = atIdx + 2
      continue
    }
    const name = nameMatch[1]
    const result = parseHeredocBody(text, nlIdx + 1, atIdx, name)
    return result
  }
  return null
}

function parseHeredocBody(
  text: string,
  bodyStart: number,
  actionStart: number,
  name: string
): ParsedAction | 'incomplete' {
  const args: Record<string, unknown> = {}
  let lineStart = bodyStart
  while (lineStart <= text.length) {
    const nlIdx = text.indexOf('\n', lineStart)
    const lineEnd = nlIdx < 0 ? text.length : nlIdx
    const line = text.slice(lineStart, lineEnd)
    const trimmed = line.trimEnd()

    // Action terminator
    if (trimmed === '@@end') {
      const actionEnd = nlIdx < 0 ? text.length : nlIdx + 1
      return {
        name,
        args,
        raw: text.slice(actionStart, actionEnd),
        start: actionStart,
        end: actionEnd
      }
    }

    // Heredoc declaration: `key <<MARKER`
    const heredocMatch = trimmed.match(/^([a-zA-Z_][\w]*)[ \t]+<<([a-zA-Z_][\w]*)$/)
    if (heredocMatch) {
      const [, key, marker] = heredocMatch
      if (nlIdx < 0) return 'incomplete'
      const hbStart = nlIdx + 1
      // Scan forward for marker line
      let scan = hbStart
      let foundMarkerStart = -1
      while (scan <= text.length) {
        const nl = text.indexOf('\n', scan)
        const candEnd = nl < 0 ? text.length : nl
        const candLine = text.slice(scan, candEnd)
        if (candLine.trimEnd() === marker) {
          foundMarkerStart = scan
          if (nl < 0) {
            // Marker line found but no trailing newline — treat as last line
            lineStart = text.length + 1
          } else {
            lineStart = nl + 1
          }
          break
        }
        if (nl < 0) return 'incomplete'
        scan = nl + 1
      }
      if (foundMarkerStart < 0) return 'incomplete'
      // Body is up to (but not including) the newline before the marker line.
      let bodyEnd = foundMarkerStart
      if (bodyEnd > hbStart && text[bodyEnd - 1] === '\n') bodyEnd -= 1
      let content = text.slice(hbStart, bodyEnd)
      // Defensive: if the model still HTML-escaped chars, decode them.
      content = content.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      args[key] = content
      continue
    }

    // `key: value`
    const kvMatch = trimmed.match(/^([a-zA-Z_][\w]*)[ \t]*:[ \t]*(.*)$/)
    if (kvMatch) {
      const [, key, rawVal] = kvMatch
      const v = rawVal.trim()
      if (v === 'true') args[key] = true
      else if (v === 'false') args[key] = false
      else if (/^-?\d+$/.test(v)) args[key] = Number(v)
      else args[key] = v
      if (nlIdx < 0) return 'incomplete'
      lineStart = nlIdx + 1
      continue
    }

    // Unknown / blank line — skip
    if (nlIdx < 0) return 'incomplete'
    lineStart = nlIdx + 1
  }
  return 'incomplete'
}

// Legacy XML parser kept as fallback for conversations whose history contains
// the old `<action>...</action>` format.
function findNextXmlAction(text: string, from: number): ParsedAction | 'incomplete' | null {
  const openRe = /<action\s+name\s*=\s*["']?([a-zA-Z_][\w]*)["']?\s*>/gi
  openRe.lastIndex = from
  const open = openRe.exec(text)
  if (!open) return null
  const name = open[1]
  const bodyStart = open.index + open[0].length
  const closeMatch = text.slice(bodyStart).match(/<\/action\s*>/i)
  if (!closeMatch || closeMatch.index === undefined) return 'incomplete'
  const closeIdx = bodyStart + closeMatch.index
  const body = text.slice(bodyStart, closeIdx)
  const args = parseXmlActionBody(body)
  return {
    name,
    args,
    raw: text.slice(open.index, closeIdx + closeMatch[0].length),
    start: open.index,
    end: closeIdx + closeMatch[0].length
  }
}

function parseXmlActionBody(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const contentOpen = body.indexOf('<content>')
  let outside = body
  if (contentOpen >= 0) {
    const contentCloseRel = body.lastIndexOf('</content>')
    if (contentCloseRel > contentOpen) {
      let content = body.slice(contentOpen + '<content>'.length, contentCloseRel)
      content = content.replace(/^\n/, '')
      content = content.replace(/\n[ \t]*$/, '')
      content = content.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      args.content = content
      outside = body.slice(0, contentOpen) + body.slice(contentCloseRel + '</content>'.length)
    }
  }
  const tagRe = /<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(outside)) !== null) {
    const key = m[1]
    if (key === 'content') continue
    const raw = m[2]
    const trimmed = raw.trim()
    if (trimmed === 'true') args[key] = true
    else if (trimmed === 'false') args[key] = false
    else if (/^-?\d+$/.test(trimmed)) args[key] = Number(trimmed)
    else args[key] = raw.replace(/^\n/, '').replace(/\n[ \t]*$/, '')
  }
  return args
}

export function emitSafeBoundary(buffer: string, from: number): number {
  // Hold back any tail that could be the start of a forming action opener
  // (either heredoc `@@<name>` at start of line, or legacy `<action ...>`).
  for (let i = buffer.length - 1; i >= from; i--) {
    const ch = buffer[i]
    if (ch === '@') {
      // Heredoc opener must be at start of line.
      if (i > 0 && buffer[i - 1] !== '\n') continue
      const tail = buffer.slice(i)
      // `@@<name>\n` is the open form. If we haven't seen the closing newline
      // yet, the action header is still forming — hold back.
      if (!tail.includes('\n')) return i
      // Has a newline → first line is complete; if it matches @@<name> it will
      // be picked up by findNextAction in a later pass.
      continue
    }
    if (ch === '<') {
      const tail = buffer.slice(i).toLowerCase()
      if (tail.length < 8) {
        if ('<action'.startsWith(tail)) return i
        continue
      }
      if (tail.startsWith('<action') && /\s/.test(tail[7])) return i
    }
  }
  return buffer.length
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const tool = TOOLS[name]
  if (!tool) {
    if (ctx.skillNames?.has(name)) {
      return (
        `Error: "${name}" is a skill, not a tool. Skills cannot be invoked with @@${name} action blocks. ` +
        `Only the user can activate a skill by typing "$${name}" in their message. ` +
        `Stop waiting for a tool result and instead reply to the user, telling them to re-send the request with "$${name} " prepended.`
      )
    }
    return `Error: unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}`
  }
  try {
    return await tool.run(args, ctx)
  } catch (e) {
    return `Error running ${name}: ${(e as Error).message}`
  }
}
