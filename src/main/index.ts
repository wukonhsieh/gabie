import { app, shell, BrowserWindow, ipcMain, nativeTheme, session, nativeImage, dialog } from 'electron'
import { stat } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { AVAILABLE_MODELS } from '@shared/types'
import {
  locateMLX,
  installMLX,
  startServer,
  stopServer,
  chatStream,
  listLocalModels,
  type MLXChatMessage
} from './mlx'
import {
  TOOLS,
  chatSystemPrompt,
  codeSystemPrompt,
  findNextAction,
  emitSafeBoundary,
  runTool,
  cleanFileContent,
  type ToolContext
} from './tools'
import {
  ensureWorkspace,
  startWorkspaceServer,
  stopWorkspaceServer,
  getWorkspaceServerPort,
  previewUrl,
  listTree,
  workspaceDir,
  workspacesRoot,
  wsWriteFile,
  registerConversationWorkspace,
  classifyWorkspacePath,
  isResolvedPathInside
} from './workspace'
import {
  evaluateToolPermission,
  loadToolPermissionPolicy,
  saveToolPermission,
  loadChatLanguage,
  saveChatLanguage,
  type ToolPermissionPolicy,
  type ToolPermissionEvaluation
} from './permissions'
import { LOOP_WINDOW, CYCLE_REPEATS, toolFingerprint, detectToolLoop } from './toolLoopGuard'
import { detectTextRepetition } from './textRepetitionGuard'
import {
  loadChatStateFromDisk,
  normalizeChatState,
  saveChatStateToDisk
} from './conversations'
import {
  scanAllSkills,
  type ScopeEntry,
  detectSkillInvocation,
  loadSkill,
  type LoadedSkillsRegistry,
  type SkillIndex
} from 'llm-tools'
import { writeSkillArtifacts, buildSkillCatalogFromIndex } from './skills/indexer'
import { stripThinkingFromContent } from './skills/thinking-strategies'
import {
  SETTINGS_CHANNELS,
  type ChatRequest,
  type ChatState,
  type StreamChunk,
  type ToolCall,
  type ToolInfo,
  type ToolPermissionRequest,
  type ToolPermissionResponse,
  type ToolPermissionResponseDecision,
  type ToolPermissionValue
} from '../shared/types'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0e0e0e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (is.dev) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

let mlxPython: string | null = null

async function ensureMLXRunning(model: string): Promise<string> {
  let mlx = locateMLX()
  if (!mlx) {
    throw new Error(
      'Python 3.10–3.14 not found. Install via Homebrew or Miniforge.'
    )
  }

  let pythonToUse = mlx.python

  if (!mlx.installed) {
    send('setup:status', {
      stage: 'installing-mlx',
      message: 'Installing MLX runtime…'
    })
    // installMLX creates the venv and returns the venv python path
    pythonToUse = await installMLX((p) => {
      send('setup:status', {
        stage: 'installing-mlx',
        message: p.message
      })
    })
  }

  mlxPython = pythonToUse

  const label = AVAILABLE_MODELS.find((m) => m.name === model)?.label ?? model
  send('setup:status', { stage: 'starting-mlx', message: 'Starting model runtime…' })
  send('setup:status', {
    stage: 'downloading-model',
    message: `Loading ${label}… (first run downloads the model)`
  })
  await startServer(pythonToUse, model, (p) => {
    send('setup:status', {
      stage: 'downloading-model',
      message: p.message,
      progress: p.progress
    })
  })
  return pythonToUse
}

async function handleSetup(model: string): Promise<void> {
  try {
    send('setup:status', { stage: 'checking', message: 'Checking system…' })
    await ensureMLXRunning(model)
    send('setup:status', { stage: 'ready', message: 'Ready to chat.' })
  } catch (e) {
    send('setup:status', {
      stage: 'error',
      message: 'Setup failed',
      error: (e as Error).message
    })
  }
}

const MAX_TOOL_ROUNDS_CHAT = 12
const MAX_TOOL_ROUNDS_CODE = 80

const PATH_PERMISSION_TOOLS = new Set(['write_file', 'read_file', 'edit_file', 'delete_file'])

interface ActionPermissionEvaluation extends ToolPermissionEvaluation {
  allowOutsideWorkspaceOnApproval?: boolean
  autoAllowOutsideWorkspace?: boolean
}

// Skill folders activated during this conversation. Reads under these
// directories bypass the "outside workspace" permission prompt because
// the user explicitly invoked the skill — re-prompting per file would
// just churn through prompts the user already said yes to in spirit.
const conversationAllowedSkillDirs = new Map<string, Set<string>>()

function registerAllowedSkillDir(conversationId: string, skillDir: string): void {
  const normalized = resolve(skillDir)
  let set = conversationAllowedSkillDirs.get(conversationId)
  if (!set) {
    set = new Set()
    conversationAllowedSkillDirs.set(conversationId, set)
  }
  set.add(normalized)
}

function isPathInsideActivatedSkillDir(conversationId: string, resolvedPath: string): boolean {
  const set = conversationAllowedSkillDirs.get(conversationId)
  if (!set || set.size === 0) return false
  for (const dir of set) {
    if (isResolvedPathInside(dir, resolvedPath)) return true
  }
  return false
}

