import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import {
  SETTINGS_CHANNELS,
  type ChatRequest,
  type ChatState,
  type MessageRewriteEvent,
  type SetupStatus,
  type StreamChunk,
  type ToolInfo,
  type ToolPermissionResponse,
  type ToolPermissionValue,
  type WorkspaceInfo,
  type WorkspaceFile
} from '../shared/types'

const api = {
  startSetup: (model: string): Promise<void> => ipcRenderer.invoke('setup:start', model),

  switchModel: (model: string): Promise<void> => ipcRenderer.invoke('model:switch', model),

  checkMLX: (): Promise<{ hasMLX: boolean }> => ipcRenderer.invoke('setup:status'),

  onSetupStatus: (cb: (s: SetupStatus) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, s: SetupStatus): void => cb(s)
    ipcRenderer.on('setup:status', listener)
    return () => ipcRenderer.removeListener('setup:status', listener)
  },

  listLocalModels: (): Promise<string[]> => ipcRenderer.invoke('models:list-local'),

  selectProjectFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('project:select-folder'),

  sendChat: async (req: ChatRequest, onChunk: (c: StreamChunk) => void): Promise<void> => {
    const { channel } = (await ipcRenderer.invoke('chat:send', req)) as { channel: string }
    return new Promise((resolve) => {
      const listener = (_: IpcRendererEvent, chunk: StreamChunk): void => {
        onChunk(chunk)
        if (chunk.type === 'done' || chunk.type === 'error') {
          ipcRenderer.removeListener(channel, listener)
          resolve()
        }
      }
      ipcRenderer.on(channel, listener)
    })
  },

  abortChat: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke('chat:abort', conversationId),

  loadChatState: (): Promise<ChatState> => ipcRenderer.invoke('chat-state:load'),

  saveChatState: (state: ChatState): Promise<void> =>
    ipcRenderer.invoke('chat-state:save', state),

  migrateChatStateFromLegacy: (
    legacy: unknown
  ): Promise<{ migrated: boolean; conversationCount: number }> =>
    ipcRenderer.invoke('chat-state:migrate-from-legacy', legacy),

  listTools: (): Promise<Array<{ name: string; description: string; mode: string }>> =>
    ipcRenderer.invoke('tools:list'),

  respondToToolPermission: (
    response: ToolPermissionResponse
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke('tool-permission:respond', response),

  getWorkspace: (conversationId: string, workspacePath?: string): Promise<WorkspaceInfo> =>
    ipcRenderer.invoke('workspace:info', { conversationId, workspacePath }),

  listWorkspace: (conversationId: string, workspacePath?: string): Promise<WorkspaceFile[]> =>
    ipcRenderer.invoke('workspace:list', { conversationId, workspacePath }),

  openWorkspace: (conversationId: string, workspacePath?: string): Promise<void> =>
    ipcRenderer.invoke('workspace:open-external', { conversationId, workspacePath }),

  workspaceServerPort: (): Promise<number> => ipcRenderer.invoke('workspace:server-port'),

  onWorkspaceChanged: (cb: (ev: { conversationId: string }) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, ev: { conversationId: string }): void => cb(ev)
    ipcRenderer.on('workspace:changed', listener)
    return () => ipcRenderer.removeListener('workspace:changed', listener)
  },

  onMessageRewrite: (cb: (ev: MessageRewriteEvent) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, ev: MessageRewriteEvent): void => cb(ev)
    ipcRenderer.on('chat:rewrite_message', listener)
    return () => ipcRenderer.removeListener('chat:rewrite_message', listener)
  },

  onRawChunk: (
    cb: (ev: { conversationId: string; chunk: string }) => void
  ): (() => void) => {
    const listener = (
      _: IpcRendererEvent,
      ev: { conversationId: string; chunk: string }
    ): void => cb(ev)
    ipcRenderer.on('chat:raw', listener)
    return () => ipcRenderer.removeListener('chat:raw', listener)
  },

  onFileStreaming: (
    cb: (ev: { conversationId: string; path: string; content: string; done: boolean }) => void
  ): (() => void) => {
    const listener = (
      _: IpcRendererEvent,
      ev: { conversationId: string; path: string; content: string; done: boolean }
    ): void => cb(ev)
    ipcRenderer.on('file:streaming', listener)
    return () => ipcRenderer.removeListener('file:streaming', listener)
  },

  transcribeAudio: (base64: string, model: string): Promise<{ text: string }> =>
    ipcRenderer.invoke('audio:transcribe', { base64, model }),

  settingsGetToolList: (): Promise<ToolInfo[]> =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.GET_TOOL_LIST),

  settingsGetWorkspaceRoot: (): Promise<string> =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.GET_WORKSPACE_ROOT),

  settingsGetPermissions: (): Promise<Record<string, ToolPermissionValue>> =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.GET_PERMISSIONS),

  settingsSetPermission: (tool: string, value: ToolPermissionValue): Promise<void> =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.SET_PERMISSION, { tool, value }),

  settingsGetSystemPrompt: (
    mode: string,
    projectPath?: string,
    conversationId?: string,
    enableTools?: boolean
  ): Promise<string> =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.GET_SYSTEM_PROMPT, {
      mode,
      projectPath,
      conversationId,
      enableTools
    }),

  settingsGetChatLanguage: (): Promise<string> =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.GET_CHAT_LANGUAGE),

  settingsSetChatLanguage: (lang: string): Promise<void> =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.SET_CHAT_LANGUAGE, { lang })
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
