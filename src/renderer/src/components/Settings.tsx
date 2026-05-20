import { useEffect, useState } from 'react'
import type {
  ChatMessage,
  Conversation,
  ToolInfo,
  ToolPermissionValue
} from '@shared/types'

type SettingsTab = 'general' | 'permissions'

interface Props {
  onBack: () => void
}

export default function Settings({ onBack }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  return (
    <div className="flex h-full w-full bg-[#0e0e0e] text-white">
      {/* Left sidebar */}
      <div className="flex w-52 shrink-0 flex-col border-r border-white/[0.06] bg-black/20">
        <div className="h-11 shrink-0" />
        <div className="px-3 pb-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-ink-400 transition hover:bg-white/10 hover:text-white"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
            Back
          </button>
        </div>
        <div className="px-2 pb-2 text-[10px] font-medium uppercase tracking-wider text-ink-400 px-3">
          Settings
        </div>
        <nav className="no-drag flex-1 px-2">
          <SidebarItem
            label="General"
            active={activeTab === 'general'}
            onClick={() => setActiveTab('general')}
          />
          <SidebarItem
            label="Permissions"
            active={activeTab === 'permissions'}
            onClick={() => setActiveTab('permissions')}
          />
        </nav>
      </div>

      {/* Right content */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="h-11 shrink-0" />
        <div className="px-8 py-4">
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'permissions' && <PermissionsTab />}
        </div>
      </div>
    </div>
  )
}

