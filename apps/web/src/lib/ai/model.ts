import { env } from '@/env';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export const MODEL_PROVIDERS = ['anthropic', 'openai', 'qvac'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

// Single seam for swapping AI providers. Add a fourth provider here only —
// callers (route handlers, tests) never import @ai-sdk/* directly.
//
// Provider keys are validated at runtime rather than via Zod refinements: only
// the chosen provider's key needs to be present, and that's awkward to express
// in t3-env. The thrown error here is actionable.
//
// `.chat(...)` forces the chat-completions endpoint (POST /v1/chat/completions)
// instead of the OpenAI provider's default responses API (POST /v1/responses).
// QVAC and most third-party OpenAI-compatible servers only implement the chat
// completions envelope. Using `.chat(...)` for OpenAI itself keeps both paths
// on the same wire shape, which simplifies parity.
export function modelFor(provider: ModelProvider = env.MODEL_PROVIDER): LanguageModel {
  switch (provider) {
    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic');
      }
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(env.ANTHROPIC_MODEL);
    }
    case 'openai': {
      if (!env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required when MODEL_PROVIDER=openai');
      }
      return createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat(env.OPENAI_MODEL);
    }
    case 'qvac': {
      // QVAC's HTTP server is OpenAI-compatible (chat completions only); reuse
      // the OpenAI provider with a custom baseURL. The apiKey is required by
      // the SDK but ignored by QVAC.
      return createOpenAI({ apiKey: 'unused', baseURL: env.QVAC_BASE_URL }).chat(env.QVAC_MODEL);
    }
  }
}
