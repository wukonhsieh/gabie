import React, { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import type {
  AgentActivity,
  ChatMessage,
  ToolCall,
  ToolPermissionResponseDecision
} from '@shared/types'
import gemmaLogoUrl from '../assets/gabie-smile.png'
import { countMatches, highlightHtml } from '../lib/highlight'
import { parseSkillInjection } from '../lib/skill-injection'

interface Props {
  message: ChatMessage
  isLast: boolean
  streaming: boolean
  onRegenerate?: () => void
  searchQuery?: string
  matchOffset?: number
  activeMatchIndex?: number
}

interface Parsed {
  thinking: string
  thinkingInProgress: boolean
  visible: string
}

export function parseThinking(content: string): Parsed {
  const openRe = /<think(?:ing)?>/
  const closeRe = /<\/think(?:ing)?>/
  const parts: string[] = []
  let remaining = content

  while (true) {
    const openMatch = remaining.match(openRe)
    if (!openMatch) break
    const before = remaining.slice(0, openMatch.index!)
    const afterOpen = remaining.slice(openMatch.index! + openMatch[0].length)
    const closeMatch = afterOpen.match(closeRe)
    if (!closeMatch) {
      // Unclosed block — still streaming
      parts.push(afterOpen)
      return {
        thinking: parts.join('\n\n'),
        thinkingInProgress: true,
        visible: before.trim()
      }
    }
    parts.push(afterOpen.slice(0, closeMatch.index!))
    remaining = before + afterOpen.slice(closeMatch.index! + closeMatch[0].length)
  }

  return {
    thinking: parts.join('\n\n'),
    thinkingInProgress: false,
    visible: remaining.trim()
  }
}

function highlightText(
  text: string,
  query: string,
  matchOffset: number,
  activeMatchIndex?: number
): React.ReactNode {
  if (!query) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  let localIdx = 0
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const globalIdx = matchOffset + localIdx
      localIdx++
      const isActive = activeMatchIndex !== undefined && globalIdx === activeMatchIndex
      return (
        <span
          key={i}
          data-match-idx={globalIdx}
          className={isActive ? 'rounded-[2px] bg-yellow-400/80' : 'rounded-[2px] bg-yellow-400/30'}
        >
          {part}
        </span>
      )
    }
    return part
  })
}

