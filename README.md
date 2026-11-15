# Free Model Aggregator

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/mletretros/free-model-aggregator/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/mletretros/free-model-aggregator/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

Entry for the [make.fun](https://make.fun/bounty/free-model-aggregator-01) bounty "The best free AI model aggregator".

This repository contains an entry for the `free-model-aggregator-01` competition. The server acts as a unified translation and routing gateway over a simulated directory of free-tier AI providers. 

## What the Server Does

The server listens on an ephemeral port assigned by the OS, parsing a provided prompt file containing simulated provider details, available models, quality ratings, and a client workload manifest. It probes each provider to build an aggregated catalog, registers this catalog with the competition environment, and then handles client traffic by matching each request against the capabilities of the upstream free models. Finally, it polls the environment for completion and exits cleanly when instructed.

## Wire Formats

The server exposes two client-facing wire formats:
- **OpenAI-compatible endpoints:** `GET /v1/models` and `POST /v1/chat/completions` (triggered by Bearer authorization).
- **Anthropic-compatible endpoints:** `GET /v1/models` and `POST /v1/messages` (triggered by x-api-key authorization).

It seamlessly translates these inbound requests into the specific dialects of the upstream providers, and correspondingly maps the upstream provider responses (both static JSON and SSE streams) back into the format the client originally requested.

## Upstream Wire Dialects

The aggregator translates client requests into three distinct upstream provider dialects depending on the selected free model:
1. **OpenAI:** Uses standard Chat Completions JSON payloads and Server-Sent Event (SSE) streams.
2. **Anthropic:** Transforms requests into the Messages API structure and handles the granular content block streaming events natively.
3. **Gemini:** Translates into the Gemini REST JSON structure, manipulating tool calls and streaming responses back into a consistent shape.

## Ranking and Budget Rules

When a request arrives, the server extracts its required capabilities (e.g., vision, tools, minimum context length, JSON schema support). It filters the catalog for free-tier models that fulfill these requirements. The valid candidates are then sorted by their `rating_milli` (from the quality table) in descending order to prioritize high-quality responses. 
To prevent exhausting provider limits, the server maintains an active tally of calls made to each provider and restricts routing to a hardcoded per-provider `BUDGET`. If a provider is at or over its budget, it is excluded from consideration for that request.

## Failover Rule

For every request, the server attempts to contact the top-ranked available provider. If the upstream provider responds with an error indicating rate-limits or unavailability (specifically HTTP 402, 429, or 5xx codes), the server catches the error and immediately retries the request against the next best available provider in the candidate list. This continues until a successful response is achieved or all candidates are exhausted.

## Determinism

The core model listing routes in `lib/wire.ts` use hardcoded fixed epoch timestamps to ensure byte-for-byte determinism for those documents. (Note: Translation routines for Anthropic/Gemini responses in `lib/wire-extras.ts` may currently generate dynamic IDs or timestamps, though basic Chat Completions routes preserve determinism.)

## File Map

- `main.ts`: The core server implementation handling HTTP routing, provider probing, catalog registration, failover logic, and polling.
- `lib/providers.ts`: Logic to parse the prompt file, load the directory, verify model capabilities, and probe endpoints.
- `lib/wire.ts`: Translation helpers for Anthropic-to-OpenAI mappings and OpenAI-to-Anthropic mappings.
- `lib/wire-extras.ts`: Advanced translation helpers encompassing OpenAI-to-Gemini round-trips and comprehensive request/response mappings.

## How to Run

Ensure you are using Node.js 22. To list the catalog:
```bash
node main.ts --list
```
To run the server against an environment:
```bash
MAKEFUN_ENV_URL=<url> MAKEFUN_PROMPT_FILE=<path> node main.ts
```

## Local Score

On the local grader, this aggregator currently achieves a total score of **99**. The exact column breakdown is:
`{"catalog":100,"failover":100,"quality":99,"score":99,"served":100,"upstream_calls":25,"wire":100,"working":1}`
