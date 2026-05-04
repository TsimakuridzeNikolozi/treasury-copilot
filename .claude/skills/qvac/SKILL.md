---
name: qvac
description: QVAC local-first AI runtime by Tether — running on-device LLM inference for Treasury Copilot via the OpenAI-compatible HTTP server, model selection at runtime, and Vercel AI SDK integration. Use when wiring QVAC as one of the swappable model backends, configuring `qvac serve openai`, picking models, or troubleshooting local inference. Triggers on "qvac", "local model", "@qvac/sdk", "qvac serve", "local-first AI", or any work in the AI provider layer of apps/web.
---

# QVAC (local-first AI runtime)

> Canonical docs: https://docs.qvac.tether.io — verify version-sensitive details (model registry tags, CLI flags, SDK signatures) against latest. This skill captures the patterns Treasury Copilot uses.

## Project context

Treasury Copilot supports three pluggable model backends — **Claude** (Anthropic), **OpenAI**, and **QVAC** (local). Users pick at runtime via env. QVAC matters for two reasons specific to this product:

1. **Privacy.** A treasury bot sees account balances, wallet addresses, and proposed financial actions. Some operators won't (or can't) send that to a third-party API.
2. **Determinism / offline.** Local inference removes "the model API is down" as a failure mode for the chat surface. The bot still polls and signers still execute regardless, but the chat half can degrade gracefully to a local model.

QVAC's role in the stack: just a Vercel AI SDK provider, swapped in via `createOpenAI({ baseURL })`. The trust boundary (agent → policy → signer) is unchanged. Whichever model proposes an action, that action still goes through `evaluate()` and `insertProposedAction()` — the model is **never** trusted to make policy decisions.

## Two integration paths — pick the HTTP server

QVAC offers a direct JS SDK (`@qvac/sdk`) and an OpenAI-compatible HTTP server. **Use the HTTP server.**

| Concern | Direct SDK (`@qvac/sdk`) | HTTP server (`qvac serve openai`) |
|---|---|---|
| Provider integration | Custom Vercel AI SDK provider | `createOpenAI({ baseURL })` works as-is |
| Model swap UX | Different code path per provider | Same code path; only baseURL/model name differs |
| Process model | Embedded in `apps/web` Node process | Separate process, restart-independent |
| First-run cost | Bundled as dep | One-time `pnpm dlx @qvac/cli` install |

The HTTP server route gives us OpenAI-compatible chat completions on `http://localhost:11434/v1/` — Vercel AI SDK's OpenAI provider plugs in unchanged. Single code path for OpenAI and QVAC; only the base URL (and model name) differs.

