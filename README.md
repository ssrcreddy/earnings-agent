# Earnings Intelligence Agent

Watches a list of tickers, reads each earnings press release and SEC filing, and (from Phase 3) produces a factual, fully cited brief. The design is in `Earnings Intelligence Agent HLD and LLD.html`. The build plan, with the agreed changes to that design, is summarised below.

## Status
**Phase 1 (scaffold and data layer) is done.**
- EDGAR discovery and ingestion
- Per-document status (fix 9)
- Fiscal-period mapping (fix 4)
- Transactional job enqueue (fix 10)
- Amendment handling
- The `/companies` and `/companies/:ticker/events` endpoints

**Phase 2 (parsing, chunking and Ask) is done.**
- HTML cleaner that linearises tables, plus a PDF fallback
- Section labels: headline table, release body, MD&A, risk factors
- Token-aware chunker: 300–800 tokens, about 80 tokens of overlap, exact character offsets
- Embeddings through the LLM gateway, with every call's tokens and cost logged to `llm_calls`
- Hybrid retrieval (vector plus full-text) behind `POST /ask`, which streams NDJSON or refuses

Phases 3–5 (extraction and review, compare and briefs, UI and eval) are next.

## Run it (Windows dev loop)
```bash
cp .env.example .env            # then set EDGAR_USER_AGENT to your name + email
pnpm install
pnpm db:up                      # Postgres 17 + pgvector in Docker, host port 55432
pnpm db:migrate
pnpm seed                       # loads WATCHLIST from .env
pnpm dev:worker                 # terminal 1
pnpm dev:api                    # terminal 2, http://localhost:8080
curl -X POST localhost:8080/admin/discover -H "content-type: application/json" -d "{}"
curl localhost:8080/companies/VST/events
curl -X POST localhost:8080/ask -H "content-type: application/json" -d "{\"question\":\"What did Vistra say about capital expenditures?\"}"
```
Ask needs `OPENAI_API_KEY` for embeddings, and `STRONG_MODEL` to write an answer. Without the key, it still returns citations from full-text search. If you add the key after filings were parsed, run `pnpm embed:backfill` to embed the existing chunks.
To run the full stack reproducibly: `docker compose -f infra/docker-compose.yml up --build`.

## Tests
`pnpm test` runs the unit tests and the integration tests. The integration tests run against the `eia_test` database, with EDGAR served from saved fixtures. `pnpm typecheck` and `pnpm lint` cover the whole workspace.

## Notes and known limits
- **EDGAR rate limit:** the 8 req/s limit is enforced per process, so run exactly one worker (fix 7).
- **No provider key:** without `PROVIDER_API_KEY`, no consensus snapshot is taken, and beat/miss will report `no_consensus`.
- **Transcripts:** off for the MVP (`TRANSCRIPTS_ENABLED=false`).
- **Port 55432:** the Docker database uses host port 55432, because a local Postgres already holds 5433.
- **Ask without embeddings:** keyword-only retrieval requires every topic word of the question to match, and refuses otherwise, because there is no similarity floor to catch irrelevant hits.
- **Cost logging:** chat-model prices aren't built in. Set `LLM_PRICES_JSON` for the models you choose, or their calls are logged at cost 0.
