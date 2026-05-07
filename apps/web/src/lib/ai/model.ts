import { env } from '@/env';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export const MODEL_PROVIDERS = ['anthropic', 'openai'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

// Snapshot the native fetch at module load. The AI SDK reads `globalThis.fetch`
// at request time (`getOriginalFetch = () => globalThis.fetch`); if any
// transitive Solana SDK dep monkey-patches the global with a node-fetch v2
// shim (whose Response.body is a Node Readable, not a WebStream), the SDK's
// `response.body.pipeThrough(...)` call breaks. Locking the provider's fetch
// at import time freezes us on the native implementation regardless of later
// pollution.
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

// Single seam for swapping AI providers. Add a third provider here only —
// callers (route handlers, tests) never import @ai-sdk/* directly.
//
// Provider keys are validated at runtime rather than via Zod refinements: only
// the chosen provider's key needs to be present, and that's awkward to express
// in t3-env. The thrown error here is actionable.
export function modelFor(provider: ModelProvider = env.MODEL_PROVIDER): LanguageModel {
  switch (provider) {
    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic');
      }
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY, fetch: nativeFetch })(
        env.ANTHROPIC_MODEL,
      );
    }
    case 'openai': {
      if (!env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required when MODEL_PROVIDER=openai');
      }
      return createOpenAI({ apiKey: env.OPENAI_API_KEY, fetch: nativeFetch }).chat(
        env.OPENAI_MODEL,
      );
    }
  }
}