function isSkillActiveForConversation(conversationId: string): boolean {
  const set = conversationAllowedSkillDirs.get(conversationId)
  return !!set && set.size > 0
}

// Verbs that signal the assistant is claiming a deliverable exists.
const SUCCESS_CLAIM_PATTERN =
  /\b(generated|created|saved|written|produced|rendered|exported|completed|complete|finished|ready|available|successful(?:ly)?)\b/i

// File-path-shaped tokens with a known extension. Restricted to common output
// types to keep false-positive surface area small.
const CLAIMED_FILE_PATTERN =
  /(?<![\w@])([\w./-]+\.(?:pptx|ppt|pdf|docx|doc|xlsx|xls|csv|md|json|html?|svg|png|jpe?g|gif|mp[34]|zip|tar|gz|txt|log|yaml|yml))\b/gi

async function findFabricatedFileClaims(
  text: string,
  conversationId: string
): Promise<string[]> {
  if (!SUCCESS_CLAIM_PATTERN.test(text)) return []
  const wsDir = workspaceDir(conversationId)
  const candidates = new Set<string>()
  for (const match of text.matchAll(CLAIMED_FILE_PATTERN)) {
    const p = match[1].replace(/[)\].,;:!?'"`]+$/, '').trim()
    if (!p) continue
    if (/^https?:\/\//i.test(p) || p.startsWith('www.')) continue
    candidates.add(p)
  }
  const missing: string[] = []
  for (const p of candidates) {
    const target = p.startsWith('/') ? p : resolve(wsDir, p)
    try {
      await stat(target)
    } catch {
      missing.push(p)
    }
  }
  return missing
}

interface PendingToolPermission {
  conversationId: string
  resolve: (decision: ToolPermissionResponseDecision) => void
  reject: (error: Error) => void
}

const pendingToolPermissions = new Map<string, PendingToolPermission>()

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function evaluateActionPermission(
  req: ChatRequest,
  basePolicy: ToolPermissionPolicy,
  toolName: string,
  args: Record<string, unknown>
): ActionPermissionEvaluation {
  const policy = { ...basePolicy, ...(req.toolPermissions ?? {}) }
  const decision = evaluateToolPermission(toolName, policy)
  if (decision.mode === 'deny') return decision

  if (PATH_PERMISSION_TOOLS.has(toolName) && typeof args.path === 'string') {
    const pathCheck = classifyWorkspacePath(req.conversationId, args.path)
    if (pathCheck.requiresAsk) {
      if (isPathInsideActivatedSkillDir(req.conversationId, pathCheck.resolvedPath)) {
        return {
          mode: 'allow',
          reason: 'Path is inside a skill folder activated in this conversation.',
          autoAllowOutsideWorkspace: true
        }
      }
      return {
        mode: 'ask',
        reason: `${pathCheck.reason} Approval is required to access ${pathCheck.resolvedPath}.`,
        allowOutsideWorkspaceOnApproval: true
      }
    }
  }

  return decision
}

function waitForToolPermission(
  request: ToolPermissionRequest,
  signal: AbortSignal
): Promise<ToolPermissionResponseDecision> {
  if (signal.aborted) return Promise.reject(abortError('Permission request aborted.'))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      pendingToolPermissions.delete(request.id)
      reject(abortError('Permission request aborted.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pendingToolPermissions.set(request.id, {
      conversationId: request.conversationId,
      resolve: (decision) => {
        signal.removeEventListener('abort', onAbort)
        pendingToolPermissions.delete(request.id)
        resolve(decision)
      },
      reject: (error) => {
        signal.removeEventListener('abort', onAbort)
        pendingToolPermissions.delete(request.id)
        reject(error)
      }
    })
  })
}

function resolveToolPermission(response: ToolPermissionResponse): boolean {
  const pending = pendingToolPermissions.get(response.requestId)
  if (!pending) return false
  pending.resolve(response.decision)
  return true
}

function clearConversationPermissions(conversationId: string): void {
  for (const [id, pending] of pendingToolPermissions.entries()) {
    if (pending.conversationId !== conversationId) continue
    pending.reject(abortError('Conversation ended before permission was resolved.'))
    pendingToolPermissions.delete(id)
  }
}

function actionTarget(_name: string, args: Record<string, unknown>): string | undefined {
  if (typeof args.path === 'string') return args.path
  if (typeof args.query === 'string') return String(args.query)
  if (typeof args.url === 'string') return String(args.url)
  if (typeof args.command === 'string')
    return String(args.command).slice(0, 80)
  return undefined
}

function latestUserMessage(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const message = req.messages[i]
    if (message.role === 'user') return message.content
  }
  return ''
}

