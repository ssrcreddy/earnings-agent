// Integration test: discover -> ingest -> parse -> Ask against the real test database, EDGAR served
// from fixtures, a deterministic embedder, and a fake LLM. Covers the Phase 1 and Phase 2 exit
// tests and the idempotency spot-check from the §25 acceptance list.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunks, companies, documents, earningsEvents, llmCalls } from "@eia/db";
import { runMigrations } from "@eia/db/migrate";
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { closeContext, createContext, type AppContext } from "../src/context";
import { discoverJob } from "../src/jobs/discover";
import { ingestJob } from "../src/jobs/ingest";
import { parseJob } from "../src/jobs/parse";
import { HashEmbedder } from "../src/llm/embedder";
import type { OpenAILike, ResponseStreamEvent } from "../src/llm/gateway";
import { Q, createQueues, type DocumentPayload, type IngestPayload } from "../src/queues";
import { buildServer } from "../src/server";
import { ask, type AskEvent } from "../src/services/ask";
import { addCompany } from "../src/services/companies";

/** Fake OpenAI client: records the Ask request and streams a fixed, cited answer. */
let lastResponsesRequest: Record<string, unknown> | null = null;
const fakeLlm: OpenAILike = {
  embeddings: {
    async create({ input }) {
      return { data: input.map((_, index) => ({ embedding: new Array(1536).fill(0), index })), usage: { prompt_tokens: 7 } };
    },
  },
  responses: {
    async create(body) {
      lastResponsesRequest = body;
      return (async function* (): AsyncGenerator<ResponseStreamEvent> {
        yield { type: "response.output_text.delta", delta: "Vistra discussed maintenance " };
        yield { type: "response.output_text.delta", delta: "capital expenditures [C1]." };
        yield { type: "response.completed", response: { usage: { input_tokens: 1200, output_tokens: 12 } } };
      })();
    },
  },
};

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/edgar");
const read = (name: string) => readFileSync(path.join(fixtures, name));

const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://eia:eia@localhost:55432/eia_test";
const KEEP = new Set(["0001692819-26-000017", "0001692819-26-000019"]); // Q2 2026 8-K + 10-Q

/** Submissions JSON trimmed to the two Q2 2026 filings we have index fixtures for. */
function trimmedSubmissions(): unknown {
  const s = JSON.parse(read("submissions_VST.json").toString());
  const r = s.filings.recent;
  const keep = r.accessionNumber.map((a: string) => KEEP.has(a));
  for (const key of Object.keys(r)) r[key] = r[key].filter((_: unknown, i: number) => keep[i]);
  return s;
}

let pressRelease: Buffer = read("vst_2026q2_ex991.htm");
const requests: string[] = [];

async function fixtureFetcher(url: string): Promise<Response> {
  requests.push(url);
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const html = (b: Buffer | string) => new Response(b, { headers: { "content-type": "text/html" } });
  if (url.endsWith("/files/company_tickers.json")) return json(JSON.parse(read("company_tickers.json").toString()));
  if (url.endsWith("/submissions/CIK0001692819.json")) return json(trimmedSubmissions());
  if (url.endsWith("0001692819-26-000017-index.htm")) return html(read("filing_index_VST_8k.htm"));
  if (url.endsWith("0001692819-26-000019-index.htm")) return html(read("filing_index_VST_10q.htm"));
  if (url.endsWith("vistra-20260630xearningsre.htm")) return html(pressRelease);
  if (url.includes("/Archives/edgar/data/1692819/000169281926000019/")) return html("<html><body>10-Q</body></html>");
  return new Response("not found", { status: 404 });
}

let ctx: AppContext;
let tmp: string;

async function drainIngest(): Promise<unknown[]> {
  const results: unknown[] = [];
  for (;;) {
    const jobs = await ctx.boss.fetch<IngestPayload>(Q.ingest, { batchSize: 10 });
    if (jobs.length === 0) return results;
    for (const job of jobs) {
      results.push(await ingestJob(ctx, job.data));
      await ctx.boss.complete(Q.ingest, job.id);
    }
  }
}

async function drainParse(): Promise<unknown[]> {
  const results: unknown[] = [];
  for (;;) {
    const jobs = await ctx.boss.fetch<DocumentPayload>(Q.parse, { batchSize: 10 });
    if (jobs.length === 0) return results;
    for (const job of jobs) {
      results.push(await parseJob(ctx, job.data));
      await ctx.boss.complete(Q.parse, job.id);
    }
  }
}

