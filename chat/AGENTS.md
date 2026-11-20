# Agent instructions — NetLogo Chat Platform

Read `docs/ARCHITECTURE.md` first. It is the binding design. Do not reintroduce NetLogo Desktop,
the JVM, `netlogo-mcp`, Python, or iframe-reload-with-`?v=`. The platform uses **NetLogo Web only**.

## Working rules
- Implement phase by phase (ARCHITECTURE §9). Do not start a phase until the previous phase's
  acceptance check passes. Report which checks you ran.
- Phase 0 is mandatory. Verify the postMessage protocol against the actual self-hosted
  NetLogo Web file and write `docs/nlw-protocol.md` before writing `client/nlw/bridge.ts`.
  The source of truth is `github.com/NetLogo/Galapagos` (`app/assets/javascripts/pages/simulation.js`,
  `queries/iframe-query-handler.coffee`, `notifications/listener-events.coffee`, `settings.coffee`).
- Copy widget XML element and attribute names from golden `.nlogox` files in `github.com/NetLogo/models`.
  Never guess them.
- The LLM never writes XML. It edits `ModelSpec` through tools only.
- All postMessage code lives in `src/client/nlw/`. All LLM-provider code lives in `src/app/api/llm/` and `src/lib/prompt.ts`.
- Secrets: `LLM_API_KEY` stays in `.env.local` (gitignored) and is read only on the server.
- TypeScript strict, no `any` in exported types, zod at every boundary (env, API bodies, tool args).
- Run `npm run lint && npm run typecheck && npm test` before declaring a phase done.

## Commands (create these scripts)
- `npm run dev` → `next dev -H 127.0.0.1`
- `npm run fetch-nlw` → `scripts/fetch-nlw.sh` (also runs on `postinstall` when the file is missing)
- `npm test` → vitest, `npm run e2e` → playwright (mocked `/api/llm`)

## Environment facts (this machine)
- Node 22 is installed. No Java and no Ollama are needed.
- LLM: vLLM serving `Qwen3.8-27b`, OpenAI-compatible, on port 8000 of the GPU host, with
  tool calling enabled (`qwen3_coder` parser). The user provides the host and API key.