function hasExplicitBuildIntent(req: ChatRequest): boolean {
  const text = latestUserMessage(req).toLowerCase()
  if (!text.trim()) return false

  const negativeIntent =
    /\b(don't|do not|dont|without|no need to|not asking you to)\b.{0,40}\b(build|create|make|write|code|app|page|site|file)\b/.test(
      text
    ) ||
    /(不要|不用|不需要|先不要|沒有要).{0,24}(寫|做|建立|創建|產生|生成|開發|實作|app|應用|網頁|網站|檔案|程式)/.test(
      text
    )

  if (negativeIntent) return false

  return (
    /\b(build|create|make|implement|generate|write|code|scaffold|prototype)\b.{0,80}\b(app|page|site|website|demo|script|component|game|tool|file|project)\b/.test(
      text
    ) ||
    /\b(app|page|site|website|demo|script|component|game|tool|project)\b.{0,80}\b(build|create|make|implement|generate|write|code|scaffold|prototype)\b/.test(
      text
    ) ||
    /(做|建立|創建|產生|生成|寫|開發|實作|刻|弄).{0,24}(app|應用|網頁|網站|頁面|demo|腳本|程式|遊戲|工具|專案|檔案)/.test(
      text
    ) ||
    /(app|應用|網頁|網站|頁面|demo|腳本|程式|遊戲|工具|專案|檔案).{0,24}(做|建立|創建|產生|生成|寫|開發|實作|刻|弄)/.test(
      text
    )
  )
}

