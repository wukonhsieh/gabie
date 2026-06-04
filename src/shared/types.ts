export type SetupStage =
  | 'checking'
  | 'installing-mlx'
  | 'starting-mlx'
  | 'downloading-model'
  | 'ready'
  | 'error'

export interface SetupStatus {
  stage: SetupStage
  message: string
  progress?: number
  bytesDone?: number
  bytesTotal?: number
  error?: string
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  error?: string
  running?: boolean
  permission?: ToolPermissionState
}

export type ToolPermissionMode = 'deny' | 'ask' | 'allow'

export type ToolPermissionResponseDecision = 'allow' | 'deny'

export interface ToolPermissionState {
  mode: ToolPermissionMode
  requestId?: string
  status?: 'pending' | 'approved' | 'denied'
  reason?: string
}

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  toolCalls?: ToolCall[]
  createdAt: number
  model?: string
  done?: boolean
  activity?: AgentActivity
}

export type AgentMode = 'chat' | 'code'

export interface ProjectRecord {
  id: string
  path: string
  name: string
  createdAt: number
  lastActivityAt: number
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  mode: AgentMode
  canvasOpen?: boolean
  projectId?: string
  projectPath?: string
}

export interface ChatState {
  conversations: Conversation[]
  projects: ProjectRecord[]
  activeProjectId: string | null
}

export interface ChatRequest {
  conversationId: string
  messages: Array<{ role: Role; content: string; toolCalls?: ToolCall[] }>
  model: string
  enableTools: boolean
  mode: AgentMode
  workspacePath?: string
  toolPermissions?: Partial<Record<string, ToolPermissionMode>>
  enableThinking?: boolean
}

export interface WorkspaceInfo {
  conversationId: string
  path: string
  previewUrl: string
}

export interface WorkspaceFile {
  path: string
  kind: 'file' | 'dir'
  size?: number
}

export interface FileChangeEvent {
  conversationId: string
}

export interface MessageRewriteEvent {
  conversationId: string
  messageIndex: number
  content: string
}

export type AgentActivity =
  | { kind: 'idle' }
  | { kind: 'thinking'; chars?: number }
  | { kind: 'generating'; chars?: number }
  | { kind: 'tool'; tool: string; target?: string; chars?: number }

export interface ToolPermissionRequest {
  id: string
  conversationId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  mode: Extract<ToolPermissionMode, 'ask'>
  target?: string
  reason: string
  createdAt: number
}

export interface ToolPermissionResponse {
  requestId: string
  decision: ToolPermissionResponseDecision
}

export type StreamChunk =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_permission'; request: ToolPermissionRequest }
  | { type: 'tool_result'; id: string; result?: string; error?: string }
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'done' }
  | { type: 'error'; error: string }

export interface ModelInfo {
  /** HuggingFace repo ID — used internally for mlx_lm */
  name: string
  /** Short, user-friendly display name */
  label: string
  size: string
  sizeBytes: number
  description: string
  recommended?: boolean
  /** How this model activates reasoning. Absent means unsupported. */
  thinkingSupport?: 'system-token' | 'always-on'
}

export const AVAILABLE_MODELS: ModelInfo[] = [
  {
    name: 'mlx-community/gemma-4-e2b-it-4bit',
    label: 'Gemma 4 E2B',
    size: '1.5 GB',
    sizeBytes: 1_500_000_000,
    description: 'Edge-sized. Fast & lightweight. Text + image + audio. Runs on 8GB+ Macs.',
    thinkingSupport: 'system-token'
  },
  {
    name: 'mlx-community/gemma-4-e4b-it-4bit',
    label: 'Gemma 4 E4B',
    size: '3 GB',
    sizeBytes: 3_000_000_000,
    description: 'Best all-rounder. Text + image + audio. Runs on 8GB+ Macs.',
    recommended: true,
    thinkingSupport: 'system-token'
  },
  {
    name: 'mlx-community/gemma-4-12B-it-4bit',
    label: 'Gemma 4 12B',
    size: '8 GB',
    sizeBytes: 8_000_000_000,
    description: 'Mid-sized multimodal model. Better quality than E4B. 16GB+ RAM recommended.',
    thinkingSupport: 'system-token'
  },
  // {
  //   name: 'mlx-community/gemma-4-26b-a4b-it-4bit',
  //   label: 'Gemma 4 27B MoE',
  //   size: '16 GB',
  //   sizeBytes: 16_000_000_000,
  //   description: 'Mixture-of-Experts (26B, 4B active). 16GB+ RAM recommended.'
  // },
  {
    name: 'unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit',
    label: 'Gemma 4 27B MoE',
    size: '15 GB',
    sizeBytes: 15_000_000_000,
    description: 'Mixture-of-Experts (26B, 4B active). 16GB+ RAM recommended.',
    thinkingSupport: 'always-on'
  },
  // {
  //   name: 'mlx-community/gemma-4-31b-it-4bit',
  //   label: 'Gemma 4 31B',
  //   size: '18 GB',
  //   sizeBytes: 18_000_000_000,
  //   description: 'Frontier dense model. Best quality. 32GB+ RAM recommended.'
  // },
  {
    name: 'unsloth/gemma-4-31b-it-UD-MLX-4bit',
    label: 'Gemma 4 31B',
    size: '22 GB',
    sizeBytes: 22_000_000_000,
    description: 'Frontier dense model. Best quality. 32GB+ RAM recommended.',
    thinkingSupport: 'always-on'
  },
]

export const DEFAULT_MODEL = 'unsloth/gemma-4-31b-it-UD-MLX-4bit'

// Settings types
export interface ToolInfo {
  name: string
  description: string
}

export type ToolPermissionValue = ToolPermissionMode

export const SETTINGS_CHANNELS = {
  GET_TOOL_LIST: 'settings:get-tool-list',
  GET_WORKSPACE_ROOT: 'settings:get-workspace-root',
  GET_PERMISSIONS: 'settings:get-permissions',
  SET_PERMISSION: 'settings:set-permission',
  GET_SYSTEM_PROMPT: 'settings:get-system-prompt',
  GET_CHAT_LANGUAGE: 'settings:get-chat-language',
  SET_CHAT_LANGUAGE: 'settings:set-chat-language',
} as const
