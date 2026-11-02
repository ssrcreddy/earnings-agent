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

**Phase 3 (extraction and review) is done.**
- Structured extraction through the gateway, using the versioned prompt `extract.v1`. A press release is read whole; a 10-Q or 10-K is read by its MD&A section, in windows of up to 24k tokens.
- A validator checks every item in plain code: the quote is found verbatim, the value appears in the quote or is confirmed by EDGAR company facts within 0.5%, the figure is sane, and it agrees with the headline-table regex pre-pass.
- One retry carries the specific errors. What still fails goes to the `review_items` queue. Validated items below the 0.85 confidence threshold wait as pending.
- Review API (`GET /review`, `PATCH /review/:kind/:id`), and `POST /events/:id/reprocess` to requeue parsing or extraction.
- A keyboard-first review screen at `/review` in the Next.js app. Every correction is saved to `data/golden/<ticker>-<period>/`.

**Phase 4 (compare and briefs) is done.**
- A pure compare service in decimal arithmetic. It calls beat, miss or in line against materiality bands (±1% revenue, ±2% EPS, ±0.5 pt margins), with the band edge counting as in line. It labels guidance raised, lowered, maintained, narrowed, widened, new or withdrawn from two stored rows, records the inputs behind each label, and never infers a direction from qualitative guidance.
- Q4 is derived as the full year minus the nine-month year to date (fix 6), and marked as derived.
- Briefs are written from a fact sheet of compared, approved facts only. A post-check requires every figure to be a cited fact-sheet value, every cited ID to exist, and no recommendation language. A failed draft is regenerated once, then the brief is withheld. With `STRONG_MODEL` set, the model writes the brief (`brief.v1`); otherwise a deterministic template does, through the same check.
- Briefs are versioned, never edited in place, and every publication adds an alert.
- `GET /events/:id/brief`, `GET /briefs` and `GET /documents/:id/context`. The web pages `/briefs` and `/brief/[eventId]` open each citation's passage, highlighted in its source document.

Phase 5 (the week view, alerts feed, cost view and eval harness) is next.

## Run it (Windows dev loop)
```bash
cp .env.example .env            # then set EDGAR_USER_AGENT to your name + email
pnpm install
pnpm db:up                      # Postgres 17 + pgvector in Docker, host port 55432
pnpm db:migrate
pnpm seed                       # loads WATCHLIST from .env
pnpm dev:worker                 # terminal 1
pnpm dev:api                    # terminal 2, http://localhost:8080
pnpm dev:web                    # terminal 3, http://localhost:3000/review (API_URL defaults to :8080)
curl -X POST localhost:8080/admin/discover -H "content-type: application/json" -d "{}"
curl localhost:8080/companies/VST/events
curl -X POST localhost:8080/ask -H "content-type: application/json" -d "{\"question\":\"What did Vistra say about capital expenditures?\"}"
```
Ask needs `OPENAI_API_KEY` for embeddings, and `STRONG_MODEL` to write an answer. Without the key, it still returns citations from full-text search. If you add the key after filings were parsed, run `pnpm embed:backfill` to embed the existing chunks.
Extraction needs `OPENAI_API_KEY` and `STRONG_MODEL`. Without them, the extract job leaves documents at `parsed`. After setting them, requeue an event with `POST /events/:id/reprocess` and the body `{"stage":"extract"}`.
To run the full stack reproducibly: `docker compose -f infra/docker-compose.yml up --build`. The web app isn't in Compose yet; it arrives with Phase 5.

## Tests
`pnpm test` runs the unit tests and the integration tests. The integration tests run against the `eia_test` database, with EDGAR served from saved fixtures. `pnpm typecheck` and `pnpm lint` cover the whole workspace.

## Notes and known limits
- **EDGAR rate limit:** the 8 req/s limit is enforced per process, so run exactly one worker (fix 7).
- **No provider key:** without `PROVIDER_API_KEY`, no consensus snapshot is taken, and beat/miss will report `no_consensus`.
- **Transcripts:** off for the MVP (`TRANSCRIPTS_ENABLED=false`).
- **Port 55432:** the Docker database uses host port 55432, because a local Postgres already holds 5433.
- **Ask without embeddings:** keyword-only retrieval requires every topic word of the question to match, and refuses otherwise, because there is no similarity floor to catch irrelevant hits.
- **Cost logging:** chat-model prices aren't built in. Set `LLM_PRICES_JSON` for the models you choose, or their calls are logged at cost 0.
- **10-Q/10-K extraction reads MD&A only:** figures that appear only in the financial statements are left to the press release. A filing with no MD&A heading found is read whole.
- **Review list:** `GET /review` returns the oldest 50 items and the total. Cursor pagination is still to do.
- **Human decisions stick:** re-extraction never overwrites an approved or corrected value, and never reopens a rejected item.
- **Consensus comes from the provider only:** with no `PROVIDER_API_KEY`, every verdict is `no_consensus`, and the brief compares results with the prior year instead. Finnhub's free tier covers EPS and revenue consensus only.
- **Brief verdicts compare consolidated quarterly figures only.** Year-to-date and segment figures are reported without a verdict.
