import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AVAILABLE_MODELS,
  type AgentMode,
  type ChatMessage,
  type ChatState,
  type Conversation,
  type ProjectRecord,
  type ToolPermissionResponseDecision,
  type ToolCall,
  type StreamChunk
} from '@shared/types'
import gemmaLogoUrl from '../assets/gabie-smile.png'
import Composer from './Composer'
import Message, { PermissionBanner, parseThinking } from './Message'
import { countMatches } from '../lib/highlight'
import Sidebar from './Sidebar'
import Canvas from './Canvas'

interface Props {
  model: string
  onSwitchModel: (model: string) => void
  onOpenSettings?: () => void
}

// Legacy localStorage key from the pre-fs era. We try to migrate from it on
// first run and keep a timestamped backup for one grace cycle.
const LEGACY_STATE_KEY = 'gabie:state:v3'
const ACTIVE_ID_KEY = 'gabie:active-id'

function newConversation(mode: AgentMode = 'code', project?: ProjectRecord): Conversation {
  const now = Date.now()
  return {
    id: newId('c'),
    title: 'New chat',
    messages: [],
    createdAt: now,
    updatedAt: now,
    mode,
    canvasOpen: mode === 'code',
    projectId: project?.id,
    projectPath: project?.path
  }
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function projectNameFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).pop() || path
}

function touchProject(
  projects: ProjectRecord[],
  projectId: string | undefined,
  timestamp: number
): ProjectRecord[] {
  if (!projectId) return projects
  return projects.map((p) =>
    p.id === projectId ? { ...p, lastActivityAt: timestamp } : p
  )
}

interface ChatInnerProps extends Props {
  initialChatState: ChatState
  initialActiveId: string
}

