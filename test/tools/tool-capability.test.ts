/**
 * Tool-capability tests — verify that each LLM emits correctly-formed
 * @@<tool_name> action blocks with well-typed, semantically-correct parameters.
 *
 * Tools are NEVER executed. Only the raw LLM output is inspected.
 *
 * Run once per model (the MLX server only loads one model at a time):
 *
 *   LLM_URL=http://127.0.0.1:11434/v1 \
 *   LLM_MODEL=mlx-community/gemma-4-e2b-it-4bit \
 *   npx vitest run test/tools/tool-capability.test.ts
 *
 * Thinking is disabled by default because these tests inspect tool-action
 * formatting, not reasoning quality. To test with thinking enabled:
 *   LLM_ENABLE_THINKING=true npm run test:tool-capability
 *
 * Repeat with:
 *   LLM_MODEL=mlx-community/gemma-4-e4b-it-4bit
 *   LLM_MODEL=mlx-community/gemma-4-12B-it-4bit
 *   LLM_MODEL=unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit
 *   LLM_MODEL=unsloth/gemma-4-31b-it-UD-MLX-4bit
 *
 * Results for all models can be compared side-by-side using:
 *   npm run test:tool-capability 2>&1 | tee results-<model-label>.txt
 */

import { describe, test, expect } from 'vitest'
import { findNextAction, chatSystemPrompt, codeSystemPrompt } from '../../src/main/tools'

// ─── Environment ─────────────────────────────────────────────────────────────

const LLM_URL = process.env.LLM_URL
const LLM_MODEL = process.env.LLM_MODEL ?? ''
const LLM_ENABLE_THINKING = process.env.LLM_ENABLE_THINKING === 'true'

const describeIfLLM = LLM_URL ? describe : describe.skip

// System prompts with tools enabled
const CHAT_SYS = chatSystemPrompt(true)
const CODE_SYS = codeSystemPrompt('/workspace', 'http://localhost:3000')

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Call the currently-loaded LLM with a system + user message using the app's streaming path. */
async function callLLM(
  systemPrompt: string,
  userContent: string,
  maxTokens = 1024
): Promise<string> {
  const res = await fetch(`${LLM_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      max_tokens: maxTokens,
      temperature: 0.0,
      enable_thinking: LLM_ENABLE_THINKING,
      stream: true
    })
  })
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${res.statusText}`)
  const raw = await res.text()
  return collectStreamingContent(raw)
}

function collectStreamingContent(raw: string): string {
  let content = ''
  let reasoningOpen = false
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const event = JSON.parse(payload) as {
        choices?: Array<{
          delta?: {
            content?: string | null
            reasoning?: string | null
            reasoning_content?: string | null
          }
        }>
      }
      const delta = event.choices?.[0]?.delta
      const reasoningChunk = delta?.reasoning ?? delta?.reasoning_content
      if (reasoningChunk) {
        if (!reasoningOpen) {
          content += '<think>'
          reasoningOpen = true
        }
        content += reasoningChunk
      }
      if (delta?.content) {
        if (reasoningOpen) {
          content += '</think>\n'
          reasoningOpen = false
        }
        content += delta.content
      }
    } catch {
      // Ignore malformed SSE events; the test assertions fail if no action remains.
    }
  }
  if (reasoningOpen) {
    content += '</think>\n'
  }
  return content
}

/**
 * Parse the first action block from LLM output.
 * Returns null when the LLM produced no action (or an incomplete one).
 */
function parseAction(text: string) {
  const a = findNextAction(text)
  return a === 'incomplete' ? null : a
}

/** Assertion helper — fails with the full LLM response for easy debugging. */
function assertAction(action: ReturnType<typeof parseAction>, raw: string) {
  expect(action, `LLM did not emit an action block. Full response:\n---\n${raw}\n---`).not.toBeNull()
  return action!
}

// ─── Test timeout (LLM calls can be slow for larger models) ──────────────────

const T = { timeout: 60_000 }

// ─── Suite ───────────────────────────────────────────────────────────────────