async function handleChat(req: ChatRequest, channel: string): Promise<void> {
  const abort = new AbortController()
  chatAbortControllers.set(req.conversationId, abort)
  registerConversationWorkspace(req.conversationId, req.workspacePath)
  const toolPermissionPolicy = await loadToolPermissionPolicy()

  const emit = (chunk: StreamChunk): void => send(channel, chunk)

  try {
    const baseMessages: MLXChatMessage[] = []

    const chatLang = await loadChatLanguage()
    if (req.mode === 'code') {
      const wsPath = await ensureWorkspace(req.conversationId)
      const href = previewUrl(req.conversationId)
      baseMessages.push({ role: 'system', content: codeSystemPrompt(wsPath, href, chatLang) })
    } else {
      baseMessages.push({ role: 'system', content: chatSystemPrompt(req.enableTools, chatLang) })
    }

    // Skill scan: runs on first handleChat, and re-runs whenever workspacePath changes
    // (e.g. user links a project mid-conversation) or the previous scan failed.
    // Scans project (if open) → global (~/.agents/skills) → builtin (app resources/skills).
    const cachedSkillState = conversationSkillStates.get(req.conversationId)
    let skillState: ConversationSkillState
    if (cachedSkillState && cachedSkillState.scannedWorkspacePath === req.workspacePath) {
      skillState = cachedSkillState
    } else {
      const prevLoadedSkills = cachedSkillState?.loadedSkills ?? {}
      const prevTurnCount = cachedSkillState?.turnCount ?? 0
      try {
        const homeDir = app.getPath('home')
        const userDataDir = app.getPath('userData')
        const builtinRoot = is.dev
          ? join(app.getAppPath(), 'resources', 'skills')
          : join(process.resourcesPath, 'skills')

        const scopes = buildSkillScopes(req.workspacePath, homeDir, userDataDir, builtinRoot)

        const artifactRoot = req.workspacePath ?? userDataDir
        const lock = await scanAllSkills(scopes)
        const { index } = await writeSkillArtifacts(artifactRoot, lock)
        skillState = { index, loadedSkills: prevLoadedSkills, turnCount: prevTurnCount, scannedWorkspacePath: req.workspacePath }
        conversationSkillStates.set(req.conversationId, skillState)
      } catch {
        // Don't cache a failed scan — mark scannedWorkspacePath as undefined so the next
        // turn will retry. Use an empty index for the current turn only.
        skillState = { index: { skills: [] }, loadedSkills: prevLoadedSkills, turnCount: prevTurnCount, scannedWorkspacePath: undefined }
        conversationSkillStates.set(req.conversationId, skillState)
      }
    }
    skillState.turnCount++

    // Inject available skill catalog so the model always knows which skills exist.
    const modelInvocableSkills = skillState.index.skills.filter((s) => s.modelInvocable)
    if (modelInvocableSkills.length > 0) {
      baseMessages.push({ role: 'system', content: buildSkillCatalogFromIndex(skillState.index) })
    }

    // Detect explicit skill invocation in the latest user message.
    let lastUserIdx = -1
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (req.messages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    const lastUserMsg = lastUserIdx >= 0 ? req.messages[lastUserIdx] : undefined
    let skillInjection: string | null = null
    let skillError: string | null = null
    let strippedLastUserContent: string | null = null
    let rewrittenLastUserContent: string | null = null

    if (lastUserMsg) {
      const { skillName, strippedMessage } = detectSkillInvocation(lastUserMsg.content)
      if (skillName) {
        strippedLastUserContent = strippedMessage || lastUserMsg.content
        const result = await loadSkill(
          skillName,
          skillState.index,
          skillState.loadedSkills,
          skillState.turnCount
        )
        if (result.ok) {
          skillInjection = result.content
          rewrittenLastUserContent = skillInjection + '\n\n---\n\n' + strippedLastUserContent
          const loadedEntry = skillState.index.skills.find((s) => s.name === skillName)
          if (loadedEntry) {
            registerAllowedSkillDir(req.conversationId, dirname(loadedEntry.path))
          }
          // Persist the injected content back to the renderer's conversation history
          // so subsequent turns still see the full SKILL.md procedure. Without this,
          // SKILL.md is visible to the model only for the turn it was first triggered.
          send('chat:rewrite_message', {
            conversationId: req.conversationId,
            messageIndex: lastUserIdx,
            content: rewrittenLastUserContent
          })
        } else {
          skillError = result.reason
        }
      }
    }

    for (let i = 0; i < req.messages.length; i++) {
      const m = req.messages[i]
      const isLastUser = i === lastUserIdx && rewrittenLastUserContent !== null
      const rawContent = isLastUser ? rewrittenLastUserContent! : m.content
      const content = m.role === 'assistant' ? stripThinkingFromContent(rawContent) : rawContent
      baseMessages.push({ role: m.role as MLXChatMessage['role'], content })
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (tc.result != null) {
            baseMessages.push({
              role: 'user',
              content: `=== tool_result name=${tc.name} status=ok ===\n${tc.result}\n=== end ===`
            })
          }
        }
      }
    }

    if (skillError) {
      emit({ type: 'token', text: `⚠️ ${skillError}\n\n` })
    }

    const ctx: ToolContext = {
      workspacePath: workspaceDir(req.conversationId),
      conversationId: req.conversationId,
      onFileChange: () => send('workspace:changed', { conversationId: req.conversationId }),
      skillNames: new Set(skillState.index.skills.map((s) => s.name))
    }

    const useTools = req.mode === 'code' || req.enableTools
    const maxRounds = req.mode === 'code' ? MAX_TOOL_ROUNDS_CODE : MAX_TOOL_ROUNDS_CHAT

    emit({ type: 'activity', activity: { kind: 'thinking', chars: 0 } })

    const toolHistory: string[] = []
    let loopNudgeIssued = false
    let verificationNudgeIssued = false
    let textLoopNudgeIssued = false

    for (let round = 0; round < maxRounds; round++) {
      let buffer = ''
      let emittedIdx = 0
      let firstToken = true
      let executedAction = false
      let textRepetitionDetected = false
      let lastActivityTs = 0
      let pendingAction: { name: string; target?: string } | null = null

      // Live-write state for write_file streaming
      let livePath: string | null = null
      let liveContentStart = -1
      let liveMarker: string | null = null
      let lastLiveWrite = 0
      let livePending: Promise<unknown> | null = null
      let lastEmittedContent = ''
      const writeLivePartial = (): void => {
        if (!livePath || liveContentStart < 0 || livePending) return
        let partial = buffer.slice(liveContentStart)
        if (partial.startsWith('\n')) partial = partial.slice(1)
        // Find content terminator: heredoc MARKER on its own line, or legacy </content>
        let closeIdx = -1
        if (liveMarker) {
          const re = new RegExp(`(?:^|\\n)${liveMarker}(?:\\n|$)`)
          const m = partial.match(re)
          if (m && m.index !== undefined) {
            closeIdx = m[0].startsWith('\n') ? m.index : m.index
          }
        } else {
          closeIdx = partial.indexOf('</content>')
        }
        if (closeIdx >= 0) partial = partial.slice(0, closeIdx)
        const cleaned = cleanFileContent(partial, livePath)
        if (cleaned !== lastEmittedContent) {
          lastEmittedContent = cleaned
          send('file:streaming', {
            conversationId: req.conversationId,
            path: livePath,
            content: cleaned,
            done: false
          })
        }
        livePending = wsWriteFile(req.conversationId, livePath, cleaned)
          .then(() => {
            send('workspace:changed', { conversationId: req.conversationId })
          })
          .catch(() => {
            /* tolerate partial write failures */
          })
          .finally(() => {
            livePending = null
          })
      }

      const emitActivity = (): void => {
        const now = Date.now()
        if (now - lastActivityTs < 400) return
        lastActivityTs = now
        if (pendingAction) {
          emit({
            type: 'activity',
            activity: {
              kind: 'tool',
              tool: pendingAction.name,
              target: pendingAction.target,
              chars: buffer.length
            }
          })
        } else {
          emit({ type: 'activity', activity: { kind: 'generating', chars: buffer.length } })
        }
      }

      streamLoop: for await (const chunk of chatStream({
        model: req.model,
        messages: baseMessages,
        signal: abort.signal,
        enableThinking: skillInjection !== null || req.enableThinking === true
      })) {
        if (chunk.content) {
          if (firstToken) {
            firstToken = false
            emit({ type: 'activity', activity: { kind: 'generating', chars: 0 } })
          }
          buffer += chunk.content

          // Forward raw token to devtools console for debugging
          mainWindow?.webContents.send('chat:raw', {
            conversationId: req.conversationId,
            chunk: chunk.content
          })

          // Detect if we've started an action (for activity label + live writes)
          const extractTarget = (rest: string): string | undefined => {
            // Heredoc: `path: value` or `url: value` etc.
            const heredocKv =
              rest.match(/(?:^|\n)path[ \t]*:[ \t]*([^\n]+)/i) ||
              rest.match(/(?:^|\n)url[ \t]*:[ \t]*([^\n]+)/i) ||
              rest.match(/(?:^|\n)query[ \t]*:[ \t]*([^\n]+)/i) ||
              rest.match(/(?:^|\n)command[ \t]*:[ \t]*([^\n]+)/i)
            if (heredocKv) return heredocKv[1].trim()
            // Legacy XML: <path>value</path>
            const pathM = rest.match(/<path>([^<]+?)<\/path>/i)
            const urlM = rest.match(/<url>([^<]+?)<\/url>/i)
            const qM = rest.match(/<query>([^<]+?)<\/query>/i)
            const cmdM = rest.match(/<command>([^<\n]+)/i)
            return pathM?.[1] || urlM?.[1] || qM?.[1] || cmdM?.[1]
          }
          if (!pendingAction) {
            const slice = buffer.slice(emittedIdx)
            // Heredoc: `@@<tool_name>\n` at start of line
            const hereOpen = slice.match(/(?:^|\n)@@([a-zA-Z_][\w]*)[ \t]*\n/)
            if (hereOpen && hereOpen[1] !== 'end') {
              const name = hereOpen[1]
              const restStart = (hereOpen.index ?? 0) + hereOpen[0].length
              const rest = slice.slice(restStart)
              pendingAction = { name, target: extractTarget(rest) }
            } else {
              // Legacy XML
              const openMatch = slice.match(
                /<action\s+name\s*=\s*["']?([a-zA-Z_][\w]*)["']?\s*>/i
              )
              if (openMatch) {
                const rest = slice.slice(openMatch.index ?? 0)
                pendingAction = { name: openMatch[1], target: extractTarget(rest) }
              }
            }
          } else if (!pendingAction.target) {
            const t = extractTarget(buffer.slice(emittedIdx))
            if (t) pendingAction.target = t
          }

          // Live write_file streaming — create/update the file as content grows
          if (pendingAction?.name === 'write_file' && pendingAction.target && !livePath) {
            const livePermission = evaluateActionPermission(
              req,
              toolPermissionPolicy,
              'write_file',
              { path: pendingAction.target }
            )
            if (livePermission.mode === 'allow') {
              livePath = pendingAction.target
            }
          }
          if (livePath && liveContentStart < 0) {
            // Heredoc: `content <<MARKER\n` — capture MARKER and set start after \n
            const hereMatch = buffer.match(/(?:^|\n)content[ \t]+<<([a-zA-Z_][\w]*)[ \t]*\n/)
            if (hereMatch && hereMatch.index !== undefined) {
              liveMarker = hereMatch[1]
              liveContentStart = hereMatch.index + hereMatch[0].length
            } else {
              // Legacy XML
              const idx = buffer.indexOf('<content>')
              if (idx >= 0) liveContentStart = idx + '<content>'.length
            }
          }
          if (livePath && liveContentStart >= 0) {
            const now = Date.now()
            if (now - lastLiveWrite > 450) {
              lastLiveWrite = now
              writeLivePartial()
            }
          }

          if (!pendingAction && detectTextRepetition(buffer)) {
            textRepetitionDetected = true
            break streamLoop
          }

          emitActivity()

          while (true) {
            if (!useTools) {
              // No tool parsing: stream tokens as they arrive
              if (emittedIdx < buffer.length) {
                emit({ type: 'token', text: buffer.slice(emittedIdx) })
                emittedIdx = buffer.length
              }
              break
            }

            const found = findNextAction(buffer, emittedIdx)

            if (found === null) {
              // No action starting in the remaining buffer: emit safe text
              const safe = emitSafeBoundary(buffer, emittedIdx)
              if (safe > emittedIdx) {
                emit({ type: 'token', text: buffer.slice(emittedIdx, safe) })
                emittedIdx = safe
              }
              break
            }

            if (found === 'incomplete') {
              // Action has started but not closed. Emit text up to the open tag.
              const openIdx = buffer.indexOf('<action', emittedIdx)
              if (openIdx > emittedIdx) {
                emit({ type: 'token', text: buffer.slice(emittedIdx, openIdx) })
                emittedIdx = openIdx
              }
              break
            }

            // Emit any text between last emit and action start
            if (found.start > emittedIdx) {
              emit({ type: 'token', text: buffer.slice(emittedIdx, found.start) })
            }
            emittedIdx = found.end

            const call: ToolCall = {
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              name: found.name,
              args: found.args,
              running: true
            }
            emit({ type: 'tool_call', call })
            emit({
              type: 'activity',
              activity: { kind: 'tool', tool: found.name, target: actionTarget(found.name, found.args) }
            })

            let result = ''
            let hadError = false
            let shouldRunTool = true
            const permission = evaluateActionPermission(
              req,
              toolPermissionPolicy,
              found.name,
              found.args
            )
            let allowOutsideWorkspace = permission.autoAllowOutsideWorkspace === true
            if (permission.mode === 'deny') {
              result = `Permission denied for ${found.name}: ${permission.reason}`
              hadError = true
              shouldRunTool = false
              emit({ type: 'tool_result', id: call.id, error: result })
            } else if (permission.mode === 'ask') {
              const request: ToolPermissionRequest = {
                id: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                conversationId: req.conversationId,
                toolCallId: call.id,
                toolName: found.name,
                args: found.args,
                mode: 'ask',
                target: actionTarget(found.name, found.args),
                reason: permission.reason,
                createdAt: Date.now()
              }
              emit({ type: 'tool_permission', request })
              const decision = await waitForToolPermission(request, abort.signal)
              if (decision === 'deny') {
                result = `Permission denied for ${found.name}: ${permission.reason}`
                hadError = true
                shouldRunTool = false
                emit({ type: 'tool_result', id: call.id, error: result })
              } else {
                allowOutsideWorkspace = permission.allowOutsideWorkspaceOnApproval === true
              }
            }

            try {
              if (shouldRunTool) {
                result = await runTool(found.name, found.args, {
                  ...ctx,
                  allowOutsideWorkspace
                })
                emit({ type: 'tool_result', id: call.id, result })
              }
            } catch (e) {
              result = `Error: ${(e as Error).message}`
              hadError = true
              emit({ type: 'tool_result', id: call.id, error: result })
            }

            baseMessages.push({ role: 'assistant', content: buffer.slice(0, emittedIdx) })
            baseMessages.push({
              role: 'user',
              content: `=== tool_result name=${found.name} status=${hadError ? 'error' : 'ok'} ===\n${result}\n=== end ===`
            })
            executedAction = true

            toolHistory.push(toolFingerprint(found.name, found.args))
            if (toolHistory.length > LOOP_WINDOW) toolHistory.shift()
            const loop = detectToolLoop(toolHistory)
            if (loop) {
              if (!loopNudgeIssued) {
                loopNudgeIssued = true
                baseMessages.push({
                  role: 'user',
                  content: `=== system_notice ===\nDetected a repeating tool-call pattern (cycle length ${loop.k}, repeated ${CYCLE_REPEATS} times). Stop repeating the same actions. Either change your approach, or finish the turn with a final answer instead of calling another tool.\n=== end ===`
                })
                // Reset history so the nudge gets a fresh window to judge.
                toolHistory.length = 0
              } else {
                emit({ type: 'activity', activity: { kind: 'idle' } })
                emit({
                  type: 'error',
                  error: `Aborted: tool calls kept looping (cycle length ${loop.k}) even after a nudge to change approach.`
                })
                return
              }
            }
            if (livePath) {
              send('file:streaming', {
                conversationId: req.conversationId,
                path: livePath,
                content: lastEmittedContent,
                done: true
              })
            }
            pendingAction = null
            livePath = null
            liveContentStart = -1
            liveMarker = null
            lastEmittedContent = ''
            emit({ type: 'activity', activity: { kind: 'thinking', chars: 0 } })
            // Break out of the current stream — we need to start a new
            // request with the updated conversation including the tool result.
            break streamLoop
          }
        }
        if (chunk.done) {
          break streamLoop
        }
      }

      if (textRepetitionDetected) {
        if (!textLoopNudgeIssued) {
          textLoopNudgeIssued = true
          if (emittedIdx > 0) {
            baseMessages.push({ role: 'assistant', content: buffer.slice(0, emittedIdx) })
          }
          baseMessages.push({
            role: 'user',
            content: `=== system_notice ===\nYour response entered a text repetition loop. Stop repeating the same phrases. Reconsider your approach and give a fresh, complete answer.\n=== end ===`
          })
          emit({ type: 'activity', activity: { kind: 'thinking', chars: 0 } })
          continue
        } else {
          emit({ type: 'activity', activity: { kind: 'idle' } })
          emit({
            type: 'error',
            error: 'Aborted: response kept looping with repeated text even after a nudge to change approach.'
          })
          return
        }
      }

      if (!executedAction) {
        // Skill-active fabrication guard: if the model claims a deliverable file
        // exists but no such file is in the workspace, push a verification-failed
        // message and let it retry instead of ending the turn on a lie.
        if (
          !verificationNudgeIssued &&
          isSkillActiveForConversation(req.conversationId) &&
          buffer.trim().length > 0
        ) {
          const missing = await findFabricatedFileClaims(buffer, req.conversationId)
          if (missing.length > 0) {
            if (emittedIdx < buffer.length) {
              emit({ type: 'token', text: buffer.slice(emittedIdx) })
            }
            baseMessages.push({ role: 'assistant', content: buffer })
            baseMessages.push({
              role: 'user',
              content:
                `VERIFICATION FAILED: You claimed the following file(s) exist or were produced, ` +
                `but the filesystem shows they do not exist:\n` +
                missing.map((p) => `  - ${p}`).join('\n') +
                `\n\nYou did not emit any actions this turn that would create these files. ` +
                `Do not fabricate progress. Either emit the actual @@run_bash or @@write_file ` +
                `action now to produce them, or state plainly what is blocking you (missing ` +
                `dependency, ambiguous step, etc.). Do not repeat the success claim.`
            })
            verificationNudgeIssued = true
            emit({ type: 'activity', activity: { kind: 'thinking', chars: 0 } })
            continue
          }
        }

        // In Build mode, if the model just described a plan without writing code,
        // nudge it to start coding immediately instead of ending the turn.
        if (
          req.mode === 'code' &&
          round === 0 &&
          buffer.trim().length > 0 &&
          hasExplicitBuildIntent(req)
        ) {
          // Flush the plan text to the UI
          if (emittedIdx < buffer.length) {
            emit({ type: 'token', text: buffer.slice(emittedIdx) })
          }
          baseMessages.push({ role: 'assistant', content: buffer })
          baseMessages.push({
            role: 'user',
            content:
              'Good plan. Now start building — emit a write_file action with the first file immediately.'
          })
          emit({ type: 'activity', activity: { kind: 'thinking', chars: 0 } })
          continue // go to round 1
        }
        emit({ type: 'activity', activity: { kind: 'idle' } })
        emit({ type: 'done' })
        return
      }
    }
    emit({ type: 'activity', activity: { kind: 'idle' } })
    emit({
      type: 'error',
      error: `Reached max tool rounds (${maxRounds}). Ask the model to finish up and try again.`
    })
  } catch (e) {
    emit({ type: 'activity', activity: { kind: 'idle' } })
    if ((e as Error).name === 'AbortError') {
      emit({ type: 'done' })
    } else {
      emit({ type: 'error', error: (e as Error).message })
    }
  } finally {
    clearConversationPermissions(req.conversationId)
    chatAbortControllers.delete(req.conversationId)
  }
}