function ChatInner({
  model,
  onSwitchModel,
  onOpenSettings,
  initialChatState,
  initialActiveId
}: ChatInnerProps) {
  const [chatState, setChatState] = useState<ChatState>(initialChatState)
  const { conversations, projects, activeProjectId } = chatState
  const [activeId, setActiveId] = useState<string>(initialActiveId)
  const [streaming, setStreaming] = useState(false)
  const streamRef = useRef<{ abort: boolean }>({ abort: false })
  const [thinking, setThinking] = useState(false)

  const modelInfo = AVAILABLE_MODELS.find((m) => m.name === model)
  const thinkingAlwaysOn = modelInfo?.thinkingSupport === 'always-on'
  const thinkingAvailable = modelInfo?.thinkingSupport !== undefined

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const searchOpenRef = useRef(false)

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId]
  )

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    [projects]
  )

  const visibleConversations = useMemo(
    () =>
      conversations.filter((c) =>
        activeProjectId ? c.projectId === activeProjectId : !c.projectId
      ),
    [conversations, activeProjectId]
  )

  const activeConversation = useMemo(
    () =>
      visibleConversations.find((c) => c.id === activeId) ??
      visibleConversations[0] ??
      conversations[0],
    [conversations, visibleConversations, activeId]
  )

  useEffect(() => {
    searchOpenRef.current = searchOpen
  }, [searchOpen])

  const closeSearch = useCallback((): void => {
    setSearchOpen(false)
    setSearchQuery('')
    setActiveMatchIndex(0)
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        if (searchOpenRef.current) {
          closeSearch()
        } else {
          setSearchOpen(true)
        }
      } else if (e.key === 'Escape') {
        closeSearch()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeSearch])

  // Debounced fs save. Streaming may update chatState many times per second
  // (one re-render per token), so coalesce into a single write every 1s.
  // The window flush on unmount/refresh hook below guarantees no data loss
  // when the user navigates away mid-stream.
  const saveTimerRef = useRef<number | null>(null)
  const pendingStateRef = useRef<ChatState>(chatState)
  useEffect(() => {
    pendingStateRef.current = chatState
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      window.api
        .saveChatState(pendingStateRef.current)
        .catch((e) => console.error('[gabie] saveChatState failed', e))
    }, 1000)
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [chatState])

  useEffect(() => {
    // Best-effort flush on tab/window close so the latest debounced state
    // is persisted even if the user quits before the timer fires.
    const flush = (): void => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      window.api
        .saveChatState(pendingStateRef.current)
        .catch((e) => console.error('[gabie] saveChatState (unload) failed', e))
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onMessageRewrite((ev) => {
      setChatState((state) => ({
        ...state,
        conversations: state.conversations.map((c) => {
          if (c.id !== ev.conversationId) return c
          if (ev.messageIndex < 0 || ev.messageIndex >= c.messages.length) return c
          const messages = c.messages.slice()
          messages[ev.messageIndex] = { ...messages[ev.messageIndex], content: ev.content }
          return { ...c, messages }
        })
      }))
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    localStorage.setItem(ACTIVE_ID_KEY, activeId)
  }, [activeId])

  useEffect(() => {
    const project = activeProject
    const matching = conversations.filter((c) =>
      activeProjectId ? c.projectId === activeProjectId : !c.projectId
    )
    if (matching.length === 0) {
      const c = newConversation(activeConversation?.mode ?? 'code', project)
      setChatState((state) => ({ ...state, conversations: [c, ...state.conversations] }))
      setActiveId(c.id)
      return
    }
    if (!matching.some((c) => c.id === activeId)) {
      setActiveId(matching[0].id)
    }
  }, [activeProject, activeProjectId, activeId, activeConversation?.mode, conversations])

  function updateActive(fn: (c: Conversation) => Conversation): void {
    setChatState((state) => ({
      ...state,
      conversations: state.conversations.map((c) => (c.id === activeId ? fn(c) : c))
    }))
  }

  function createConversation(mode: AgentMode = 'code'): void {
    const c = newConversation(mode, activeProject)
    setChatState((state) => ({
      ...state,
      conversations: [c, ...state.conversations],
      projects: touchProject(state.projects, activeProject?.id, c.createdAt)
    }))
    setActiveId(c.id)
  }

  function deleteConversation(id: string): void {
    setChatState((state) => {
      const filtered = state.conversations.filter((c) => c.id !== id)
      const visible = filtered.filter((c) =>
        state.activeProjectId ? c.projectId === state.activeProjectId : !c.projectId
      )
      if (visible.length === 0) {
        const project = state.projects.find((p) => p.id === state.activeProjectId)
        const nc = newConversation(activeConversation?.mode ?? 'code', project)
        setActiveId(nc.id)
        return { ...state, conversations: [nc, ...filtered] }
      }
      if (id === activeId) setActiveId(visible[0].id)
      return { ...state, conversations: filtered }
    })
  }

  async function addProject(): Promise<void> {
    const path = await window.api.selectProjectFolder()
    if (!path) return
    const existing = projects.find((p) => p.path === path)
    if (existing) {
      selectProject(existing.id)
      return
    }
    const now = Date.now()
    const project: ProjectRecord = {
      id: newId('p'),
      path,
      name: projectNameFromPath(path),
      createdAt: now,
      lastActivityAt: now
    }
    const c = newConversation(activeConversation?.mode ?? 'code', project)
    setChatState((state) => ({
      conversations: [c, ...state.conversations],
      projects: [project, ...state.projects],
      activeProjectId: project.id
    }))
    setActiveId(c.id)
  }

  function selectProject(projectId: string | null): void {
    setChatState((state) => ({ ...state, activeProjectId: projectId }))
  }

  function deleteProject(projectId: string): void {
    setChatState((state) => {
      const projects = state.projects.filter((p) => p.id !== projectId)
      const conversations = state.conversations.filter((c) => c.projectId !== projectId)
      const nextProjectId =
        state.activeProjectId === projectId
          ? [...projects].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]?.id ?? null
          : state.activeProjectId
      const nextConversations =
        projects.length === 0 && !conversations.some((c) => !c.projectId)
          ? [newConversation(), ...conversations]
          : conversations
      setActiveId(nextConversations[0]?.id ?? '')
      return {
        conversations: nextConversations,
        projects,
        activeProjectId: nextProjectId
      }
    })
  }

  function toggleMode(): void {
    updateActive((c) => {
      const nextMode: AgentMode = c.mode === 'code' ? 'chat' : 'code'
      return { ...c, mode: nextMode, canvasOpen: nextMode === 'code' }
    })
  }

  function toggleCanvas(): void {
    updateActive((c) => ({ ...c, canvasOpen: !c.canvasOpen }))
  }

  async function handleSend(input: string): Promise<void> {
    if (!input.trim() || streaming || !activeConversation) return

    const conv = conversations.find((c) => c.id === activeId) ?? activeConversation
    const now = Date.now()

    const userMsg: ChatMessage = {
      id: newId('m'),
      role: 'user',
      content: input,
      createdAt: now
    }
    const assistantMsg: ChatMessage = {
      id: newId('m'),
      role: 'assistant',
      content: '',
      createdAt: now,
      model,
      toolCalls: [],
      activity: { kind: 'thinking' }
    }

    setChatState((state) => {
      const conversations = state.conversations.map((c) => {
        if (c.id !== activeId) return c
        const title =
          c.messages.length === 0
            ? input.slice(0, 48) + (input.length > 48 ? '…' : '')
            : c.title
        return {
          ...c,
          title,
          updatedAt: now,
          messages: [...c.messages, userMsg, assistantMsg]
        }
      })
      return {
        ...state,
        conversations,
        projects: touchProject(state.projects, conv.projectId, now)
      }
    })

    const history = [...conv.messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls
    }))

    setStreaming(true)
    streamRef.current.abort = false

    try {
      await window.api.sendChat(
        {
          conversationId: activeId,
          messages: history,
          model,
          enableTools: true,
          mode: conv.mode,
          workspacePath: conv.projectPath,
          enableThinking: thinkingAlwaysOn || thinking
        },
        (chunk: StreamChunk) => {
          if (streamRef.current.abort) return
          setChatState((state) => ({
            ...state,
            conversations: state.conversations.map((c) => {
              if (c.id !== activeId) return c
              const msgs = [...c.messages]
              const last = msgs[msgs.length - 1]
              if (!last || last.role !== 'assistant') return c
              if (chunk.type === 'token') {
                msgs[msgs.length - 1] = { ...last, content: last.content + chunk.text }
              } else if (chunk.type === 'tool_call') {
                const tc: ToolCall = { ...chunk.call, running: true }
                msgs[msgs.length - 1] = {
                  ...last,
                  toolCalls: [...(last.toolCalls ?? []), tc]
                }
              } else if (chunk.type === 'tool_result') {
                const tcs = (last.toolCalls ?? []).map((t) =>
                  t.id === chunk.id
                    ? { ...t, running: false, result: chunk.result, error: chunk.error }
                    : t
                )
                msgs[msgs.length - 1] = { ...last, toolCalls: tcs }
              } else if (chunk.type === 'tool_permission') {
                const tcs = (last.toolCalls ?? []).map((t) =>
                  t.id === chunk.request.toolCallId
                    ? {
                        ...t,
                        permission: {
                          mode: 'ask' as const,
                          requestId: chunk.request.id,
                          status: 'pending' as const,
                          reason: chunk.request.reason
                        }
                      }
                    : t
                )
                msgs[msgs.length - 1] = { ...last, toolCalls: tcs }
              } else if (chunk.type === 'activity') {
                msgs[msgs.length - 1] = { ...last, activity: chunk.activity }
              } else if (chunk.type === 'done') {
                msgs[msgs.length - 1] = { ...last, done: true, activity: { kind: 'idle' } }
              } else if (chunk.type === 'error') {
                msgs[msgs.length - 1] = {
                  ...last,
                  done: true,
                  activity: { kind: 'idle' },
                  content:
                    last.content + (last.content ? '\n\n' : '') + `⚠️ ${chunk.error}`
                }
              }
              return { ...c, messages: msgs }
            })
          }))
        }
      )
    } finally {
      setStreaming(false)
    }
  }

  async function handleStop(): Promise<void> {
    streamRef.current.abort = true
    await window.api.abortChat(activeId)
    setStreaming(false)
  }

  async function handleToolPermission(
    requestId: string,
    decision: ToolPermissionResponseDecision
  ): Promise<void> {
    setChatState((state) => ({
      ...state,
      conversations: state.conversations.map((c) => ({
        ...c,
        messages: c.messages.map((m) => ({
          ...m,
          toolCalls: m.toolCalls?.map((t) =>
            t.permission?.requestId === requestId
              ? {
                  ...t,
                  permission: {
                    ...t.permission,
                    status: decision === 'allow' ? 'approved' : 'denied'
                  }
                }
              : t
          )
        }))
      }))
    }))
    await window.api.respondToToolPermission({ requestId, decision })
  }

  async function handleRegenerate(): Promise<void> {
    if (streaming) return
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv) return
    const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    updateActive((c) => {
      const msgs = [...c.messages]
      while (msgs.length && msgs[msgs.length - 1].role !== 'user') {
        msgs.pop()
      }
      return { ...c, messages: msgs.slice(0, -1) }
    })
    setTimeout(() => handleSend(lastUser.content), 0)
  }

  const canvasVisible =
    (activeConversation.mode === 'code' || activeConversation.canvasOpen === true) &&
    activeConversation.canvasOpen !== false

  const { matchOffsets, totalMatches } = useMemo(() => {
    if (!searchQuery) {
      return { matchOffsets: activeConversation.messages.map(() => 0), totalMatches: 0 }
    }
    const offsets: number[] = []
    let sum = 0
    for (const m of activeConversation.messages) {
      offsets.push(sum)
      sum += countMatches(parseThinking(m.content).visible, searchQuery)
    }
    return { matchOffsets: offsets, totalMatches: sum }
  }, [activeConversation.messages, searchQuery])

  useEffect(() => {
    setActiveMatchIndex(0)
  }, [searchQuery])

  const goNext = useCallback(() => {
    if (totalMatches === 0) return
    setActiveMatchIndex((i) => (i + 1) % totalMatches)
  }, [totalMatches])

  const goPrev = useCallback(() => {
    if (totalMatches === 0) return
    setActiveMatchIndex((i) => (i - 1 + totalMatches) % totalMatches)
  }, [totalMatches])

  useEffect(() => {
    if (!searchQuery || totalMatches === 0) return
    document
      .querySelector(`[data-match-idx="${activeMatchIndex}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeMatchIndex, searchQuery, totalMatches])

  const pendingPermissionCall = useMemo(() => {
    for (const m of activeConversation.messages) {
      for (const tc of m.toolCalls ?? []) {
        if (tc.permission?.status === 'pending' && tc.permission.requestId) return tc
      }
    }
    return null
  }, [activeConversation.messages])

  return (
    <div className="flex h-full w-full">
      <Sidebar
        projects={sortedProjects}
        activeProjectId={activeProjectId}
        conversations={visibleConversations}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => createConversation(activeConversation.mode)}
        onDelete={deleteConversation}
        onAddProject={addProject}
        onSelectProject={selectProject}
        onDeleteProject={deleteProject}
        onOpenSettings={onOpenSettings}
      />
      <div className="flex min-w-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <Header
            model={model}
            mode={activeConversation.mode}
            canvasOpen={!!activeConversation.canvasOpen}
            onToggleMode={toggleMode}
            onToggleCanvas={toggleCanvas}
            onSwitchModel={onSwitchModel}
          />
          {searchOpen && (
            <SearchBar
              query={searchQuery}
              onChange={setSearchQuery}
              onClose={closeSearch}
              totalMatches={totalMatches}
              activeMatchIndex={activeMatchIndex}
              onNext={goNext}
              onPrev={goPrev}
            />
          )}
          <MessageList
            messages={activeConversation.messages}
            streaming={streaming}
            mode={activeConversation.mode}
            onRegenerate={handleRegenerate}
            searchQuery={searchQuery}
            matchOffsets={matchOffsets}
            activeMatchIndex={activeMatchIndex}
          />
          {pendingPermissionCall && (
            <PermissionBanner call={pendingPermissionCall} onPermission={handleToolPermission} />
          )}
          <Composer
            onSend={handleSend}
            onStop={handleStop}
            streaming={streaming}
            disabled={false}
            model={model}
            placeholder={
              activeConversation.mode === 'code'
                ? 'Describe what to build — a webpage, component, or script…'
                : 'Message Gemma…'
            }
            thinking={thinking}
            onThinkingChange={setThinking}
            thinkingAlwaysOn={thinkingAlwaysOn}
            thinkingAvailable={thinkingAvailable}
          />
        </div>
        {canvasVisible && (
          <ResizableCanvas
            conversationId={activeId}
            workspacePath={activeConversation.projectPath}
            streaming={streaming}
            onClose={() => updateActive((c) => ({ ...c, canvasOpen: false }))}
          />
        )}
      </div>
    </div>
  )
}

export default function Chat(props: Props) {
  const [bootstrap, setBootstrap] = useState<{
    chatState: ChatState
    activeId: string
  } | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        let state = await window.api.loadChatState()
        // First-run / fresh-install migration from legacy localStorage.
        // We only migrate when fs is empty so re-running the app doesn't
        // clobber fs state with a stale backup.
        if (state.conversations.length === 0 && state.projects.length === 0) {
          const legacyRaw = localStorage.getItem(LEGACY_STATE_KEY)
          if (legacyRaw) {
            try {
              const legacy = JSON.parse(legacyRaw)
              const result = await window.api.migrateChatStateFromLegacy(legacy)
              if (result.migrated) {
                console.log(
                  `[gabie] migrated ${result.conversationCount} conversation(s) from localStorage to userData fs`
                )
                // Keep a timestamped backup so a worried user can restore
                // manually; remove the live key so we don't re-migrate.
                localStorage.setItem(
                  `${LEGACY_STATE_KEY}-backup-${Date.now()}`,
                  legacyRaw
                )
                localStorage.removeItem(LEGACY_STATE_KEY)
                state = await window.api.loadChatState()
              }
            } catch (e) {
              console.warn(
                '[gabie] failed to migrate legacy localStorage; leaving original key untouched',
                e
              )
            }
          }
        }
        if (cancelled) return
        // Ensure at least one conversation exists for new installs.
        const conversations = state.conversations.length
          ? state.conversations
          : [newConversation()]
        const stored = localStorage.getItem(ACTIVE_ID_KEY)
        const activeId =
          stored && conversations.some((c) => c.id === stored)
            ? stored
            : conversations[0].id
        setBootstrap({ chatState: { ...state, conversations }, activeId })
      } catch (e) {
        if (cancelled) return
        console.error('[gabie] failed to load chat state', e)
        setBootError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-ink-300">
        <div>
          <div className="mb-2 text-[14px] font-semibold text-white">
            Could not load conversations
          </div>
          <div className="text-[12.5px] text-ink-400">{bootError}</div>
        </div>
      </div>
    )
  }

  if (!bootstrap) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-ink-400">
        Loading conversations…
      </div>
    )
  }

  return (
    <ChatInner
      {...props}
      initialChatState={bootstrap.chatState}
      initialActiveId={bootstrap.activeId}
    />
  )
}

function ResizableCanvas({
  conversationId,
  workspacePath,
  streaming,
  onClose
}: {
  conversationId: string
  workspacePath?: string
  streaming: boolean
  onClose: () => void
}) {
  const [width, setWidth] = useState(520)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startW.current = width
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [width])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const delta = startX.current - e.clientX
    const next = Math.max(320, Math.min(startW.current + delta, 900))
    setWidth(next)
  }, [])

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  return (
    <div
      className="anim-slide-right relative shrink-0"
      style={{ width }}
    >
      {/* Drag handle */}
      <div
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize select-none transition-colors hover:bg-white/10 active:bg-white/20"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ touchAction: 'none' }}
      />
      <Canvas
        conversationId={conversationId}
        workspacePath={workspacePath}
        streaming={streaming}
        onClose={onClose}
      />
    </div>
  )
}

function Header({
  model,
  mode,
  canvasOpen,
  onToggleMode,
  onToggleCanvas,
  onSwitchModel
}: {
  model: string
  mode: AgentMode
  canvasOpen: boolean
  onToggleMode: () => void
  onToggleCanvas: () => void
  onSwitchModel: (model: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!pickerOpen) return
    function handleClick(e: MouseEvent): void {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [pickerOpen])

  const currentLabel = AVAILABLE_MODELS.find((m) => m.name === model)?.label ?? model

  return (
    <div className="drag flex h-11 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
      <div className="min-w-[8rem]" />
      <div className="no-drag flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5 text-[12px]">
        <ModePill active={mode === 'chat'} onClick={() => mode === 'code' && onToggleMode()}>
          Chat
        </ModePill>
        <ModePill active={mode === 'code'} onClick={() => mode === 'chat' && onToggleMode()}>
          Build
        </ModePill>
      </div>
      <div className="no-drag flex shrink-0 items-center justify-end gap-2">
        <div className="relative" ref={pickerRef}>
          <button
            onClick={() => setPickerOpen((o) => !o)}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[11.5px] text-ink-400 transition-all duration-200 hover:bg-white/[0.05] hover:text-ink-100"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {currentLabel}
            <svg viewBox="0 0 16 16" className={`h-3 w-3 transition-transform duration-200 ${pickerOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {pickerOpen && (
            <div className="anim-fade-scale absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-white/10 bg-[#1a1a1a] p-1.5 shadow-2xl backdrop-blur-xl">
              <div className="mb-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-ink-400">
                Switch model
              </div>
              {AVAILABLE_MODELS.map((m) => (
                <button
                  key={m.name}
                  onClick={() => {
                    setPickerOpen(false)
                    if (m.name !== model) onSwitchModel(m.name)
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-all duration-150 ${
                    m.name === model
                      ? 'bg-white/[0.07] text-white'
                      : 'text-ink-200 hover:bg-white/[0.04]'
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                      {m.label}
                      {m.recommended && (
                        <span className="rounded-full bg-white/10 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider text-ink-200">
                          rec
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-400">{m.size}</div>
                  </div>
                  {m.name === model && (
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        {mode === 'code' && (
          <button
            onClick={onToggleCanvas}
            title={canvasOpen ? 'Hide canvas' : 'Show canvas'}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition ${
              canvasOpen ? 'bg-white/10 text-white' : 'text-ink-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <path d="M9 3v10" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

function ModePill({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1 font-medium transition-all duration-200 ease-out ${
        active ? 'bg-white/10 text-white shadow-sm scale-[1.02]' : 'text-ink-400 hover:text-ink-100 scale-100'
      }`}
    >
      {children}
    </button>
  )
}

function MessageList({
  messages,
  streaming,
  mode,
  onRegenerate,
  searchQuery,
  matchOffsets,
  activeMatchIndex
}: {
  messages: ChatMessage[]
  streaming: boolean
  mode: AgentMode
  onRegenerate: () => void
  searchQuery?: string
  matchOffsets?: number[]
  activeMatchIndex?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (atBottomRef.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [messages])

  const empty = messages.length === 0

  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">
      {empty ? (
        <EmptyState mode={mode} />
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
          {messages.map((m, i) => (
            <div key={m.id} className="anim-float-in" style={{ animationDelay: `${Math.min(i * 30, 150)}ms` }}>
              <Message
                message={m}
                isLast={i === messages.length - 1}
                streaming={streaming && i === messages.length - 1}
                searchQuery={searchQuery}
                matchOffset={matchOffsets?.[i]}
                activeMatchIndex={activeMatchIndex}
                onRegenerate={
                  !streaming && m.role === 'assistant' && i === messages.length - 1
                    ? onRegenerate
                    : undefined
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState({ mode }: { mode: AgentMode }) {
  const chatSuggestions = [
    { title: 'Search the web', prompt: 'What are the top AI news stories this week?' },
    { title: 'Explain a concept', prompt: 'Explain the transformer architecture in plain English.' },
    { title: 'Plan a trip', prompt: 'Help me plan a weekend trip to Tokyo for 4 days.' },
    { title: 'Debug code', prompt: 'Why is this JS promise not resolving? (paste code)' }
  ]
  const codeSuggestions = [
    {
      title: 'Landing page',
      prompt: 'Build a one-page landing site for a fake AI dog-walking app. Modern design, dark mode.'
    },
    {
      title: 'Pomodoro timer',
      prompt: 'Build a pomodoro timer web app with start/pause/reset buttons and a minimal UI.'
    },
    {
      title: 'Retro snake game',
      prompt: 'Make a playable snake game in a single index.html with keyboard controls.'
    },
    {
      title: 'Markdown preview',
      prompt: 'Build a live markdown editor — textarea on the left, rendered output on the right.'
    }
  ]
  const suggestions = mode === 'code' ? codeSuggestions : chatSuggestions
  return (
    <div className="anim-fade-in flex h-full flex-col items-center justify-center px-8">
      <div className="anim-fade-up mb-12 text-center">
        <img src={gemmaLogoUrl} alt="Gemma" className="mx-auto mb-6 h-20 w-20" draggable={false} />
        <div className="mb-3 text-[32px] font-semibold tracking-tight text-white">
          {mode === 'code' ? 'What should we build?' : 'How can I help?'}
        </div>
        <div className="text-sm text-ink-400">
          {mode === 'code'
            ? 'Gemma will write files into a workspace and show a live preview on the right.'
            : 'Running locally. Your messages never leave your Mac.'}
        </div>
      </div>
      <div className="anim-stagger grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
        {suggestions.map((s) => (
          <button
            key={s.title}
            onClick={() => {
              const ta = document.querySelector<HTMLTextAreaElement>('[data-composer]')
              if (ta) {
                const setter = Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype,
                  'value'
                )?.set
                setter?.call(ta, s.prompt)
                ta.dispatchEvent(new Event('input', { bubbles: true }))
                ta.focus()
              }
            }}
            className="anim-fade-up rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-left transition hover:border-white/10 hover:bg-white/[0.04] active:scale-[0.98]"
          >
            <div className="text-sm font-medium text-white">{s.title}</div>
            <div className="mt-0.5 text-[12.5px] text-ink-400">{s.prompt}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function SearchBar({
  query,
  onChange,
  onClose,
  totalMatches,
  activeMatchIndex,
  onNext,
  onPrev
}: {
  query: string
  onChange: (q: string) => void
  onClose: () => void
  totalMatches: number
  activeMatchIndex: number
  onNext: () => void
  onPrev: () => void
}) {
  const hasMatches = query.length > 0 && totalMatches > 0
  const counter = !query ? '—' : totalMatches === 0 ? '0' : `${activeMatchIndex + 1} / ${totalMatches}`
  const counterClass = !query
    ? 'min-w-[2.5rem] text-center text-[11px] text-ink-400'
    : totalMatches === 0
      ? 'min-w-[2.5rem] text-center text-[11px] text-red-400/70'
      : 'min-w-[2.5rem] text-center text-[11px] text-ink-300'
  return (
    <div className="absolute right-4 top-11 z-50 flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-ink-950/95 px-3 py-2 shadow-2xl backdrop-blur-sm">
      <input
        autoFocus
        type="text"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.shiftKey ? onPrev() : onNext()
          }
        }}
        placeholder="Search…"
        className="w-44 bg-transparent text-[13px] text-white placeholder-ink-400 outline-none"
      />
      <span className={counterClass}>{counter}</span>
      <button
        disabled={!hasMatches}
        onClick={onPrev}
        className={`flex h-6 w-6 items-center justify-center rounded-md text-ink-400 transition ${hasMatches ? 'hover:bg-white/10 hover:text-white' : 'opacity-30'}`}
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 10l4-4 4 4" />
        </svg>
      </button>
      <button
        disabled={!hasMatches}
        onClick={onNext}
        className={`flex h-6 w-6 items-center justify-center rounded-md text-ink-400 transition ${hasMatches ? 'hover:bg-white/10 hover:text-white' : 'opacity-30'}`}
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <div className="mx-0.5 h-4 w-px bg-white/10" />
      <button
        onClick={onClose}
        className="flex h-6 w-6 items-center justify-center rounded-md text-ink-400 transition hover:bg-white/10 hover:text-white"
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M4 4l8 8M12 4L4 12" />
        </svg>
      </button>
    </div>
  )
}
