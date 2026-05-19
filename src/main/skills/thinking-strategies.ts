// Model-aware thinking/reasoning trigger strategies. See
// cortex/wiki/concepts/thinking-mode-triggers.md for the design rationale and
// the verification protocol for adding new model entries.

export type ThinkingTrigger =
  | { kind: 'system-token'; token: string }
  | { kind: 'template-kwarg'; key: string }
  | { kind: 'always-on' }
  | { kind: 'unsupported' }

export type ThinkingParser =
  | { kind: 'reasoning-field' }
  | { kind: 'inline-think-tags' }

export interface ThinkingStrategy {
  trigger: ThinkingTrigger
  parser: ThinkingParser
  recommendedMaxTokens?: number
}

const THINKING_STRATEGIES: Record<string, ThinkingStrategy> = {
  'mlx-community/gemma-4-e2b-it-4bit': {
    trigger: { kind: 'system-token', token: '<|think|>' },
    parser: { kind: 'reasoning-field' },
    recommendedMaxTokens: 8192
  },
  'mlx-community/gemma-4-e4b-it-4bit': {
    trigger: { kind: 'system-token', token: '<|think|>' },
    parser: { kind: 'reasoning-field' },
    recommendedMaxTokens: 8192
  }
}

export function getThinkingStrategy(model: string): ThinkingStrategy | null {
  return THINKING_STRATEGIES[model] ?? null
}

// Strip <think>...</think> / <thinking>...</thinking> blocks from assistant
// content before replaying conversation history to the model. Gemma 4's prompt
// formatting docs explicitly recommend not feeding past thinking back: it bloats
// context and biases future reasoning. Also handles unclosed tags from aborted
// streams so we never replay a half-open block.
const THINKING_BLOCK_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g
const UNCLOSED_THINKING_RE = /<think(?:ing)?>[\s\S]*$/

export function stripThinkingFromContent(content: string): string {
  return content.replace(THINKING_BLOCK_RE, '').replace(UNCLOSED_THINKING_RE, '').trim()
}
