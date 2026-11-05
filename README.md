# Earnings Intelligence Agent

Watches a list of tickers, reads each earnings press release and SEC filing, and produces a factual, fully cited brief. The brief covers what beat or missed, how guidance moved, and what management said, and every number links to the passage it came from. It makes no recommendations. The design is in `Earnings Intelligence Agent HLD and LLD.html`. The build plan, with the agreed changes to that design, is summarised below.

For the project's scope, its users and the AI tools it uses, see the [project overview](docs/OVERVIEW.md).

All five phases of the MVP are built. Extraction and briefs have run against a real model on a small set of reports; see "Live results" and "Not yet verified on real data" below.

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
- Structured extraction through the gateway, using the versioned prompt `extract.v2`. A press release is read whole; a 10-Q or 10-K is read by its MD&A section, in windows of up to 24k tokens.
- A validator checks every item in plain code: the quote is found verbatim, the value appears in the quote or is confirmed by EDGAR company facts within 0.5%, the figure is sane, and it agrees with the headline-table regex pre-pass.
- One retry carries the specific errors. What still fails goes to the `review_items` queue. Validated items below the 0.85 confidence threshold wait as pending.
- Review API (`GET /review`, `PATCH /review/:kind/:id`), and `POST /events/:id/reprocess` to requeue parsing or extraction.
- A keyboard-first review screen at `/review` in the Next.js app. Every correction is saved to `data/golden/<ticker>-<period>/`.

**Phase 4 (compare and briefs) is done.**
- A pure compare service in decimal arithmetic. It calls beat, miss or in line against materiality bands (±1% revenue, ±2% EPS, ±0.5 pt margins), with the band edge counting as in line. It labels guidance raised, lowered, maintained, narrowed, widened, new or withdrawn from two stored rows, records the inputs behind each label, and never infers a direction from qualitative guidance.
- Q4 is derived as the full year minus the nine-month year to date (fix 6), and marked as derived.
- Briefs are written from a fact sheet of compared, approved facts only. A post-check requires every figure to be a cited fact-sheet value, every cited ID to exist, and no recommendation language. A failed draft is regenerated once, then the brief is withheld. With `STRONG_MODEL` set, the model writes the brief (`brief.v2`); otherwise a deterministic template does, through the same check.
- Briefs are versioned, never edited in place, and every publication adds an alert.
- `GET /events/:id/brief`, `GET /briefs` and `GET /documents/:id/context`. The web pages `/briefs` and `/brief/[eventId]` open each citation's passage, highlighted in its source document.

**Phase 5 (week view, alerts, costs and eval) is done.**
- `GET /events/week`, `GET /alerts` (cursor-paged), `GET /admin/costs` and `GET /companies/:ticker`.
- Web pages: `/week` (the landing page, which also shows the age of the last discovery run), `/ticker/[symbol]` (event history and the guidance table, with what was delivered), `/alerts` and `/costs`.
- `pnpm eval` runs the real pipeline stages against `data/golden`. It reports extraction accuracy per metric (wrong values counted separately from missing ones), citation precision, false guidance changes (from hand-checked values, and end to end from extraction), Ask recall@5, and cost. It writes a dated report to `data/eval-reports/`. The gate fails the run on any false guidance change, any compare label error, citation precision below 100%, or a regression in accuracy or wrong values against the previous report.
- Golden set: 7 cases from real releases (4 NVIDIA quarters, 3 VST quarters), with 23 headline figures, 7 guidance items with expected labels (NVIDIA's quarterly outlooks are each new; VST's 2026 free-cash-flow range is new, then maintained twice), and 3 Ask questions. The values were taken from each release's headline table and outlook, and checked by eye against the source rows; please spot-check them before relying on the accuracy numbers. Every correction made in the review screen adds to this set.
- The web app is in Docker Compose (a standalone Next.js server on port 3000).

### Live results (gpt-5.5-2026-04-23)
On two golden cases (`NVDA-2027-Q2` and `VST-2026-Q2`):
- **Extraction accuracy:** 100% (6 of 6 headline figures, none wrong or missing).
- **Citation precision:** 100% (37 of 37).
- **False guidance changes:** 0 of 2, with both labelled guides extracted.
- **Usage:** about 1,000 output tokens per call at low reasoning effort.

**Fixed after the first live run:** the eval caught a false "lowered" label on VST's 2026 free-cash-flow guide. The release states that guide twice with different figures: $3,925–4,725M on the guidance line, and an adjusted $3,760–4,560M in a reconciliation table. Merging across windows had kept one of them silently. Now two different values for the same item go to review with both quotes, and the re-run shows no false guidance change.