describeIfLLM(`tool-capability [${LLM_MODEL || '(no model)'}]`, () => {

  // ── Chat-mode tools: web_search, fetch_url, calc ─────────────────────────

  describe('web_search', () => {
    test('emits web_search with a non-empty string query', T, async () => {
      const out = await callLLM(CHAT_SYS, 'Use the web_search tool to look up the latest Python release.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('web_search')
      expect(typeof a.args.query).toBe('string')
      expect((a.args.query as string).trim()).not.toBe('')
    })

    test('query is semantically relevant to the user request', T, async () => {
      const out = await callLLM(CHAT_SYS, 'Search the web for: best JavaScript frameworks 2024')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('web_search')
      const q = (a.args.query as string).toLowerCase()
      expect(q).toMatch(/javascript|framework/i)
    })
  })

  describe('fetch_url', () => {
    test('emits fetch_url with a valid http(s) URL', T, async () => {
      const out = await callLLM(CHAT_SYS, 'Use fetch_url to retrieve https://example.com')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('fetch_url')
      const url = String(a.args.url ?? '')
      expect(url).toMatch(/^https?:\/\//)
    })

    test('url argument matches the URL specified in the request', T, async () => {
      const out = await callLLM(
        CHAT_SYS,
        'Fetch the page at https://example.com using fetch_url and summarize its content.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('fetch_url')
      expect(a.args.url).toBe('https://example.com')
    })
  })

  describe('calc', () => {
    test('emits calc with a non-empty expression', T, async () => {
      const out = await callLLM(CHAT_SYS, 'Use the calc tool to compute 25 * 4 + 10.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('calc')
      expect(typeof a.args.expression).toBe('string')
      expect((a.args.expression as string).trim()).not.toBe('')
    })

    test('expression contains only characters allowed by the calc tool', T, async () => {
      // calc rejects expressions with letters other than e/E; see tools.ts regex
      const out = await callLLM(CHAT_SYS, 'Calculate (100 + 50) / 3 using the calc tool.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('calc')
      const expr = String(a.args.expression ?? '')
      expect(expr).toMatch(/^[0-9+\-*/().\s^%,eE]+$/)
    })

    test('expression includes the numbers from the user request', T, async () => {
      const out = await callLLM(CHAT_SYS, 'Compute 12 * 8 using calc.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('calc')
      const expr = String(a.args.expression ?? '')
      expect(expr).toMatch(/12/)
      expect(expr).toMatch(/8/)
    })
  })

  // ── Code-mode tools ────────────────────────────────────────────────────────

  describe('write_file', () => {
    test('emits write_file with path and non-empty content', T, async () => {
      const out = await callLLM(
        CODE_SYS,
        'Create a file called hello.html with a simple "Hello World" HTML page.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('write_file')
      expect(typeof a.args.path).toBe('string')
      expect((a.args.path as string).trim()).not.toBe('')
      expect(typeof a.args.content).toBe('string')
      expect((a.args.content as string).trim().length).toBeGreaterThan(10)
    })

    test('path is relative — no leading slash', T, async () => {
      const out = await callLLM(
        CODE_SYS,
        'Write a file named app.js that logs "start" to the console.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('write_file')
      expect(String(a.args.path)).not.toMatch(/^\//)
    })

    test('content is raw file text, not wrapped in markdown fences', T, async () => {
      const out = await callLLM(CODE_SYS, 'Create style.css containing: body { margin: 0; }')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('write_file')
      const content = String(a.args.content ?? '')
      // The heredoc parser strips fences, but a compliant model should not emit them
      expect(content.trimStart()).not.toMatch(/^```/)
    })
  })

  describe('read_file', () => {
    test('emits read_file with a non-empty path', T, async () => {
      const out = await callLLM(CODE_SYS, 'Read the file index.html using read_file.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('read_file')
      expect(typeof a.args.path).toBe('string')
      expect((a.args.path as string).trim()).not.toBe('')
    })

    test('path matches the filename requested', T, async () => {
      const out = await callLLM(CODE_SYS, 'Read the file package.json using read_file.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('read_file')
      expect(a.args.path).toBe('package.json')
    })
  })

  describe('edit_file', () => {
    test('emits edit_file with path, old_string, and new_string', T, async () => {
      const out = await callLLM(
        CODE_SYS,
        // Provide workspace context so the model does not list/read first
        'The workspace already has a file app.js that contains the text "Hello". ' +
        'Use edit_file to replace that text with "Hello, World". Do not read or list files first.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('edit_file')
      expect(typeof a.args.path).toBe('string')
      expect(typeof a.args.old_string).toBe('string')
      expect(typeof a.args.new_string).toBe('string')
      expect((a.args.path as string).trim()).not.toBe('')
      expect((a.args.old_string as string).trim()).not.toBe('')
    })

    test('old_string and new_string match what the user asked for', T, async () => {
      const out = await callLLM(
        CODE_SYS,
        'index.html already exists in the workspace and contains the text "Hello". ' +
        'Use edit_file to replace the exact text "Hello" with "Hello, World". ' +
        'Do not read the file first — call edit_file directly.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('edit_file')
      expect(a.args.old_string).toBe('Hello')
      expect(a.args.new_string).toBe('Hello, World')
    })

    test('replace_all param is boolean when provided', T, async () => {
      const out = await callLLM(
        CODE_SYS,
        'app.js already exists in the workspace and contains multiple occurrences of "foo". ' +
        'Use edit_file to replace every occurrence of "foo" with "bar" (set replace_all: true). ' +
        'Do not list or read files first.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('edit_file')
      if (a.args.replace_all !== undefined) {
        expect(typeof a.args.replace_all).toBe('boolean')
      }
    })
  })

  describe('list_files', () => {
    test('emits list_files — no required parameters', T, async () => {
      const out = await callLLM(
        CODE_SYS,
        'Use the list_files tool now to list every file in the workspace. ' +
        'list_files has no parameters; emit the list_files action directly.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('list_files')
    })
  })

  describe('find_file', () => {
    test('emits find_file with a non-empty pattern', T, async () => {
      const out = await callLLM(CODE_SYS, 'Use find_file to locate all TypeScript files.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('find_file')
      expect(typeof a.args.pattern).toBe('string')
      expect((a.args.pattern as string).trim()).not.toBe('')
    })

    test('pattern contains .ts extension for a TypeScript search', T, async () => {
      const out = await callLLM(CODE_SYS, 'Find all .ts files using find_file.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('find_file')
      expect(String(a.args.pattern)).toMatch(/\.ts/)
    })

    test('limit param is a positive number when included', T, async () => {
      const out = await callLLM(
        CODE_SYS,
        'Use find_file to search for "*.js" files and limit results to 10.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('find_file')
      if (a.args.limit !== undefined) {
        expect(typeof a.args.limit).toBe('number')
        expect(a.args.limit as number).toBeGreaterThan(0)
      }
    })
  })

  describe('delete_file', () => {
    test('emits delete_file with a non-empty path', T, async () => {
      const out = await callLLM(CODE_SYS, 'Delete the file old.html using delete_file.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('delete_file')
      expect(typeof a.args.path).toBe('string')
      expect((a.args.path as string).trim()).not.toBe('')
    })

    test('path matches the filename the user asked to remove', T, async () => {
      const out = await callLLM(CODE_SYS, 'Delete the file temp.txt using delete_file.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('delete_file')
      expect(a.args.path).toBe('temp.txt')
    })
  })

  describe('run_bash', () => {
    test('emits run_bash with a non-empty command string', T, async () => {
      // Provide workspace context so the model does not list_files to verify package.json first
      const out = await callLLM(
        CODE_SYS,
        'The workspace has a package.json. Use run_bash to run "npm install" right now. ' +
        'Do not list or read files first.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('run_bash')
      expect(typeof a.args.command).toBe('string')
      expect((a.args.command as string).trim()).not.toBe('')
    })

    test('command includes npm install for a dependency installation request', T, async () => {
      const out = await callLLM(CODE_SYS, 'Run "npm install" using run_bash.')
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('run_bash')
      expect(String(a.args.command)).toMatch(/npm\s+install/)
    })

    test('timeout_ms param is a positive number when included', T, async () => {
      const out = await callLLM(
        CODE_SYS,
        'Use run_bash to run "npm test" with a 30-second timeout.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('run_bash')
      if (a.args.timeout_ms !== undefined) {
        expect(typeof a.args.timeout_ms).toBe('number')
        expect(a.args.timeout_ms as number).toBeGreaterThan(0)
      }
    })
  })

  describe('open_preview', () => {
    test('emits open_preview — no required parameters', T, async () => {
      // Provide workspace context so the model does not list_files to verify index.html first
      const out = await callLLM(
        CODE_SYS,
        'The workspace already has an index.html file. ' +
        'Use open_preview to reveal it in the Canvas pane right now. ' +
        'open_preview has no parameters; emit the open_preview action directly. Do not list files first.'
      )
      const a = assertAction(parseAction(out), out)
      expect(a.name).toBe('open_preview')
    })
  })
})
