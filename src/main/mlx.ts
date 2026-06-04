import { app } from 'electron'
import { spawn, ChildProcess, spawnSync } from 'child_process'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'
import { totalmem } from 'os'
import { getThinkingStrategy } from './skills/thinking-strategies'

const MLX_PORT = 11434
const MLX_HOST = `127.0.0.1:${MLX_PORT}`
const MLX_URL = `http://${MLX_HOST}`
const MLX_SSE_IDLE_TIMEOUT_MS = 120_000

type MLXServerKind = 'vlm' | 'lm'

let serverProc: ChildProcess | null = null
let currentModel: string | null = null
let currentServerKind: MLXServerKind | null = null

export function getServerKindForModel(model: string): MLXServerKind {
  const normalized = model.toLowerCase()
  if (normalized.includes('gemma-4-26b') || normalized.includes('gemma-4-31b')) {
    return 'lm'
  }
  return 'vlm'
}

function serverModuleForKind(kind: MLXServerKind): string {
  return kind === 'lm' ? 'mlx_lm.server' : 'mlx_vlm.server'
}

// ---------------------------------------------------------------------------
// Paths — everything lives under <appData>/mlx/
// ---------------------------------------------------------------------------

function dataDir(): string {
  return join(app.getPath('userData'), 'mlx')
}

function venvDir(): string {
  return join(dataDir(), 'venv')
}

/** The python binary inside our managed venv */
function venvPython(): string {
  return join(venvDir(), 'bin', 'python3')
}

function modelsDir(): string {
  return join(dataDir(), 'models')
}

// ---------------------------------------------------------------------------
// System Python detection
// ---------------------------------------------------------------------------

/**
 * Find a compatible system Python (3.10–3.14).
 * We try versioned binaries first (most reliable), then fall back to `python3`.
 */