function SidebarItem({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-lg px-3 py-2 text-left text-[13px] transition-all duration-150 ${
        active ? 'bg-white/[0.07] text-white' : 'text-ink-200 hover:bg-white/[0.04]'
      }`}
    >
      {label}
    </button>
  )
}

function PermissionsTab() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [permissions, setPermissions] = useState<Record<string, ToolPermissionValue>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    Promise.all([window.api.settingsGetToolList(), window.api.settingsGetPermissions()])
      .then(([toolList, perms]) => {
        setTools(toolList)
        setPermissions(perms)
        setLoading(false)
      })
      .catch(() => {
        setError(true)
        setLoading(false)
      })
  }, [])

  async function handleChange(tool: string, newValue: ToolPermissionValue) {
    const prev = permissions[tool]
    setPermissions((p) => ({ ...p, [tool]: newValue }))
    try {
      await window.api.settingsSetPermission(tool, newValue)
    } catch {
      setPermissions((p) => ({ ...p, [tool]: prev }))
    }
  }

  if (loading) {
    return (
      <div className="max-w-lg space-y-6">
        <h2 className="text-[15px] font-semibold text-white">Permissions</h2>
        <div className="text-[12.5px] text-ink-400">…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-lg space-y-6">
        <h2 className="text-[15px] font-semibold text-white">Permissions</h2>
        <div className="text-[12.5px] text-red-400/80">Unable to load permissions</div>
      </div>
    )
  }

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-[15px] font-semibold text-white">Permissions</h2>
      <div className="space-y-1">
        {tools.map((tool) => (
          <div
            key={tool.name}
            className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5"
          >
            <div className="min-w-0 flex-1 pr-4">
              <div className="text-[13px] font-medium text-white">{tool.name}</div>
              <div className="mt-0.5 text-[11px] text-ink-400">{tool.description}</div>
            </div>
            <select
              value={permissions[tool.name] ?? 'ask'}
              onChange={(e) => handleChange(tool.name, e.target.value as ToolPermissionValue)}
              className="shrink-0 cursor-pointer rounded-md border border-white/[0.08] bg-white/[0.06] px-2 py-1 text-[12px] text-ink-100 focus:outline-none focus:ring-1 focus:ring-white/20"
            >
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}

const ACTIVE_ID_KEY = 'gabie:active-id'

function formatContext(systemPrompt: string, messages: ChatMessage[]): string {
  const parts: string[] = []
  parts.push('[system]:')
  parts.push(systemPrompt)
  for (const m of messages) {
    parts.push('')
    parts.push(`[${m.role}]:`)
    parts.push(m.content)
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.result != null) {
          parts.push('')
          parts.push(`[tool_result: ${tc.name}]:`)
          parts.push(tc.result)
        }
      }
    }
  }
  return parts.join('\n')
}

function GeneralTab() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [contextText, setContextText] = useState<string | null>(null)
  const [contextError, setContextError] = useState(false)
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [conversationLoaded, setConversationLoaded] = useState(false)
  const [chatLanguage, setChatLanguage] = useState<string>('en')

  useEffect(() => {
    window.api.settingsGetChatLanguage().then(setChatLanguage).catch(() => {})
  }, [])

  async function handleChatLanguageChange(lang: string): Promise<void> {
    const prev = chatLanguage
    setChatLanguage(lang)
    try {
      await window.api.settingsSetChatLanguage(lang)
    } catch {
      setChatLanguage(prev)
    }
  }

  useEffect(() => {
    window.api.settingsGetWorkspaceRoot()
      .then((path) => setWorkspaceRoot(path))
      .catch(() => setError(true))
  }, [])

  // Source of truth for ChatState is <userData>/chat-state.json since
  // issue 000022; we fetch via IPC instead of reading localStorage.
  // ACTIVE_ID_KEY (just the active conversation id string) still lives
  // in localStorage and is fine to read synchronously.
  useEffect(() => {
    let cancelled = false
    window.api
      .loadChatState()
      .then((state) => {
        if (cancelled) return
        const activeId = localStorage.getItem(ACTIVE_ID_KEY)
        const conv =
          (activeId ? state.conversations.find((c) => c.id === activeId) : undefined) ??
          state.conversations[0] ??
          null
        setConversation(conv)
        setConversationLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setConversationLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!conversationLoaded) return
    if (!conversation) {
      setContextText('')
      return
    }
    window.api
      .settingsGetSystemPrompt(conversation.mode, conversation.projectPath, conversation.id, true)
      .then((sysPrompt) => {
        setContextText(formatContext(sysPrompt, conversation.messages))
      })
      .catch(() => setContextError(true))
  }, [conversation, conversationLoaded])

  const msgCount = conversation?.messages.length ?? 0

  return (
    <div className="max-w-2xl space-y-8">
      <h2 className="text-[15px] font-semibold text-white">General</h2>

      <div className="space-y-1.5">
        <label className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
          Chat Language
        </label>
        <select
          value={chatLanguage}
          onChange={(e) => handleChatLanguageChange(e.target.value)}
          className="w-48 cursor-pointer rounded-lg border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-[13px] text-ink-100 focus:outline-none focus:ring-1 focus:ring-white/20"
        >
          <option value="en">English</option>
          <option value="zh-TW">繁體中文</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
        </select>
        <p className="text-[11px] text-ink-400">
          Sets the language the model uses for all responses.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
          Workspace Root Folder
        </label>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5">
          {error ? (
            <span className="text-[12.5px] text-red-400/80">Unable to load path</span>
          ) : workspaceRoot === null ? (
            <span className="text-[12.5px] text-ink-400">…</span>
          ) : (
            <span className="break-all font-mono text-[12px] text-ink-100">{workspaceRoot}</span>
          )}
        </div>
        <p className="text-[11px] text-ink-400">
          Read-only. Generated projects are stored here.
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <label className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Context
          </label>
          {msgCount > 0 && (
            <span className="text-[10px] text-ink-500">{msgCount} messages</span>
          )}
        </div>
        <div className="overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.03]">
          {contextError ? (
            <p className="px-3 py-2.5 text-[12.5px] text-red-400/80">Unable to load context</p>
          ) : contextText === null ? (
            <p className="px-3 py-2.5 text-[12.5px] text-ink-400">…</p>
          ) : contextText === '' ? (
            <p className="px-3 py-2.5 text-[12.5px] text-ink-400">No active conversation</p>
          ) : (
            <textarea
              readOnly
              value={contextText}
              className="h-80 w-full resize-none bg-transparent px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink-200 outline-none"
            />
          )}
        </div>
        <p className="text-[11px] text-ink-400">
          Full content sent to the LLM on each turn — system prompt + conversation history.
        </p>
      </div>
    </div>
  )
}