export default function Message({ message, streaming, onRegenerate, searchQuery, matchOffset, activeMatchIndex }: Props) {
  const isUser = message.role === 'user'
  const parsed = useMemo(() => parseThinking(message.content), [message.content])
  const html = useMemo(() => {
    if (!parsed.visible) return ''
    try {
      return marked.parse(parsed.visible, { async: false, breaks: true }) as string
    } catch {
      return escapeHtml(parsed.visible).replace(/\n/g, '<br/>')
    }
  }, [parsed.visible])

  if (isUser) {
    const skillInjection = parseSkillInjection(message.content)
    if (skillInjection) {
      const injectionMatches = searchQuery
        ? countMatches(skillInjection.injectionContent, searchQuery)
        : 0
      const userTextOffset = (matchOffset ?? 0) + injectionMatches
      return (
        <div className="flex justify-end">
          <div className="selectable max-w-[78%] rounded-2xl rounded-br-md bg-white/[0.08] px-4 py-2.5 text-[14.5px] leading-relaxed text-white">
            <SkillInjectionBlock
              skillName={skillInjection.skillName}
              content={skillInjection.injectionContent}
              searchQuery={searchQuery}
              matchOffset={matchOffset ?? 0}
              activeMatchIndex={activeMatchIndex}
            />
            <div className="whitespace-pre-wrap">
              {searchQuery
                ? highlightText(skillInjection.userText, searchQuery, userTextOffset, activeMatchIndex)
                : skillInjection.userText}
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="flex justify-end">
        <div className="selectable max-w-[78%] rounded-2xl rounded-br-md bg-white/[0.08] px-4 py-2.5 text-[14.5px] leading-relaxed text-white">
          <div className="whitespace-pre-wrap">
            {searchQuery
              ? highlightText(message.content, searchQuery, matchOffset ?? 0, activeMatchIndex)
              : message.content}
          </div>
        </div>
      </div>
    )
  }

  const isEmpty = !parsed.visible && !parsed.thinking && !message.toolCalls?.length
  const showCursor = streaming && !message.done
  const showActivity =
    streaming && !message.done && message.activity && message.activity.kind !== 'idle'

  return (
    <div className="group flex gap-3">
      <img src={gemmaLogoUrl} alt="Gemma" className="mt-0.5 h-7 w-7 shrink-0 rounded-full object-cover" />
      <div className="selectable min-w-0 flex-1">
        {parsed.thinking && (
          <ThinkingBlock content={parsed.thinking} inProgress={parsed.thinkingInProgress && !message.done} />
        )}

        {message.toolCalls?.map((tc) => (
          <ToolCallView key={tc.id} call={tc} />
        ))}

        {!isEmpty && (
          <div
            className="markdown-body text-[14.5px] text-ink-100"
            dangerouslySetInnerHTML={{
              __html:
                (searchQuery
                  ? highlightHtml(html, searchQuery, matchOffset ?? 0, activeMatchIndex)
                  : html) +
                (showCursor && parsed.visible ? '<span class="anim-caret">▍</span>' : '')
            }}
          />
        )}

        {showActivity && (
          <ActivityBar
            activity={message.activity!}
            startedAt={message.createdAt}
            toolCalls={message.toolCalls}
          />
        )}

        {isEmpty && showCursor && !showActivity && (
          <div className="dot-flashing text-ink-400">
            <span />
            <span />
            <span />
          </div>
        )}

        {onRegenerate && (
          <div className="mt-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
            <button
              onClick={onRegenerate}
              className="rounded-md px-2 py-1 text-[11px] text-ink-400 hover:bg-white/5 hover:text-white"
            >
              ↻ Regenerate
            </button>
            <button
              onClick={() => navigator.clipboard.writeText(parsed.visible)}
              className="rounded-md px-2 py-1 text-[11px] text-ink-400 hover:bg-white/5 hover:text-white"
            >
              Copy
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const THINKING_VERBS = [
  'Thinking',
  'Considering',
  'Planning',
  'Pondering',
  'Reasoning',
  'Sketching'
]
const GENERATING_VERBS = ['Writing', 'Composing', 'Drafting']

function ActivityBar({
  activity,
  startedAt,
  toolCalls
}: {
  activity: AgentActivity
  startedAt: number
  toolCalls?: ToolCall[]
}) {
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startedAt) / 1000))
  const verbIdxRef = useRef(0)
  const [verbIdx, setVerbIdx] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => window.clearInterval(id)
  }, [startedAt])

  useEffect(() => {
    if (activity.kind === 'thinking' || activity.kind === 'generating') {
      const id = window.setInterval(() => {
        verbIdxRef.current++
        setVerbIdx(verbIdxRef.current)
      }, 3500)
      return () => window.clearInterval(id)
    }
    return undefined
  }, [activity.kind])

  const label = useMemo(() => {
    if (activity.kind === 'thinking') {
      const verbs = THINKING_VERBS
      return verbs[verbIdx % verbs.length]
    }
    if (activity.kind === 'generating') {
      const verbs = GENERATING_VERBS
      return verbs[verbIdx % verbs.length]
    }
    if (activity.kind === 'tool') {
      const verb = toolVerb(activity.tool)
      return activity.target ? `${verb} ${activity.target}` : verb
    }
    return ''
  }, [activity, verbIdx])

  // Hide if there's already a running tool card that conveys the same state
  const hasRunningTool = toolCalls?.some((t) => t.running)
  if (hasRunningTool && activity.kind === 'tool') return null

  const chars = (activity as { chars?: number }).chars
  return (
    <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-400">
      <span className="shimmer-text">{label}…</span>
      <span className="tabular-nums text-ink-400/70">
        {chars != null && chars > 0 ? `${chars.toLocaleString()} chars · ` : ''}
        {formatElapsed(elapsed)}
      </span>
    </div>
  )
}

