// Next.js calls `register()` once at server startup, before any route
// module is loaded and before Next patches `globalThis.fetch` per
// request (see node_modules/next/.../patch-fetch.js — patchFetch wraps
// the global with caching/dedupe layers and the dedupe path can replace
// response.body via clone-response.tee, leaving it without WebStream
// methods like `pipeThrough`).
//
// We snapshot the truly-native fetch here and stash it on `globalThis`
// so route handlers (specifically `apps/web/src/lib/ai/model.ts`) can
// reach it without going through Next's wrapper. Streaming AI responses
// (Anthropic SSE) need `response.body.pipeThrough(...)` to work, which
// only the native fetch reliably provides.
declare global {
  var __TC_NATIVE_FETCH__: typeof fetch | undefined;
}

export async function register() {
  if (typeof globalThis.fetch === 'function' && !globalThis.__TC_NATIVE_FETCH__) {
    globalThis.__TC_NATIVE_FETCH__ = globalThis.fetch.bind(globalThis);
  }
}