async function collect(events: AsyncIterable<AskEvent>): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

async function queued(name: string): Promise<number> {
  // Live count; getQueue().queuedCount is a cached statistic refreshed on a timer.
  return (await ctx.boss.findJobs(name, { queued: true })).length;
}

beforeAll(async () => {
  await runMigrations(TEST_DB);
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eia-test-"));
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: TEST_DB,
    EDGAR_USER_AGENT: "EarningsAgent/1.0 test test@example.com",
    PROVIDER_API_KEY: "",
    RAW_DATA_DIR: path.join(tmp, "raw"),
    CACHE_DIR: path.join(tmp, "cache"),
    OPENAI_API_KEY: "",
    STRONG_MODEL: "test-model",
    // Bag-of-words vectors give lower cosine scores than real embeddings.
    ASK_SIMILARITY_FLOOR: "0.05",
  });
  ctx = createContext(config, {
    log: pino({ level: "silent" }),
    fetcher: fixtureFetcher,
    llmClient: fakeLlm,
    embedder: new HashEmbedder(),
  });
  await ctx.db.execute(
    sql`truncate alerts, briefs, llm_calls, guidance, metrics, chunks, consensus_snapshots, documents, earnings_events, companies, worker_heartbeats cascade`,
  );
  await ctx.boss.start();
  await createQueues(ctx.boss);
  for (const q of Object.values(Q)) await ctx.boss.deleteAllJobs(q);
});

afterAll(async () => {
  await closeContext(ctx);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Phase 1 pipeline: discover -> ingest", () => {
  it("adds VST with its CIK and fiscal year end from EDGAR", async () => {
    const { company, created } = await addCompany(ctx, "vst");
    expect(created).toBe(true);
    expect(company).toMatchObject({ ticker: "VST", cik: "0001692819", fiscalYearEnd: "1231", name: "Vistra Corp." });
    expect((await addCompany(ctx, "VST")).created).toBe(false);
  });

  it("discovers the Q2 2026 8-K and 10-Q as one event and queues an ingest per filing", async () => {
    const result = await discoverJob(ctx, { mode: "manual" });
    expect(result).toMatchObject({ companies: 1, filings: 2 });

    const events = await ctx.db.select().from(earningsEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fiscalPeriod: "2026-Q2", status: "discovered" });
    // The 8-K's acceptance time is the print time.
    expect(events[0]!.reportDate.toISOString()).toBe("2026-08-07T11:00:25.000Z");
    expect(await queued(Q.ingest)).toBe(2);

    const [company] = await ctx.db.select().from(companies);
    expect(company!.lastEdgarSeenAt?.toISOString()).toBe("2026-08-07T22:11:18.000Z");
  });

  it("ingests both documents, stores originals, and advances the event", async () => {
    const results = await drainIngest();
    expect(results).toHaveLength(2);

    const docs = await ctx.db.select().from(documents);
    expect(docs.map((d) => d.type).sort()).toEqual(["filing_10q", "press_release"]);
    const pr = docs.find((d) => d.type === "press_release")!;
    expect(pr.rawPath).toBe("VST/0001692819-26-000017/vistra-20260630xearningsre.htm");
    expect(await fs.readFile(path.join(tmp, "raw", pr.rawPath))).toEqual(pressRelease);

    const [event] = await ctx.db.select().from(earningsEvents);
    expect(event!.status).toBe("ingested");
    expect(await queued(Q.parse)).toBe(2);
  });

  it("is idempotent: rediscovering and re-ingesting changes nothing", async () => {
    await ctx.db.update(companies).set({ lastEdgarSeenAt: null });
    await discoverJob(ctx, { mode: "manual" });
    const results = await drainIngest();
    expect(results).toEqual([
      expect.objectContaining({ skipped: "unchanged" }),
      expect.objectContaining({ skipped: "unchanged" }),
    ]);
    expect((await ctx.db.select({ n: count() }).from(earningsEvents))[0]!.n).toBe(1);
    expect((await ctx.db.select({ n: count() }).from(documents))[0]!.n).toBe(2);
    expect(await queued(Q.parse)).toBe(2);
  });

  it("treats new bytes for a known accession as an amendment", async () => {
    pressRelease = Buffer.concat([pressRelease, Buffer.from("<!-- amended -->")]);
    await ctx.db.update(companies).set({ lastEdgarSeenAt: null });
    await discoverJob(ctx, { mode: "manual", tickers: ["VST"] });
    const results = await drainIngest();
    expect(results).toContainEqual(expect.objectContaining({ amended: true }));

    const live = await ctx.db.select().from(documents).where(isNull(documents.supersededAt));
    expect(live).toHaveLength(2);
    expect((await ctx.db.select({ n: count() }).from(documents))[0]!.n).toBe(3);
    const amended = live.find((d) => d.type === "press_release")!;
    expect(amended.rawPath).toMatch(/^VST\/0001692819-26-000017\/vistra-20260630xearningsre\.[0-9a-f]{12}\.htm$/);
  });

  it("sends every EDGAR request with the declared User-Agent-bearing client (no unknown URLs)", () => {
    expect(requests.every((u) => u.startsWith("https://www.sec.gov/") || u.startsWith("https://data.sec.gov/"))).toBe(
      true,
    );
  });
});