function toolVerb(name: string): string {
  switch (name) {
    case 'write_file':
      return 'Writing'
    case 'read_file':
      return 'Reading'
    case 'edit_file':
      return 'Editing'
    case 'delete_file':
      return 'Deleting'
    case 'list_files':
      return 'Listing'
    case 'run_bash':
      return 'Running'
    case 'open_preview':
      return 'Revealing preview'
    case 'web_search':
      return 'Searching'
    case 'fetch_url':
      return 'Fetching'
    case 'calc':
      return 'Calculating'
    default:
      return 'Running ' + name
  }
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

function SkillInjectionBlock({
  skillName,
  content,
  searchQuery,
  matchOffset,
  activeMatchIndex
}: {
  skillName: string
  content: string
  searchQuery?: string
  matchOffset: number
  activeMatchIndex?: number
}) {
  const [userOpen, setUserOpen] = useState(false)
  // Auto-expand whenever a search query is active so hits inside the
  // injection are reachable via match-index navigation.
  const open = userOpen || !!searchQuery
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]">
      <button
        onClick={() => setUserOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-ink-300 hover:bg-white/[0.04]"
      >
        <svg
          viewBox="0 0 12 12"
          className={`h-2.5 w-2.5 transition ${open ? 'rotate-90' : ''}`}
          fill="currentColor"
        >
          <path d="M4 2l4 4-4 4V2z" />
        </svg>
        <span className="font-mono text-ink-200">${skillName}</span>
        <span className="text-ink-400">skill procedure loaded</span>
      </button>
      {open && (
        <div className="whitespace-pre-wrap border-t border-white/5 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-300">
          {searchQuery
            ? highlightText(content, searchQuery, matchOffset, activeMatchIndex)
            : content}
        </div>
      )}
    </div>
  )
}

function ThinkingBlock({
  content,
  inProgress
}: {
  content: string
  inProgress: boolean
}) {
  const [open, setOpen] = useState(inProgress)
  const labelClass = inProgress ? 'shimmer-text' : ''
  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-white/5 bg-white/[0.02]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-ink-400 hover:text-ink-100"
      >
        <svg
          viewBox="0 0 12 12"
          className={`h-2.5 w-2.5 transition ${open ? 'rotate-90' : ''}`}
          fill="currentColor"
        >
          <path d="M4 2l4 4-4 4V2z" />
        </svg>
        <span className={labelClass}>{inProgress ? 'Thinking…' : 'Thought process'}</span>
      </button>
      {open && (
        <div className="whitespace-pre-wrap border-t border-white/5 px-3 py-2 text-[12.5px] leading-relaxed text-ink-400">
          {content}
        </div>
      )}
    </div>
  )
}

function toolLabel(call: ToolCall): { verb: string; target: string } {
  const a = call.args
  switch (call.name) {
    case 'write_file':
      return { verb: 'Writing', target: String(a.path ?? '') }
    case 'read_file':
      return { verb: 'Reading', target: String(a.path ?? '') }
    case 'edit_file':
      return { verb: 'Editing', target: String(a.path ?? '') }
    case 'delete_file':
      return { verb: 'Deleting', target: String(a.path ?? '') }
    case 'list_files':
      return { verb: 'Listing', target: 'workspace' }
    case 'run_bash':
      return { verb: 'Running', target: String(a.command ?? '').slice(0, 80) }
    case 'open_preview':
      return { verb: 'Opening', target: 'preview' }
    case 'web_search':
      return { verb: 'Searching', target: String(a.query ?? '') }
    case 'fetch_url':
      return { verb: 'Fetching', target: String(a.url ?? '') }
    case 'calc':
      return { verb: 'Calculating', target: String(a.expression ?? '') }
    default:
      return { verb: call.name, target: '' }
  }
}

function toolIcon(name: string): string {
  switch (name) {
    case 'write_file':
      return '✎'
    case 'read_file':
      return '⇠'
    case 'edit_file':
      return '✂'
    case 'delete_file':
      return '⊗'
    case 'list_files':
      return '☰'
    case 'run_bash':
      return '▸'
    case 'open_preview':
      return '◉'
    case 'web_search':
      return '⌕'
    case 'fetch_url':
      return '↗'
    case 'calc':
      return '∑'
    default:
      return '·'
  }
}