function findSystemPython(): string | null {
  // Prefer specific known-good versions, newest first
  const versionedCandidates = [
    '/opt/homebrew/Caskroom/miniforge/base/envs/env_314/bin/python',
    '/opt/homebrew/Caskroom/miniforge/base/envs/env_314/bin/python3',
    '/opt/homebrew/bin/python3.14',
    '/opt/homebrew/opt/python@3.14/bin/python3.14',
    '/usr/local/bin/python3.14',
    '/opt/homebrew/bin/python3.13',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.10',
    '/opt/homebrew/opt/python@3.13/bin/python3.13',
    '/opt/homebrew/opt/python@3.14/bin/python3.14',
    '/opt/homebrew/opt/python@3.12/bin/python3.12',
    '/opt/homebrew/opt/python@3.11/bin/python3.11',
    '/opt/homebrew/opt/python@3.10/bin/python3.10',
    '/usr/local/bin/python3.14',
    '/usr/local/bin/python3.13',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.11',
    '/usr/local/bin/python3.10'
  ]

  for (const c of versionedCandidates) {
    try {
      const s = spawnSync(c, ['--version'], { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
      if (s.status === 0) {
        console.log(`[mlx] Found compatible Python: ${c} (${s.stdout.toString().trim()})`)
        return c
      }
    } catch {
      // not available
    }
  }

  // Last resort: try generic python3 but verify it's in the supported range.
  const fallbacks = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']
  for (const c of fallbacks) {
    try {
      const s = spawnSync(c, ['--version'], { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
      if (s.status === 0) {
        const ver = s.stdout.toString().trim() // e.g. "Python 3.13.2"
        const match = ver.match(/Python 3\.(\d+)/)
        const minor = match ? parseInt(match[1], 10) : 99
        if (minor >= 10 && minor <= 14) {
          console.log(`[mlx] Found compatible Python: ${c} (${ver})`)
          return c
        } else if (minor < 10) {
          console.log(`[mlx] Skipping ${c} — ${ver} is too old (need 3.10+)`)
        } else {
          console.log(`[mlx] Skipping ${c} — ${ver} is too new for mlx-vlm`)
        }
      }
    } catch {
      // not available
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// MLX detection
// ---------------------------------------------------------------------------

export interface MLXStatus {
  /** Python to use for running MLX servers (venv python if installed, system python otherwise) */
  python: string
  /** Whether required MLX packages are installed */
  installed: boolean
}

function hasRequiredMLXPackages(python: string): boolean {
  try {
    const check = spawnSync(python, [
      '-c',
      [
        'import importlib.util',
        'missing = [name for name in ("mlx_vlm", "mlx_lm") if importlib.util.find_spec(name) is None]',
        'raise SystemExit(1 if missing else 0)'
      ].join('; ')
    ], {
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return check.status === 0
  } catch {
    return false
  }
}

/**
 * Check if the required MLX packages are ready to use.
 * Returns the python path to use and whether mlx_vlm / mlx_lm are installed.
 */
export function locateMLX(): MLXStatus | null {
  // 1. Check if we have a working venv with required MLX packages installed
  const vPy = venvPython()
  if (existsSync(vPy)) {
    // Verify the venv Python is 3.10+ — older versions can't run modern mlx-vlm
    try {
      const verCheck = spawnSync(vPy, ['--version'], {
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const verStr = verCheck.stdout?.toString().trim() || ''
      const verMatch = verStr.match(/Python 3\.(\d+)/)
      const minor = verMatch ? parseInt(verMatch[1], 10) : 0
      if (minor < 10) {
        console.log(`[mlx] Existing venv uses ${verStr} (too old). Deleting and recreating…`)
        try { rmSync(venvDir(), { recursive: true, force: true }) } catch { /* ok */ }
        // Fall through to system python detection below
      } else {
        // Venv Python is compatible — check if required MLX packages are installed
        if (hasRequiredMLXPackages(vPy)) {
          console.log('[mlx] Found mlx-vlm and mlx-lm in venv')
          return { python: vPy, installed: true }
        }
        // Venv exists but a package is missing — can still pip install into it
        return { python: vPy, installed: false }
      }
    } catch {
      // Can't check version — treat as needing recreation
      console.log('[mlx] Cannot determine venv Python version. Recreating…')
      try { rmSync(venvDir(), { recursive: true, force: true }) } catch { /* ok */ }
    }
  }

  // 2. No venv yet — find a compatible system python so we can create one
  const sysPython = findSystemPython()
  if (!sysPython) return null
  return { python: sysPython, installed: false }
}

// ---------------------------------------------------------------------------
// Installation — creates a venv and installs MLX server packages
// ---------------------------------------------------------------------------

export type InstallProgress = {
  stage: 'download' | 'install'
  message: string
}

/**
 * Install MLX server packages into a dedicated virtual environment.
 * Uses --index-url to bypass any corporate pip registries.
 * Returns the venv python path to use for all subsequent operations.
 */
export async function installMLX(
  onProgress: (p: InstallProgress) => void
): Promise<string> {
  const sysPython = findSystemPython()
  if (!sysPython) {
    throw new Error(
      'Python 3.10–3.14 not found. Please install Python via Homebrew or Miniforge.'
    )
  }

  const vDir = venvDir()
  const vPy = venvPython()

  // Step 1: Create venv if needed
  if (!existsSync(vPy)) {
    onProgress({ stage: 'install', message: 'Creating Python virtual environment…' })
    console.log(`[mlx] Creating venv at ${vDir} using ${sysPython}`)
    await runProcess(sysPython, ['-m', 'venv', vDir], onProgress)
  }

  // Step 2: Upgrade pip first (avoids old-pip issues)
  onProgress({ stage: 'install', message: 'Upgrading pip…' })
  await runProcess(vPy, [
    '-m', 'pip', 'install', '--upgrade', 'pip',
    '--index-url', 'https://pypi.org/simple/'
  ], onProgress)

  // Step 3: Install MLX server packages (force public PyPI to bypass corporate registries)
  onProgress({ stage: 'install', message: 'Installing MLX server packages (this may take a few minutes)…' })
  await runProcess(vPy, [
    '-m', 'pip', 'install', '--upgrade', 'mlx-vlm>=0.4.3', 'mlx-lm',
    '--index-url', 'https://pypi.org/simple/'
  ], onProgress)

  // Verify the install worked
  if (!hasRequiredMLXPackages(vPy)) {
    throw new Error('MLX server packages installed but failed verification.')
  }

  console.log('[mlx] MLX server packages installed successfully')
  return vPy
}

/** Run a subprocess and stream output to onProgress */
function runProcess(
  cmd: string,
  args: string[],
  onProgress: (p: InstallProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        // Force public PyPI — don't inherit corporate pip.conf
        PIP_INDEX_URL: 'https://pypi.org/simple/',
        PIP_EXTRA_INDEX_URL: ''
      }
    })

    let stderr = ''
    proc.stdout?.on('data', (d) => {
      const line = d.toString().trim()
      if (line) onProgress({ stage: 'install', message: line.slice(0, 120) })
    })
    proc.stderr?.on('data', (d) => {
      stderr += d.toString()
      const line = d.toString().trim()
      if (line) onProgress({ stage: 'install', message: line.slice(0, 120) })
    })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed (exit ${code}): ${stderr.slice(-500)}`))
    })
  })
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface ServerProgress {
  message: string
  /** 0.0–1.0 progress fraction, if available */
  progress?: number
}

export async function startServer(
  python: string,
  model: string,
  onProgress?: (p: ServerProgress) => void
): Promise<void> {
  const serverKind = getServerKindForModel(model)
  const serverModule = serverModuleForKind(serverKind)
  if (serverProc && !serverProc.killed && currentModel === model && currentServerKind === serverKind) return

  // Kill existing server if running with different model
  await stopServer()

  const env = {
    ...process.env,
    APC_ENABLED: '1',
    APC_NUM_BLOCKS: '4096',
    // HuggingFace cache dir — keep models in our app data
    HF_HOME: modelsDir(),
    TRANSFORMERS_CACHE: modelsDir(),
    HF_HUB_DISABLE_TELEMETRY: '1'
  }

  // Track early exit so waitForHealth can bail out immediately
  let earlyExit: { code: number | null; stderr: string } | null = null
  let stderrBuf = ''

  const spawnArgs = ['-m', serverModule, '--model', model, '--port', String(MLX_PORT)]
  if (serverKind === 'lm') {
    const cacheBytes = Math.floor(totalmem() * 0.35)
    spawnArgs.push('--prompt-cache-bytes', String(cacheBytes))
  }

  console.log(
    `[mlx] Starting server: APC_ENABLED=1 APC_NUM_BLOCKS=4096 ${python} ${spawnArgs.join(' ')}`
  )

  serverProc = spawn(
    python,
    spawnArgs,
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    }
  )
  currentModel = model
  currentServerKind = serverKind

  serverProc.stdout?.on('data', (d) => console.log('[mlx]', d.toString().trim()))
  let progressDone = false
  serverProc.stderr?.on('data', (d) => {
    const text = d.toString()
    stderrBuf += text
    console.log('[mlx]', text.trim())

    // Parse HuggingFace download progress from stderr
    // Format: "Fetching 8 files:  50%|█████     | 4/8 [00:55<00:59, 14.98s/it]"
    if (onProgress && !progressDone) {
      const lines = text.split('\n')
      for (const line of lines) {
        // Match "Fetching N files: XX%" pattern
        const fetchMatch = line.match(/Fetching\s+(\d+)\s+files?:\s+(\d+)%.*?(\d+)\/(\d+)/)
        if (fetchMatch) {
          const pct = parseInt(fetchMatch[2], 10)
          const done = parseInt(fetchMatch[3], 10)
          const total = parseInt(fetchMatch[4], 10)
          onProgress({
            message: `Downloading model files… ${done}/${total}`,
            progress: pct / 100
          })
          continue
        }

        if (line.includes('Starting httpd')) {
          onProgress({ message: 'Starting server…', progress: 1.0 })
        }
      }
    }
  })
  serverProc.on('exit', (code) => {
    console.log('[mlx] server exited with code', code)
    earlyExit = { code, stderr: stderrBuf }
    serverProc = null
    currentModel = null
    currentServerKind = null
  })

  // Wait for the server to become healthy.
  // First run downloads model weights from HuggingFace, so allow up to 10 min.
  await waitForHealth(600_000, () => earlyExit)
  progressDone = true
}

export function stopServer(): Promise<void> {
  const proc = serverProc
  serverProc = null
  currentModel = null
  currentServerKind = null

  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    console.log('[mlx] Stopping server')

    let settled = false
    let forceTimer: NodeJS.Timeout | null = null

    const finish = (): void => {
      if (settled) return
      settled = true
      if (forceTimer) clearTimeout(forceTimer)
      resolve()
    }

    proc.once('exit', finish)
    proc.once('error', finish)

    forceTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
      }
      forceTimer = setTimeout(finish, 2000)
    }, 5000)

    if (!proc.kill('SIGTERM')) {
      finish()
    }
  })
}

/**
 * Poll the server's /v1/models endpoint until it responds.
 * If the server process exits early, throw immediately.
 */
async function waitForHealth(
  timeoutMs: number,
  checkEarlyExit: () => { code: number | null; stderr: string } | null
): Promise<void> {
  const start = Date.now()
  let lastError: unknown = null

  while (Date.now() - start < timeoutMs) {
    // Check if the server process crashed
    const exit = checkEarlyExit()
    if (exit) {
      throw new Error(
        `MLX server exited with code ${exit.code}. ${exit.stderr.slice(-500)}`
      )
    }

    try {
      const res = await fetch(`${MLX_URL}/v1/models`)
      if (res.ok) {
        console.log('[mlx] Server is healthy')
        return
      }
    } catch (e) {
      lastError = e
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`MLX server did not become healthy within ${timeoutMs / 1000}s: ${String(lastError)}`)
}

// ---------------------------------------------------------------------------
// Model management
// ---------------------------------------------------------------------------

export async function listLocalModels(): Promise<string[]> {
  try {
    const res = await fetch(`${MLX_URL}/v1/models`)
    if (!res.ok) return []
    const data = (await res.json()) as { data?: Array<{ id: string }> }
    return (data.data ?? []).map((m) => m.id)
  } catch {
    return []
  }
}

export async function hasModel(_name: string): Promise<boolean> {
  try {
    const models = await listLocalModels()
    return models.length > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Chat streaming (OpenAI-compatible SSE)
// ---------------------------------------------------------------------------

export interface MLXChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  images?: string[]
}

export interface MLXChatOptions {
  model: string
  messages: MLXChatMessage[]
  signal?: AbortSignal
  temperature?: number
  /**
   * Enable reasoning/thinking mode if the current model has a registered
   * strategy. No-op when the model is not in THINKING_STRATEGIES — callers can
   * pass this opportunistically without checking model support.
   */
  enableThinking?: boolean
}

export async function* chatStream(
  opts: MLXChatOptions
): AsyncGenerator<{ content?: string; done?: boolean }> {
  const strategy = opts.enableThinking ? getThinkingStrategy(opts.model) : null

  let messages = opts.messages.map((m) => ({ role: m.role, content: m.content }))
  const extraBody: Record<string, unknown> = {}
  let maxTokens = 8192

  if (strategy) {
    if (strategy.trigger.kind === 'system-token') {
      messages = [{ role: 'system', content: strategy.trigger.token }, ...messages]
    } else if (strategy.trigger.kind === 'template-kwarg') {
      extraBody.chat_template_kwargs = { [strategy.trigger.key]: true }
    }
    if (strategy.recommendedMaxTokens && strategy.recommendedMaxTokens > maxTokens) {
      maxTokens = strategy.recommendedMaxTokens
    }
  }

  const res = await fetch(`${MLX_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
      max_tokens: maxTokens,
      ...extraBody
    }),
    signal: opts.signal
  })

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`Chat request failed: ${res.status} ${res.statusText} — ${text}`)
  }

  // Parse SSE stream (OpenAI format: "data: {...}\n\n")
  let reasoningOpen = false
  const stream = res.body as unknown as ReadableStream<Uint8Array>
  for await (const event of readSSE(stream, opts.signal)) {
    if (event === '[DONE]') {
      if (reasoningOpen) {
        yield { content: '</think>\n' }
        reasoningOpen = false
      }
      yield { done: true }
      return
    }
    try {
      const parsed = JSON.parse(event) as {
        choices?: Array<{
          delta?: { content?: string; reasoning?: string; reasoning_content?: string; role?: string }
          finish_reason?: string | null
        }>
      }
      const choice = parsed.choices?.[0]
      const reasoningChunk = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content
      const contentChunk = choice?.delta?.content

      if (reasoningChunk) {
        if (!reasoningOpen) {
          yield { content: '<think>' }
          reasoningOpen = true
        }
        yield { content: reasoningChunk }
      }
      if (contentChunk) {
        if (reasoningOpen) {
          yield { content: '</think>\n' }
          reasoningOpen = false
        }
        yield { content: contentChunk }
      }
      if (choice?.finish_reason === 'stop' || choice?.finish_reason === 'length') {
        if (reasoningOpen) {
          yield { content: '</think>\n' }
          reasoningOpen = false
        }
        yield { done: true }
        return
      }
    } catch {
      // Skip malformed events
    }
  }
  if (reasoningOpen) {
    yield { content: '</think>\n' }
  }
  yield { done: true }
}

/** Parse an SSE byte stream into individual data payloads */
async function* readSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await readWithIdleTimeout(reader, signal)
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 2)
      if (!block) continue
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data) yield data
        }
      }
    }
  }

  // Flush remaining buffer
  if (buf.trim()) {
    for (const line of buf.trim().split('\n')) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim()
        if (data) yield data
      }
    }
  }
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) {
    throwAbortError()
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }

    const resolveOnce = (value: ReadableStreamReadResult<Uint8Array>): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const onAbort = (): void => {
      void reader.cancel().catch(() => {})
      const error = new Error('Chat request aborted')
      error.name = 'AbortError'
      rejectOnce(error)
    }

    timeout = setTimeout(() => {
      void reader.cancel().catch(() => {})
      rejectOnce(
        new Error(
          `Chat stream timed out after ${MLX_SSE_IDLE_TIMEOUT_MS / 1000}s without server output.`
        )
      )
    }, MLX_SSE_IDLE_TIMEOUT_MS)

    signal?.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      (result) => resolveOnce(result),
      (error) => rejectOnce(error instanceof Error ? error : new Error(String(error)))
    )
  })
}

function throwAbortError(): never {
  const error = new Error('Chat request aborted')
  error.name = 'AbortError'
  throw error
}

export { MLX_URL }