**Fixed with `extract.v2`:** a first draft of this prompt told the model to use a table's consolidated column, which brought the false "lowered" back from that same reconciliation table. Guidance now has to come from the company's own statement, and the validator rejects multi-column rows. The number parser also read the second figure in "$3,925 - $4,725" as negative; a dash after a figure now counts as a range.

**Ask is still weak:** recall@5 is 33% (1 of 3) with embeddings on. All candidates score a cosine similarity of 0.69–0.75, so the vector channel barely separates them. NVIDIA's outlook sentence also sits in a long chunk alongside a "Highlights" list, which dilutes it. Tuning the score weights didn't help. The next step is chunking at sub-headings, or the reranker the design names.

### Not yet verified on real data
- The full 7-case eval (so far run on 2 cases).
- Model-written Ask answers.
- Model-written briefs, and checking real briefs' verdicts by hand (the Phase 4 exit test).

### Rate limits
Set `LLM_TPM_LIMIT` to your OpenAI tokens-per-minute limit for `STRONG_MODEL` (Settings > Limits). Calls are then paced under it, and extraction windows are sized so each request fits. `LLM_OUTPUT_RESERVE` (default 3000) is the output a call is expected to use. `EXTRACT_REASONING_EFFORT` (default `low`) controls how much hidden reasoning a reasoning model spends on extraction. `pnpm eval --cases=ID,...` runs a subset of cases, and a case that errors (a rate limit, for example) is recorded and fails the gate rather than crashing the run.

## Run it (Windows dev loop)
```bash
cp .env.example .env            # then set EDGAR_USER_AGENT to your name + email
pnpm install
pnpm db:up                      # Postgres 17 + pgvector in Docker, host port 55432
pnpm db:migrate
pnpm seed                       # loads WATCHLIST from .env
pnpm dev:worker                 # terminal 1
pnpm dev:api                    # terminal 2, http://localhost:8080
pnpm dev:web                    # terminal 3, http://localhost:3000 (API_URL defaults to :8080)
curl -X POST localhost:8080/admin/discover -H "content-type: application/json" -d "{}"
curl localhost:8080/companies/VST/events
curl -X POST localhost:8080/ask -H "content-type: application/json" -d "{\"question\":\"What did Vistra say about capital expenditures?\"}"
```
Ask needs `OPENAI_API_KEY` for embeddings, and `STRONG_MODEL` to write an answer. Without the key, it still returns citations from full-text search. If you add the key after filings were parsed, run `pnpm embed:backfill` to embed the existing chunks.
Extraction needs `OPENAI_API_KEY` and `STRONG_MODEL`. Without them, the extract job leaves documents at `parsed`. After setting them, requeue an event with `POST /events/:id/reprocess` and the body `{"stage":"extract"}`.
To run the full stack reproducibly, use `docker compose -f infra/docker-compose.yml up --build`. It starts the database, migrations, API, worker and web app, with the web app at http://localhost:3000.

## Tests and evaluation
`pnpm test` runs the unit tests and the integration tests. The integration tests run against the `eia_test` database, with EDGAR served from saved fixtures and a fake model. `pnpm typecheck` and `pnpm lint` cover the whole workspace.

`pnpm eval` runs the golden-set evaluation and exits non-zero if the gate fails. Run it after any prompt or model change, before making the change the default. `pnpm eval --no-model` skips extraction, and `--no-retrieval` skips Ask recall.

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
- **Capex is stored as a positive amount,** whichever sign the filing or the model uses. Other metrics keep their sign, so a loss stays a loss.
- **Guidance comes from the company's own statement of it.** A quote from a table row with more than three cells is rejected, because the column that holds "the guide" is ambiguous there. A guide stated only in a reconciliation table is therefore left out and needs adding by hand in review.
- **Briefs leave off year-to-date figures and table columns that aren't segments** (totals, eliminations, "Ongoing Operations"), and show at most 6 segments. A guide with no earlier record reads "first on record" when earlier quarters haven't been processed, not "new".
- **Consensus comes from the provider only:** with no `PROVIDER_API_KEY`, every verdict is `no_consensus`, and the brief compares results with the prior year instead. Finnhub's free tier covers EPS and revenue consensus only.
- **Brief verdicts compare consolidated quarterly figures only.** Year-to-date and segment figures are reported without a verdict.
- **Eval extraction runs offline:** it doesn't use company facts, so in the eval every value must appear in its quote.
- **Retrieval recall needs the corpus:** the eval measures Ask against whatever is ingested in the database. Questions about companies with no chunks are reported as unavailable, not as misses.