const chatAbortControllers = new Map<string, AbortController>()

interface ConversationSkillState {
  index: SkillIndex
  loadedSkills: LoadedSkillsRegistry
  turnCount: number
  /** workspacePath used in the last successful scan; undefined means re-scan is needed */
  scannedWorkspacePath: string | undefined
}
const conversationSkillStates = new Map<string, ConversationSkillState>()

function buildSkillScopes(
  workspacePath: string | undefined,
  homeDir: string,
  userDataDir: string,
  builtinRoot: string
): ScopeEntry[] {
  const scopes: ScopeEntry[] = []
  if (workspacePath) {
    scopes.push({
      scope: 'project',
      root: join(workspacePath, '.agents', 'skills'),
      cacheRoot: join(workspacePath, '.agents', 'cache')
    })
  }
  scopes.push({
    scope: 'global',
    root: join(homeDir, '.agents', 'skills'),
    cacheRoot: join(homeDir, '.agents', 'cache')
  })
  scopes.push({
    scope: 'builtin',
    root: builtinRoot,
    cacheRoot: join(userDataDir, '.agents', 'cache', 'builtin')
  })
  return scopes
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.ammaar.gemmachat')
  nativeTheme.themeSource = 'dark'

  // Set dock icon (macOS) — ensures the Gemma icon shows in dev mode
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await startWorkspaceServer()

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'mediaKeySystem') {
      callback(true)
      return
    }
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  ipcMain.handle('setup:start', async (_e, model: string) => {
    await handleSetup(model)
  })

  ipcMain.handle('chat-state:load', async (): Promise<ChatState> => {
    return loadChatStateFromDisk(app.getPath('userData'))
  })

  ipcMain.handle('chat-state:save', async (_e, state: unknown): Promise<void> => {
    const normalized = normalizeChatState(state)
    await saveChatStateToDisk(app.getPath('userData'), normalized)
  })

  ipcMain.handle(
    'chat-state:migrate-from-legacy',
    async (_e, legacy: unknown): Promise<{ migrated: boolean; conversationCount: number }> => {
      const userDataDir = app.getPath('userData')
      const existing = await loadChatStateFromDisk(userDataDir)
      if (existing.conversations.length > 0 || existing.projects.length > 0) {
        // Migration already happened; don't overwrite.
        return { migrated: false, conversationCount: existing.conversations.length }
      }
      const normalized = normalizeChatState(legacy)
      await saveChatStateToDisk(userDataDir, normalized)
      return { migrated: true, conversationCount: normalized.conversations.length }
    }
  )

  ipcMain.handle('model:switch', async (_e, model: string) => {
    const label = AVAILABLE_MODELS.find((m) => m.name === model)?.label ?? model
    send('setup:status', {
      stage: 'downloading-model',
      message: `Switching to ${label}…`
    })
    try {
      await stopServer()
      if (!mlxPython) {
        throw new Error('MLX Python path not available. Please restart the app.')
      }
      await startServer(mlxPython, model, (p) => {
        send('setup:status', {
          stage: 'downloading-model',
          message: p.message,
          progress: p.progress
        })
      })
      send('setup:status', { stage: 'ready', message: 'Ready to chat.' })
    } catch (e) {
      send('setup:status', {
        stage: 'error',
        message: 'Model switch failed',
        error: (e as Error).message
      })
    }
  })

  ipcMain.handle('setup:status', async () => {
    const mlx = locateMLX()
    return { hasMLX: !!(mlx && mlx.installed) }
  })

  ipcMain.handle('models:list-local', async () => {
    return listLocalModels()
  })

  ipcMain.handle('project:select-folder', async () => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use as Project'
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('chat:send', async (_e, req: ChatRequest) => {
    const channel = `chat:stream:${req.conversationId}`
    handleChat(req, channel).catch((err) => console.error('chat handler error', err))
    return { channel }
  })

  ipcMain.handle('chat:abort', async (_e, conversationId: string) => {
    const c = chatAbortControllers.get(conversationId)
    if (c) c.abort()
  })

  ipcMain.handle('tools:list', async () => {
    return Object.values(TOOLS).map((t) => ({
      name: t.name,
      description: t.description,
      mode: t.mode
    }))
  })

  ipcMain.handle(SETTINGS_CHANNELS.GET_TOOL_LIST, async (): Promise<ToolInfo[]> => {
    return Object.values(TOOLS).map((t) => ({ name: t.name, description: t.description }))
  })

  ipcMain.handle(SETTINGS_CHANNELS.GET_WORKSPACE_ROOT, async (): Promise<string> => {
    return workspacesRoot()
  })

  ipcMain.handle(
    SETTINGS_CHANNELS.GET_PERMISSIONS,
    async (): Promise<Record<string, ToolPermissionValue>> => {
      return loadToolPermissionPolicy() as Promise<Record<string, ToolPermissionValue>>
    }
  )

  ipcMain.handle(
    SETTINGS_CHANNELS.SET_PERMISSION,
    async (_e, { tool, value }: { tool: string; value: ToolPermissionValue }): Promise<void> => {
      await saveToolPermission(tool, value)
    }
  )

  ipcMain.handle(
    SETTINGS_CHANNELS.GET_SYSTEM_PROMPT,
    async (
      _e,
      {
        mode,
        projectPath,
        conversationId,
        enableTools
      }: { mode: string; projectPath?: string; conversationId?: string; enableTools?: boolean }
    ): Promise<string> => {
      const chatLang = await loadChatLanguage()
      const basePrompt =
        mode === 'code'
          ? codeSystemPrompt(
              projectPath ?? workspacesRoot(),
              conversationId ? previewUrl(conversationId) : '',
              chatLang
            )
          : chatSystemPrompt(enableTools ?? true, chatLang)

      let skillCatalog = ''
      try {
        const homeDir = app.getPath('home')
        const userDataDir = app.getPath('userData')
        const builtinRoot = is.dev
          ? join(app.getAppPath(), 'resources', 'skills')
          : join(process.resourcesPath, 'skills')
        const scopes = buildSkillScopes(projectPath, homeDir, userDataDir, builtinRoot)
        const artifactRoot = projectPath ?? userDataDir
        console.log('[settings preview] projectPath:', projectPath, 'scopes:', scopes.map((s) => `${s.scope}:${s.root}`))
        const lock = await scanAllSkills(scopes)
        const { index } = await writeSkillArtifacts(artifactRoot, lock)
        const invocableCount = index.skills.filter((s) => s.modelInvocable).length
        console.log('[settings preview] skills found:', index.skills.length, 'modelInvocable:', invocableCount)
        if (invocableCount > 0) {
          skillCatalog = buildSkillCatalogFromIndex(index)
        }
      } catch (err) {
        console.log('[settings preview] scan failed:', err)
      }

      return skillCatalog ? `${basePrompt}\n\n${skillCatalog}` : basePrompt
    }
  )

  ipcMain.handle(SETTINGS_CHANNELS.GET_CHAT_LANGUAGE, async (): Promise<string> => {
    return loadChatLanguage()
  })

  ipcMain.handle(
    SETTINGS_CHANNELS.SET_CHAT_LANGUAGE,
    async (_e, { lang }: { lang: string }): Promise<void> => {
      await saveChatLanguage(lang)
    }
  )

  ipcMain.handle('tool-permission:respond', async (_e, response: ToolPermissionResponse) => {
    return { ok: resolveToolPermission(response) }
  })

  ipcMain.handle(
    'workspace:info',
    async (_e, req: { conversationId: string; workspacePath?: string }) => {
      registerConversationWorkspace(req.conversationId, req.workspacePath)
      await ensureWorkspace(req.conversationId)
      return {
        conversationId: req.conversationId,
        path: workspaceDir(req.conversationId),
        previewUrl: previewUrl(req.conversationId)
      }
    }
  )

  ipcMain.handle(
    'workspace:list',
    async (_e, req: { conversationId: string; workspacePath?: string }) => {
      registerConversationWorkspace(req.conversationId, req.workspacePath)
      const base = await ensureWorkspace(req.conversationId)
      return listTree(base, 300)
    }
  )

  ipcMain.handle(
    'workspace:open-external',
    async (_e, req: { conversationId: string; workspacePath?: string }) => {
      registerConversationWorkspace(req.conversationId, req.workspacePath)
      await ensureWorkspace(req.conversationId)
      shell.openPath(workspaceDir(req.conversationId))
    }
  )

  ipcMain.handle('workspace:server-port', async () => getWorkspaceServerPort())

  ipcMain.handle(
    'audio:transcribe',
    async (_e, { base64: _base64, model: _model }: { base64: string; model: string }) => {
      // Audio transcription via MLX is not yet supported
      // Return empty text so the UI doesn't break
      return { text: '' }
    }
  )

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // On macOS, keep the app alive in the dock so reopening is instant and the
  // MLX subprocess + workspace server stay warm. Only non-darwin platforms
  // quit on last-window-close.
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  void stopServer()
  stopWorkspaceServer()
})