function ToolCallView({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const running = !!call.running
  const { verb, target } = toolLabel(call)
  const ico = toolIcon(call.name)
  const permission = call.permission
  const permissionPending = permission?.status === 'pending' && !!permission.requestId
  const permissionLabel =
    permission?.status === 'approved'
      ? 'Approved'
      : permission?.status === 'denied'
        ? 'Denied'
        : permissionPending
          ? 'Permission required'
          : ''

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-white/5 bg-white/[0.02]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-ink-100 hover:bg-white/[0.02]"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center font-mono text-[13px]">
          {running ? (
            <svg className="h-3.5 w-3.5 animate-spin text-white/70" viewBox="0 0 24 24" fill="none">
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
                strokeDasharray="40 100"
              />
            </svg>
          ) : call.error ? (
            <span className="text-red-400">×</span>
          ) : (
            <span className="text-emerald-400/90">{ico}</span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className={running ? 'shimmer-text' : 'text-ink-100'}>
            {running ? `${verb}…` : verb}
          </span>
          {target && (
            <span className="truncate font-mono text-[11.5px] text-ink-400">{target}</span>
          )}
        </span>
        {permissionLabel && (
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
              permission?.status === 'denied'
                ? 'bg-red-500/10 text-red-300'
                : permission?.status === 'approved'
                  ? 'bg-emerald-500/10 text-emerald-300'
                  : 'bg-amber-500/10 text-amber-200'
            }`}
          >
            {permissionLabel}
          </span>
        )}
        <svg
          viewBox="0 0 12 12"
          className={`h-2.5 w-2.5 shrink-0 text-ink-400 transition ${open ? 'rotate-90' : ''}`}
          fill="currentColor"
        >
          <path d="M4 2l4 4-4 4V2z" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-white/5 px-3 py-2 font-mono text-[11.5px] text-ink-400">
          {call.name === 'write_file' && typeof call.args.content === 'string' ? (
            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words text-ink-200">
              {String(call.args.content).slice(0, 4000)}
              {String(call.args.content).length > 4000 ? '\n…' : ''}
            </pre>
          ) : (
            <div className="mb-1 text-ink-400/80">
              args: {JSON.stringify(call.args).slice(0, 400)}
              {JSON.stringify(call.args).length > 400 ? '…' : ''}
            </div>
          )}
          {call.result && (
            <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words text-ink-200">
              {call.result}
            </pre>
          )}
          {call.error && <div className="text-red-400">{call.error}</div>}
        </div>
      )}
    </div>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function PermissionBanner({
  call,
  onPermission
}: {
  call: ToolCall
  onPermission: (requestId: string, decision: ToolPermissionResponseDecision) => Promise<void>
}) {
  const [responding, setResponding] = useState<ToolPermissionResponseDecision | null>(null)
  const { verb, target } = toolLabel(call)
  const ico = toolIcon(call.name)
  const permission = call.permission

  if (!permission?.requestId || permission.status !== 'pending') return null

  async function respond(decision: ToolPermissionResponseDecision): Promise<void> {
    if (!permission?.requestId || responding) return
    setResponding(decision)
    try {
      await onPermission(permission.requestId, decision)
    } finally {
      setResponding(null)
    }
  }

  return (
    <div className="mx-6 mb-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="shrink-0 font-mono text-[15px] text-amber-300">{ico}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-amber-100">Permission required</div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-400">
            {verb}{target ? ` ${target}` : ''}
          </div>
          {permission.reason && (
            <div className="mt-0.5 text-[11.5px] text-ink-400">{permission.reason}</div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => respond('allow-once')}
            disabled={!!responding}
            className="rounded-md bg-emerald-500/15 px-3 py-1.5 text-[12px] font-medium text-emerald-200 transition hover:bg-emerald-500/25 disabled:cursor-default disabled:opacity-50"
          >
            {responding === 'allow-once' ? 'Approving…' : 'Approve'}
          </button>
          <button
            onClick={() => respond('allow-always')}
            disabled={!!responding}
            className="rounded-md border border-emerald-500/25 px-3 py-1.5 text-[12px] font-medium text-emerald-300/90 transition hover:bg-emerald-500/15 disabled:cursor-default disabled:opacity-50"
          >
            {responding === 'allow-always' ? 'Saving…' : 'Always allow'}
          </button>
          <button
            onClick={() => respond('deny')}
            disabled={!!responding}
            className="rounded-md bg-red-500/15 px-3 py-1.5 text-[12px] font-medium text-red-200 transition hover:bg-red-500/25 disabled:cursor-default disabled:opacity-50"
          >
            {responding === 'deny' ? 'Denying…' : 'Deny'}
          </button>
        </div>
      </div>
    </div>
  )
}