The direct SDK is useful only if we ever want to embed QVAC inside `apps/web` itself (Vercel can't host long-running model processes anyway). Keep it on the table for the worker if local inference there ever becomes interesting.

## Local setup (one-time)

```bash
# Install BOTH packages globally. The CLI alone won't work — see pitfall below.
pnpm add -g @qvac/cli @qvac/sdk
```

> **Critical:** `@qvac/cli` depends on `@qvac/sdk` for the model-registry constants (`QWEN3_600M_INST_Q4`, etc.), but the dependency is loaded at runtime via dynamic import and the `catch` block silently swallows the missing module. Symptom: every model name you pass — including ones you copy verbatim from the docs — comes back as *"unknown model constant"*. The error message even includes a hardcoded suggestion that *also* fails. Install `@qvac/sdk` globally alongside `@qvac/cli` and the registry resolves.

**You must declare model aliases in `qvac.config.json` at the repo root before starting the server** — otherwise it boots with no chat-completions endpoint, only the model-management ones. The error in this state is:

```
No models configured for preload.
QVAC API server listening on http://127.0.0.1:11434
Models:
  (none configured)
Endpoints:
  GET  /v1/models
  GET  /v1/models/:id
  DELETE /v1/models/:id
```

Notice `POST /v1/chat/completions` is missing — that's the symptom.

The minimum viable config:

```json
// qvac.config.json (at repo root)
{
  "serve": {
    "models": {
      "QWEN3_600M_INST_Q4": {
        "model": "QWEN3_600M_INST_Q4",
        "default": true,
        "preload": true
      }
    }
  }
}
```

The outer key (the *alias*) is what the OpenAI-compatible API client uses as the `model` field in chat-completions requests. Naming the alias the same as the registry constant keeps `QVAC_MODEL=QWEN3_600M_INST_Q4` in `.env.local` working without indirection.

Then start the server from the repo root (so it finds the config):

```bash
qvac serve openai
```

First invocation will download the registry model (~2 GB for the 3B). Subsequent loads are warm.

> **Port note:** Port 11434 is also Ollama's default. If you run both, give QVAC a different port: `qvac serve openai -p 11435`. Update `QVAC_BASE_URL` in `.env.local` accordingly.

## Picking a model

Use the registry tag constants from QVAC's documentation. For Treasury Copilot's chat surface, tool-calling support is mandatory (the agent calls `proposeDeposit`, `proposeRebalance`, etc.).

Reasonable starting choices (verify against the registry index — model lineup changes):
- `LLAMA_3_2_1B_INST_Q4_0` — tiny, fastest, good for smoke testing
- `QWEN3_600M_INST_Q4` — better tool-calling fidelity
- `QWEN_2_5_7B_INST` — better for instruction following

Smaller models will hallucinate tool arguments more often. The trust boundary (`policy.evaluate`) catches these as `deny`/`requires_approval`, so a hallucinating agent can't drain funds — but UX suffers. Pick the largest model your hardware can sustain.

## Wiring into the Vercel AI SDK

The provider abstraction lives in `apps/web/src/lib/ai/model.ts`. The signature:

```ts
// apps/web/src/lib/ai/model.ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { env } from '@/env';

export function modelFor() {
  switch (env.MODEL_PROVIDER) {
    case 'anthropic':
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(env.ANTHROPIC_MODEL);
    case 'openai':
      // .chat() forces /v1/chat/completions instead of the OpenAI provider's
      // default /v1/responses — see pitfall below.
      return createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat(env.OPENAI_MODEL);
    case 'qvac':
      return createOpenAI({
        apiKey: 'unused',                          // qvac doesn't auth
        baseURL: env.QVAC_BASE_URL,                // http://localhost:11434/v1
      }).chat(env.QVAC_MODEL);                     // e.g. QWEN3_600M_INST_Q4
  }
}
```

Four things to know:

1. **Use `.chat(model)`, not `provider(model)`.** `@ai-sdk/openai` v3+ defaults to `/v1/responses` (the OpenAI Responses API). QVAC and most third-party OpenAI-compatible servers only implement `/v1/chat/completions`, so you'll see `Unknown endpoint: POST /v1/responses` if you don't call `.chat()`. Using `.chat()` for OpenAI itself keeps both code paths on the same wire shape.

2. **`apiKey` is required by the OpenAI provider but unused by QVAC.** Pass any non-empty string. Never pass `process.env.OPENAI_API_KEY` here — that would leak the OpenAI key to whoever can see your network if the QVAC port is ever exposed.

3. **Model name is the registry tag,** not a friendly name. `QWEN3_600M_INST_Q4` not "llama 3.2".

4. **`generateText` and `streamText` from `ai`** work unchanged across all three providers. Tool calling works the same too — QVAC's HTTP server implements OpenAI's tool-calling envelope.

## Streaming and tool calls

The OpenAI-compatible server supports both streaming (`stream: true`) and tool calls. Vercel AI SDK's `streamText({ tools })` works without any QVAC-specific code path:

```ts
import { streamText } from 'ai';
import { modelFor } from '@/lib/ai/model';
import { proposeDeposit } from '@tc/agent-tools';

const result = streamText({
  model: modelFor(env.MODEL_PROVIDER),
  tools: { proposeDeposit },
  messages,
});
```

If a small QVAC model produces malformed tool-call JSON, the AI SDK throws — handle it the same way you'd handle Anthropic returning a malformed call. The fix is "use a bigger model," not "add validation in the tool."

## Env vars (add to `.env.example`)

```bash
# Pick one: 'anthropic' | 'openai' | 'qvac'
MODEL_PROVIDER=anthropic

# Only the chosen provider's vars need to be valid; others can be omitted.
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-4-7

OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

QVAC_BASE_URL=http://localhost:11434/v1
QVAC_MODEL=QWEN3_600M_INST_Q4
```

The Zod env schema in `apps/web/src/env.ts` should validate `MODEL_PROVIDER` as the three-element enum, and conditionally require the matching key — but conditional `t3-env` is awkward; simpler is to make all of them optional and fail fast in `modelFor()` with a clear error if the chosen provider's key is missing.

## Pitfalls

### `qvac serve openai` not running

The chat route gets a `fetch failed` / `ECONNREFUSED 127.0.0.1:11434`. The fix is to start the server. Treat it like Postgres: a local prereq, documented in the handbook. Don't auto-start it from the dev script — that hides startup failures.

### First request takes 30s+

QVAC downloads the model on first `loadModel`. Subsequent calls are warm. For demos, pre-warm by sending a small request after `qvac serve openai` boots.

### Tool-call JSON malformed

Smaller models hallucinate tool arguments. Symptoms: AI SDK throws on tool-call parse, or `evaluate()` rejects with `deny` (e.g., negative amount, unknown venue, malformed Solana address — all caught by the existing Zod schemas). Either case is *correct* trust-boundary behavior. Don't relax the Zod regex to "make it work" — log the malformed call to `audit_logs` (`kind: 'agent_tool_call_invalid'`) and use a better model.

### Small model emits the tool call as prose, not as a structured call

Distinct from "malformed JSON" — the model produces a JSON-shaped *string* in its assistant message instead of using the chat-completions `tool_calls` field. Symptoms: the chat UI shows what looks like a tool call, but no `proposed_actions` row is written and there's no `tool-*` part in the streamed response. Verified observation with `QWEN3_600M_INST_Q4` on the QWEN_2_5_7B-class tasks. The trust boundary is unaffected (no row = no risk), but UX silently degrades. Switch to a larger model (8B+) before drawing demo conclusions about your prompts or your tool definitions — it's the model, not your code.

### Production deployment

Vercel can't host QVAC. If you want QVAC in non-local environments, run `qvac serve openai` on a long-lived host (Railway alongside the worker, or a dedicated box), and point `QVAC_BASE_URL` at that. For dev, local-only is fine and is the whole point.

### Mixing local model output with policy decisions

QVAC's appeal is privacy — but the moment a model proposes `{ kind: 'deposit', amountUsdc: '1000', ... }`, that proposal still flows through `policy.evaluate(action, context)`. The model never sees the policy or the trust boundary. Don't be tempted to skip `evaluate` "because the model is local and trusted" — local doesn't mean correct. Hallucinations happen on-device too.

## Treasury Copilot–specific patterns

**Default to `anthropic` in `.env.example`.** It's the easiest to get working (one API key) and the production default. QVAC is opt-in for privacy-sensitive operators.

**Audit the model provider used for each proposal.** When `insertProposedAction` writes the audit log, include the active `MODEL_PROVIDER` in the audit `payload`. After the fact you want to be able to answer "did model X ever auto-approve a deposit?" without running git archaeology.

**Don't lock into a single provider's quirks.** Resist using Anthropic-specific features (cache control, computer use) in the agent-tools layer. The Vercel AI SDK abstraction is what makes QVAC swappable; bleeding through provider-specific options breaks that.
