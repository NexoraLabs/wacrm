import type { AiProvider } from './types'

/**
 * Curated per-provider model choices for the Settings → AI dropdown.
 * Not exhaustive — model catalogs (especially OpenRouter's, which
 * proxies 100+ vendors) churn too fast and are too large to list in
 * full. The UI falls back to a free-text "Custom" entry for anything
 * not listed here, so this is a convenience shortlist, never a hard
 * allow-list — `generateReply` accepts whatever string is stored.
 */
export interface AiModelOption {
  value: string
  label: string
}

export const AI_MODEL_OPTIONS: Record<AiProvider, AiModelOption[]> = {
  openai: [
    { value: 'gpt-5.4', label: 'GPT-5.4 (most capable)' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini (fast, cheap default)' },
    { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano (cheapest)' },
  ],
  anthropic: [
    { value: 'claude-opus-4-8', label: 'Claude Opus 4.8 (most capable)' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 (balanced)' },
    {
      value: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5 (fast, cheap default)',
    },
  ],
  openrouter: [
    { value: 'openai/gpt-4o-mini', label: 'OpenAI · GPT-4o Mini' },
    { value: 'anthropic/claude-3.7-sonnet', label: 'Anthropic · Claude 3.7 Sonnet' },
    {
      value: 'meta-llama/llama-3.3-70b-instruct',
      label: 'Meta · Llama 3.3 70B Instruct',
    },
    { value: 'google/gemini-2.0-flash-001', label: 'Google · Gemini 2.0 Flash' },
    { value: 'deepseek/deepseek-chat', label: 'DeepSeek · Chat' },
  ],
}

/** Sentinel Select value for "type your own model slug." */
export const CUSTOM_MODEL_VALUE = '__custom__'
