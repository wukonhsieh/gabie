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
  'mlx-community/gemma-4-e4b-it-4bit': {
    trigger: { kind: 'system-token', token: '<|think|>' },
    parser: { kind: 'reasoning-field' },
    recommendedMaxTokens: 8192
  }
}

export function getThinkingStrategy(model: string): ThinkingStrategy | null {
  return THINKING_STRATEGIES[model] ?? null
}
