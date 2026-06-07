import { describe, test, expect } from 'vitest'
import { buildPermissionConfig } from '../../src/main/permissions'

describe('buildPermissionConfig: tool name mapping', () => {
  test('maps gabie tool names to llm-tools names', () => {
    const result = buildPermissionConfig({
      write_file: 'allow',
      run_bash: 'ask',
      web_search: 'deny',
      read_file: 'allow',
      edit_file: 'allow',
      list_files: 'allow',
      delete_file: 'ask',
      fetch_url: 'ask',
      calc: 'allow'
    })
    expect(result.defaults).toMatchObject({
      file_write: 'allow',
      bash: 'ask',
      web_search: 'deny',
      file_read: 'allow',
      file_edit: 'allow',
      file_list: 'allow',
      file_delete: 'ask',
      web_fetch: 'ask',
      calc: 'allow'
    })
  })

  test('open_preview is not included in output (no llm-tools equivalent)', () => {
    const result = buildPermissionConfig({ open_preview: 'allow' })
    expect(Object.keys(result.defaults)).not.toContain('open_preview')
  })

  test('returns workspaces as empty object', () => {
    const result = buildPermissionConfig({})
    expect(result.workspaces).toEqual({})
  })

  test('preserves permission level values exactly', () => {
    const result = buildPermissionConfig({ write_file: 'deny' })
    expect(result.defaults.file_write).toBe('deny')
  })

  test('unknown gabie tool names are excluded', () => {
    const result = buildPermissionConfig({ unknown_tool: 'allow' } as Record<string, 'allow'>)
    expect(Object.keys(result.defaults)).not.toContain('unknown_tool')
  })
})
