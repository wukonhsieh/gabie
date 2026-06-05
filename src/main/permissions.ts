import type { ToolPermissionMode } from '../shared/types'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { PermissionConfig } from 'llm-tools'

export type ToolPermissionPolicy = Partial<Record<string, ToolPermissionMode>>

export interface ToolPermissionEvaluation {
  mode: ToolPermissionMode
  reason: string
}

export const DEFAULT_TOOL_PERMISSION_POLICY: ToolPermissionPolicy = {
  web_search: 'ask',
  fetch_url: 'ask',
  calc: 'allow',
  write_file: 'allow',
  read_file: 'allow',
  edit_file: 'allow',
  list_files: 'allow',
  delete_file: 'ask',
  run_bash: 'ask',
  open_preview: 'allow'
}

export interface ToolPermissionConfig {
  tools: Record<string, ToolPermissionMode>
  chatLanguage?: string
}

export function toolPermissionConfigPath(): string {
  return join(homedir(), '.config', 'gabie', 'gabie.json')
}

export async function loadToolPermissionPolicy(): Promise<ToolPermissionPolicy> {
  const path = toolPermissionConfigPath()
  try {
    const raw = await readFile(path, 'utf-8')
    return normalizeToolPermissionConfig(JSON.parse(raw)).tools
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      return { ...DEFAULT_TOOL_PERMISSION_POLICY }
    }
    const config = defaultToolPermissionConfig()
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(config, null, 2) + '\n', 'utf-8')
    } catch (writeErr) {
      console.warn('Failed to write tool permission config:', writeErr)
    }
    return config.tools
  }
}

function defaultToolPermissionConfig(): ToolPermissionConfig {
  return {
    tools: { ...DEFAULT_TOOL_PERMISSION_POLICY } as Record<string, ToolPermissionMode>
  }
}

function normalizeToolPermissionConfig(value: unknown): ToolPermissionConfig {
  const source =
    value && typeof value === 'object' && 'tools' in value
      ? (value as { tools?: unknown }).tools
      : value
  const tools: Record<string, ToolPermissionMode> = {
    ...DEFAULT_TOOL_PERMISSION_POLICY
  } as Record<string, ToolPermissionMode>
  if (source && typeof source === 'object') {
    for (const [name, mode] of Object.entries(source as Record<string, unknown>)) {
      if (mode === 'deny' || mode === 'ask' || mode === 'allow') {
        tools[name] = mode
      }
    }
  }
  return { tools }
}

export async function loadChatLanguage(): Promise<string> {
  const path = toolPermissionConfigPath()
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    const lang = (raw as ToolPermissionConfig).chatLanguage
    return typeof lang === 'string' && lang ? lang : 'en'
  } catch {
    return 'en'
  }
}

export async function saveChatLanguage(lang: string): Promise<void> {
  const path = toolPermissionConfigPath()
  let raw: unknown = {}
  try {
    raw = JSON.parse(await readFile(path, 'utf-8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const merged = { ...(typeof raw === 'object' && raw !== null ? raw : {}), chatLanguage: lang }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
}

export async function saveToolPermission(tool: string, value: ToolPermissionMode): Promise<void> {
  const path = toolPermissionConfigPath()
  let raw: unknown = {}
  try {
    raw = JSON.parse(await readFile(path, 'utf-8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const config = normalizeToolPermissionConfig(raw)
  config.tools[tool] = value
  const merged = { ...(typeof raw === 'object' && raw !== null ? raw : {}), tools: config.tools }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
}

const GABIE_TO_LLM_TOOLS_NAME: Record<string, string> = {
  web_search: 'web_search',
  fetch_url: 'web_fetch',
  calc: 'calc',
  write_file: 'file_write',
  read_file: 'file_read',
  edit_file: 'file_edit',
  list_files: 'file_list',
  delete_file: 'file_delete',
  run_bash: 'bash'
}

export function buildPermissionConfig(policy: ToolPermissionPolicy): PermissionConfig {
  const defaults: Record<string, ToolPermissionMode> = {}
  for (const [gabieKey, mode] of Object.entries(policy)) {
    const llmKey = GABIE_TO_LLM_TOOLS_NAME[gabieKey]
    if (llmKey && mode) defaults[llmKey] = mode
  }
  return { defaults, workspaces: {} }
}

export function evaluateToolPermission(
  toolName: string,
  policy: ToolPermissionPolicy = DEFAULT_TOOL_PERMISSION_POLICY
): ToolPermissionEvaluation {
  const mode = policy[toolName] ?? 'ask'
  return {
    mode,
    reason: `Tool policy for ${toolName} is ${mode}.`
  }
}
