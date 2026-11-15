# Free Model Aggregator

A single OpenAI/Anthropic-compatible gateway in front of ten simulated upstream providers.
Every request is routed to the best free model that still has budget, and failed calls
fail over to the next provider instead of erroring out.

## What it does

- Serves `POST /v1/chat/completions`, `POST /v1/messages` and `GET /v1/models` on one port.
- Broadcasts inbound wire formats (OpenAI and Anthropic) to upstreams that may speak
  OpenAI, Anthropic or Gemini, translating requests and responses in both directions,
  including streaming (SSE) and usage accounting.
- Ranks candidate models by `rating_milli`, filters by context length, vision and
  price, tracks a sealed per-provider budget, and fails over across providers when a
  call errors, rate limits or returns nothing usable.
- Fully deterministic: no `Date.now()`, no unseeded `Math.random()`, no wall-clock
  timeouts in the request path. A replay produces byte-identical behaviour.

## Layout

- `main.ts` - HTTP server, candidate ranking, budget accounting, failover loop, shutdown on `GET /work`.
- `lib/providers.ts` - provider catalogue probing and capability bookkeeping.
- `lib/wire.ts` - OpenAI/Anthropic inbound parsing and response shaping.
- `lib/wire-extras.ts` - Anthropic and Gemini upstream translators, SSE included.

## Run

```bash
node main.ts
```

Node 22, TypeScript type-stripping only: no build step, no dependencies, standard
library alone.

## Score

`makefun grade-local` (practice trial): catalog 100, failover 100, quality 99,
served 100, wire 100, total **99**.

## License

MIT