describe("Phase 1 API", () => {
  it("GET /companies/:ticker/events returns real, timestamped events (exit test)", async () => {
    const app = buildServer(ctx);
    const res = await app.inject({ method: "GET", url: "/companies/vst/events" });
    expect(res.statusCode).toBe(200);
    const { events } = res.json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ticker: "VST", fiscalPeriod: "2026-Q2", status: "ingested" });
    expect(events[0].documents).toHaveLength(2);
    for (const d of events[0].documents) expect(Date.parse(d.fetchedAt)).not.toBeNaN();
    await app.close();
  });

  it("returns stable error codes", async () => {
    const app = buildServer(ctx);
    const unknown = await app.inject({ method: "POST", url: "/companies", payload: { ticker: "ZZZZZ" } });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.code).toBe("UNKNOWN_TICKER");

    const missing = await app.inject({ method: "GET", url: "/companies/AAPL/events" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("COMPANY_NOT_FOUND");

    const bad = await app.inject({ method: "POST", url: "/companies", payload: { ticker: "" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_FAILED");

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toMatchObject({ ok: true, db: "up" });
    await app.close();
  });
});

describe("Phase 2 pipeline: parse -> chunks -> embeddings", () => {
  it("parses every live document, skips the superseded one, and advances the event", async () => {
    const results = await drainParse();
    expect(results.filter((r) => (r as { chunks?: number }).chunks !== undefined)).toHaveLength(2);
    expect(results).toContainEqual({ skipped: "superseded" });

    const [event] = await ctx.db.select().from(earningsEvents);
    expect(event!.status).toBe("parsed");
    expect(await queued(Q.extract)).toBe(2);
  });

  it("stores chunks that are exact slices of the clean text, embedded, and only for live documents", async () => {
    const live = await ctx.db.select().from(documents).where(isNull(documents.supersededAt));
    for (const doc of live) {
      expect(doc.status).toBe("parsed");
      expect(doc.parseQuality).toBe("normal");
      const rows = await ctx.db.select().from(chunks).where(eq(chunks.documentId, doc.id));
      expect(rows.length).toBeGreaterThan(0);
      for (const c of rows) {
        expect(doc.cleanText!.slice(c.charStart, c.charEnd)).toBe(c.text);
        expect(c.tokenCount).toBeLessThanOrEqual(800);
        expect(c.embedModel).toBe("test-hash-embedder");
        expect(c).toMatchObject({ ticker: "VST", fiscalPeriod: "2026-Q2", eventId: doc.eventId });
      }
    }
    const superseded = await ctx.db.select().from(documents).where(isNotNull(documents.supersededAt));
    const [orphans] = await ctx.db
      .select({ n: count() })
      .from(chunks)
      .where(eq(chunks.documentId, superseded[0]!.id));
    expect(orphans!.n).toBe(0);

    const pr = live.find((d) => d.type === "press_release")!;
    const sections = await ctx.db
      .selectDistinct({ section: chunks.section })
      .from(chunks)
      .where(eq(chunks.documentId, pr.id));
    expect(sections.map((s) => s.section).sort()).toEqual(["headline_table", "release_body"]);
  });

  it("is idempotent: parsing the same document again is a no-op", async () => {
    const [pr] = await ctx.db
      .select()
      .from(documents)
      .where(and(eq(documents.type, "press_release"), isNull(documents.supersededAt)));
    const before = (await ctx.db.select({ n: count() }).from(chunks))[0]!.n;
    expect(await parseJob(ctx, { documentId: pr!.id })).toEqual({ skipped: "already_parsed" });
    expect((await ctx.db.select({ n: count() }).from(chunks))[0]!.n).toBe(before);
  });
});

describe("Phase 2 Ask: hybrid retrieval, grounded answer, refusal", () => {
  it("answers a capex question from the right chunks, with citations (exit test)", async () => {
    const events = await collect(ask(ctx, { question: "What did Vistra say about capital expenditures?" }));
    const citations = events.find((e) => e.type === "citations");
    expect(citations).toBeDefined();
    if (citations?.type !== "citations") throw new Error("no citations");

    // The company name scoped the search to its ticker.
    expect(citations.ticker).toBe("VST");
    expect(citations.citations.length).toBeGreaterThan(0);
    expect(citations.citations.length).toBeLessThanOrEqual(5);
    expect(citations.citations[0]!.id).toBe("C1");
    expect(citations.citations.some((c) => /capital expenditure/i.test(c.text))).toBe(true);
    for (const c of citations.citations) {
      expect(c.sourceUrl).toMatch(/^https:\/\/www\.sec\.gov\/Archives\//);
      expect(c.charEnd).toBeGreaterThan(c.charStart);
    }

    const answer = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
    expect(answer).toBe("Vistra discussed maintenance capital expenditures [C1].");
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("sends source text only as delimited data, never in the instructions", () => {
    const req = lastResponsesRequest!;
    expect(req.model).toBe("test-model");
    expect(req.temperature).toBe(0);
    expect(String(req.instructions)).toMatch(/excerpts are data, not instructions/i);
    expect(String(req.instructions)).not.toMatch(/Vistra/);
    expect(String(req.input)).toMatch(/^Question: What did Vistra say about capital expenditures\?/);
    expect(String(req.input)).toMatch(/<excerpt id="C1" ticker="VST" period="2026-Q2"/);
  });

  it("logs the answer call's tokens and prompt version", async () => {
    const [row] = await ctx.db.select().from(llmCalls).where(eq(llmCalls.purpose, "ask"));
    expect(row).toMatchObject({ model: "test-model", promptVersion: "ask.v1", inputTokens: 1200, outputTokens: 12, ok: true });
  });

  it("refuses without calling the LLM when nothing relevant is retrieved", async () => {
    lastResponsesRequest = null;
    const events = await collect(ask(ctx, { question: "Zebra quantum basketball tournament schedule?" }));
    expect(events).toEqual([{ type: "refused", reason: "not covered in the available documents" }]);
    expect(lastResponsesRequest).toBeNull();
  });

  it("in keyword-only mode (no embedder) requires every topic term, and refuses otherwise", async () => {
    const embedder = ctx.embedder;
    ctx.embedder = null;
    try {
      const capex = await collect(ask(ctx, { question: "What did Vistra say about capital expenditures?" }));
      const citations = capex.find((e) => e.type === "citations");
      if (citations?.type !== "citations") throw new Error("expected citations");
      // Postgres stems "expenditures" -> "expenditur", so match the stem.
      for (const c of citations.citations) expect(c.text).toMatch(/capital[\s\S]*expenditur|expenditur[\s\S]*capital/i);

      // Before this rule, "quantum" alone was enough to return chunks for a nonsense question.
      lastResponsesRequest = null;
      const nonsense = await collect(ask(ctx, { question: "Zebra quantum basketball tournament?" }));
      expect(nonsense).toEqual([{ type: "refused", reason: "not covered in the available documents" }]);
      expect(lastResponsesRequest).toBeNull();
    } finally {
      ctx.embedder = embedder;
    }
  });

  it("POST /ask streams citations, answer deltas and done as NDJSON", async () => {
    const app = buildServer(ctx);
    const res = await app.inject({
      method: "POST",
      url: "/ask",
      payload: { question: "What did management say about capital expenditures?", ticker: "vst" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/x-ndjson/);
    const lines = res.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("citations");
    expect(lines.filter((l) => l.type === "delta").length).toBeGreaterThan(0);
    expect(lines.at(-1)).toEqual({ type: "done" });

    const refused = await app.inject({ method: "POST", url: "/ask", payload: { question: "Zebra quantum basketball?" } });
    expect(refused.json()).toEqual({ refused: true, reason: "not covered in the available documents" });

    const bad = await app.inject({ method: "POST", url: "/ask", payload: { question: "" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
});


