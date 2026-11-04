// Integration test: discover -> ingest -> parse -> Ask -> extract -> review against the real test
// database, EDGAR served from fixtures, a deterministic embedder, and a fake LLM. Covers the Phase 1-3
// exit tests and the idempotency spot-check from the §25 acceptance list.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  alerts,
  briefs,
  chunks,
  companies,
  consensusSnapshots,
  documents,
  earningsEvents,
  guidance,
  llmCalls,
  metrics,
  reviewItems,
} from "@eia/db";
import { runMigrations } from "@eia/db/migrate";
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { closeContext, createContext, type AppContext } from "../src/context";
import { discoverJob } from "../src/jobs/discover";
import { ingestJob } from "../src/jobs/ingest";
import { compareAndBriefJob } from "../src/jobs/compareAndBrief";
import { extractJob } from "../src/jobs/extract";
import { parseJob } from "../src/jobs/parse";
import { HashEmbedder } from "../src/llm/embedder";
import type { OpenAILike, ResponseObject, ResponseStreamEvent } from "../src/llm/gateway";
import { Q, createQueues, type DocumentPayload, type IngestPayload } from "../src/queues";
import { buildServer } from "../src/server";
import { ask, type AskEvent } from "../src/services/ask";
import { addCompany } from "../src/services/companies";

/** The VST Q2 2026 headline-table row: $305M this quarter, $327M a year ago, $1,334M six months. */
const NET_INCOME_ROW = "Net income | $305 | $327 | $1,334 | $59";
const FCF_GUIDE =
  "Ongoing Operations Adjusted FCFbG1 guidance ranges of $6.8 billion to $7.6 billion and $3.925 billion to $4.725 billion";

/**
 * What the fake model "extracts" from the press release - the same both attempts, like a stubborn model:
 * - net income read from the prior-year column (327): in its quote, but the headline table says 305
 * - six-month net income at low confidence: valid, but goes to review as pending
 * - operating income with a made-up quote: fails the quote check
 * - adjusted FCF guidance range: valid and confident
 */
const PRESS_RELEASE_EXTRACTION = {
  metrics: [
    { name: "net_income", segment: null, value: 327e6, unit: "usd", periodType: "quarter", quote: NET_INCOME_ROW, confidence: 0.9 },
    { name: "net_income", segment: null, value: 1334e6, unit: "usd", periodType: "ytd", quote: NET_INCOME_ROW, confidence: 0.6 },
    {
      name: "op_income",
      segment: null,
      value: 512e6,
      unit: "usd",
      periodType: "quarter",
      quote: "Operating income was $512 million in the second quarter",
      confidence: 0.9,
    },
  ],
  guidance: [
    { metric: "fcf", kind: "range", low: 3.925e9, high: 4.725e9, targetPeriod: "2026-FY", quote: FCF_GUIDE, confidence: 0.92 },
  ],
};

const isTenQ = (body: Record<string, unknown>) => String(body.input).includes("\nDocument: Form 10-Q\n");

/** What the fake model writes for the brief once the checker has rejected its first draft. */
const GOOD_BRIEF = [
  "**VST 2026-Q2:** net income $305 million, ahead of consensus; fiscal 2026 free cash flow guidance maintained [M1][G1]",
  "",
  "### Results",
  "- Net income: $305 million versus consensus (finnhub) of $290 million, a surprise of +5.2% [M1]",
  "",
  "### Guidance",
  "- Free cash flow for fiscal 2026: $3.925 billion to $4.725 billion, maintained [G1]",
].join("\n");
const briefRequests: Record<string, unknown>[] = [];

/** Fake OpenAI client: streams a fixed cited answer for Ask; returns fixed structured output for extraction. */
let lastResponsesRequest: Record<string, unknown> | null = null;
const extractRequests: Record<string, unknown>[] = [];
const fakeLlm: OpenAILike = {
  embeddings: {
    async create({ input }) {
      return { data: input.map((_, index) => ({ embedding: new Array(1536).fill(0), index })), usage: { prompt_tokens: 7 } };
    },
  },
  responses: {
    create: (async (body: Record<string, unknown>) => {
      if (body.stream) {
        lastResponsesRequest = body;
        return (async function* (): AsyncGenerator<ResponseStreamEvent> {
          yield { type: "response.output_text.delta", delta: "Vistra discussed maintenance " };
          yield { type: "response.output_text.delta", delta: "capital expenditures [C1]." };
          yield { type: "response.completed", response: { usage: { input_tokens: 1200, output_tokens: 12 } } };
        })();
      }
      if (String(body.instructions).includes("earnings brief")) {
        // Brief writer: a bad first draft (a figure not in the fact sheet), a good one on the retry.
        briefRequests.push(body);
        const retry = String(body.input).includes("previous draft was rejected");
        const output_text = retry ? GOOD_BRIEF : GOOD_BRIEF.replace("$305 million versus", "$999 million versus");
        const res: ResponseObject = { status: "completed", output_text, output: [], usage: { input_tokens: 900, output_tokens: 150 } };
        return res;
      }
      extractRequests.push(body);
      // Decide by the request header: the release itself mentions "Form 10-Q" in its boilerplate.
      const result = isTenQ(body) ? { metrics: [], guidance: [] } : PRESS_RELEASE_EXTRACTION;
      const res: ResponseObject = {
        status: "completed",
        output_text: JSON.stringify(result),
        output: [],
        usage: { input_tokens: 5000, output_tokens: 300 },
      };
      return res;
    }) as OpenAILike["responses"]["create"],
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
  if (url.endsWith("/companyfacts/CIK0001692819.json")) return json(JSON.parse(read("companyfacts_VST_trimmed.json").toString()));
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

async function drainExtract(): Promise<unknown[]> {
  const results: unknown[] = [];
  for (;;) {
    const jobs = await ctx.boss.fetch<DocumentPayload>(Q.extract, { batchSize: 10 });
    if (jobs.length === 0) return results;
    for (const job of jobs) {
      results.push(await extractJob(ctx, job.data));
      await ctx.boss.complete(Q.extract, job.id);
    }
  }
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
    // The fake model has no rate limit: never pace it, whatever the local .env says.
    LLM_TPM_LIMIT: "0",
    GOLDEN_DIR: path.join(tmp, "golden"),
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

describe("Phase 3 extraction: validate, retry once, route to review", () => {
  let results: unknown[] = [];

  it("extracts both live documents, saving only validated items", async () => {
    results = await drainExtract();
    expect(results).toContainEqual(
      expect.objectContaining({ metrics: 1, guidance: 1, documentStatus: "needs_review", calls: 2 }),
    );
    expect(results).toContainEqual(expect.objectContaining({ metrics: 0, guidance: 0, documentStatus: "extracted", calls: 1 }));

    const saved = await ctx.db.select().from(metrics);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "net_income", periodType: "ytd", value: "1334000000", reviewStatus: "pending" });
    const [pr] = await ctx.db
      .select()
      .from(documents)
      .where(and(eq(documents.type, "press_release"), isNull(documents.supersededAt)));
    expect(pr!.cleanText!.slice(saved[0]!.charStart, saved[0]!.charEnd)).toBe(NET_INCOME_ROW);

    const [guide] = await ctx.db.select().from(guidance);
    expect(guide).toMatchObject({ metric: "fcf", kind: "range", low: "3925000000", high: "4725000000", reviewStatus: "auto_approved" });
  });

  it("retries once with the specific errors, then sends what still fails to review", async () => {
    const prRequests = extractRequests.filter((r) => !isTenQ(r));
    expect(prRequests).toHaveLength(2);
    expect(String(prRequests[1]!.input)).toMatch(/previous answer for this document had these problems/);
    expect(String(prRequests[1]!.input)).toMatch(/disagrees with the headline table/);
    expect(String(prRequests[1]!.input)).toMatch(/quote not found verbatim/);

    const items = await ctx.db.select().from(reviewItems);
    expect(items).toHaveLength(2);
    const wrongColumn = items.find((i) => (i.candidate as { name: string }).name === "net_income")!;
    expect(wrongColumn.regexValue).toBe("305000000");
    expect(items.find((i) => (i.candidate as { name: string }).name === "op_income")!.errors.join(" ")).toMatch(
      /quote not found verbatim/,
    );
  });

  it("asks for structured output, keeps source text out of the instructions, and logs each call", async () => {
    const req = extractRequests[0]!;
    expect((req.text as { format: { type: string; strict: boolean } }).format).toMatchObject({ type: "json_schema", strict: true });
    expect(String(req.instructions)).toMatch(/Quote verbatim or omit the metric/);
    expect(String(req.instructions)).not.toMatch(/Vistra/);
    expect(String(req.input)).toMatch(/Fiscal period in force: 2026-Q2/);
    expect(String(req.input)).toMatch(/<document>\n[\s\S]*<\/document>$/);
    const calls = await ctx.db.select().from(llmCalls).where(eq(llmCalls.purpose, "extract"));
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.promptVersion === "extract.v1" && c.inputTokens === 5000 && c.ok)).toBe(true);
  });

  it("holds the event in needs_review until a human has looked", async () => {
    const [event] = await ctx.db.select().from(earningsEvents);
    expect(event!.status).toBe("needs_review");
    expect(await queued(Q.compareAndBrief)).toBe(0);
  });
});

describe("Phase 3 review: approve, reject, correct -> golden set", () => {
  let app: ReturnType<typeof buildServer>;
  beforeAll(() => {
    app = buildServer(ctx);
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /review lists failed candidates and pending items with source context", async () => {
    const res = await app.inject({ method: "GET", url: "/review" });
    expect(res.statusCode).toBe(200);
    const { items, total } = res.json();
    expect(total).toBe(3);
    expect(items.map((i: { kind: string }) => i.kind).sort()).toEqual(["candidate", "candidate", "metric"]);

    const pending = items.find((i: { kind: string }) => i.kind === "metric");
    expect(pending.context.text.slice(pending.context.quoteStart, pending.context.quoteEnd)).toBe(NET_INCOME_ROW);
    expect(pending.factValues).toContain(1334e6); // company-facts agrees with the six-month figure
    expect(pending.reasons[0]).toMatch(/below the review threshold/);

    const wrong = items.find((i: { kind: string; item: { name: string } }) => i.kind === "candidate" && i.item.name === "net_income");
    expect(wrong.regexValue).toBe(305e6);
    expect(wrong.factValues).toContain(305e6);
  });

  it("refuses to approve a failed candidate or accept a quote that is not in the document", async () => {
    const [candidate] = await ctx.db.select().from(reviewItems).limit(1);
    const approve = await app.inject({ method: "PATCH", url: `/review/candidate/${candidate!.id}`, payload: { action: "approve" } });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error.code).toBe("REVIEW_CONFLICT");

    const badQuote = await app.inject({
      method: "PATCH",
      url: `/review/candidate/${candidate!.id}`,
      payload: { action: "correct", value: 1, quote: "This sentence is not in the press release." },
    });
    expect(badQuote.statusCode).toBe(422);
    expect(badQuote.json().error.code).toBe("QUOTE_NOT_FOUND");
  });

  it("approves the pending metric and rejects the made-up one", async () => {
    const [pending] = await ctx.db.select().from(metrics).where(eq(metrics.reviewStatus, "pending"));
    const ok = await app.inject({ method: "PATCH", url: `/review/metric/${pending!.id}`, payload: { action: "approve" } });
    expect(ok.json()).toMatchObject({ status: "approved", goldenFile: null, documentStatus: "needs_review" });

    const items = await ctx.db.select().from(reviewItems);
    const madeUp = items.find((i) => (i.candidate as { name: string }).name === "op_income")!;
    const rejected = await app.inject({
      method: "PATCH",
      url: `/review/candidate/${madeUp.id}`,
      payload: { action: "reject", reason: "Not in the release" },
    });
    expect(rejected.json()).toMatchObject({ status: "rejected", documentStatus: "needs_review" });
  });

  it("a correction saves the human's value, keeps the model's, and writes a golden case (exit test)", async () => {
    const items = await ctx.db.select().from(reviewItems).where(eq(reviewItems.status, "open"));
    expect(items).toHaveLength(1);
    const res = await app.inject({
      method: "PATCH",
      url: `/review/candidate/${items[0]!.id}`,
      payload: { action: "correct", value: 305e6, quote: NET_INCOME_ROW },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: "corrected", documentStatus: "extracted" });

    const [row] = await ctx.db.select().from(metrics).where(eq(metrics.id, body.rowId));
    expect(row).toMatchObject({ value: "305000000", originalValue: "327000000", reviewStatus: "corrected", periodType: "quarter" });

    const golden = JSON.parse(await fs.readFile(body.goldenFile, "utf8"));
    expect(golden).toMatchObject({ ticker: "VST", fiscalPeriod: "2026-Q2" });
    expect(golden.metrics).toEqual([
      expect.objectContaining({ name: "net_income", periodType: "quarter", value: 305e6, modelValue: 327e6, quote: NET_INCOME_ROW }),
    ]);
    expect(golden.documents).toEqual([expect.objectContaining({ type: "press_release" })]);
    const copied = path.join(path.dirname(body.goldenFile), golden.documents[0].file);
    expect((await fs.stat(copied)).size).toBeGreaterThan(1000);
  });

  it("once nothing waits for review, the event resumes at compare", async () => {
    const [event] = await ctx.db.select().from(earningsEvents);
    expect(event!.status).toBe("extracted");
    expect(await queued(Q.compareAndBrief)).toBe(1);
  });

  it("re-extraction never overwrites or reopens what a human settled", async () => {
    const [pr] = await ctx.db
      .select()
      .from(documents)
      .where(and(eq(documents.type, "press_release"), isNull(documents.supersededAt)));
    const before = await ctx.db.select().from(metrics);
    const again = await extractJob(ctx, { documentId: pr!.id });
    expect(again).toMatchObject({ documentStatus: "extracted", review: 0 });
    const after = await ctx.db.select().from(metrics);
    expect(after.map((m) => [m.id, m.value, m.reviewStatus]).sort()).toEqual(
      before.map((m) => [m.id, m.value, m.reviewStatus]).sort(),
    );
    expect(await ctx.db.select().from(reviewItems).where(eq(reviewItems.status, "open"))).toHaveLength(0);
  });

  it("POST /events/:id/reprocess requeues extraction for the event's live documents", async () => {
    const [event] = await ctx.db.select().from(earningsEvents);
    const res = await app.inject({ method: "POST", url: `/events/${event!.id}/reprocess`, payload: { stage: "extract" } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ stage: "extract", documents: 2 });
    expect(await queued(Q.extract)).toBe(2);
    const missing = await app.inject({
      method: "POST",
      url: "/events/00000000-0000-4000-8000-000000000000/reprocess",
      payload: { stage: "extract" },
    });
    expect(missing.json().error.code).toBe("EVENT_NOT_FOUND");
  });
});

describe("Phase 4 compare and brief", () => {
  let eventId: string;
  let prevGuideId: string;

  beforeAll(async () => {
    // The reprocess above requeued extraction; finishing it brings the event back to "extracted".
    await drainExtract();
    const [event] = await ctx.db.select().from(earningsEvents).where(eq(earningsEvents.fiscalPeriod, "2026-Q2"));
    eventId = event!.id;

    // History a real watchlist would have: a pre-print consensus snapshot, last quarter's guide,
    // and the prior-year quarter.
    await ctx.db.insert(consensusSnapshots).values({
      eventId,
      metric: "net_income",
      value: "290000000",
      provider: "finnhub",
      asOf: new Date("2026-08-06T00:00:00Z"),
    });
    const [pr] = await ctx.db
      .select()
      .from(documents)
      .where(and(eq(documents.type, "press_release"), isNull(documents.supersededAt)));
    const history = async (fiscalPeriod: string, reportDate: string) => {
      const [e] = await ctx.db
        .insert(earningsEvents)
        .values({ companyId: event!.companyId, fiscalPeriod, reportDate: new Date(reportDate), status: "briefed" })
        .returning();
      const [d] = await ctx.db
        .insert(documents)
        .values({
          eventId: e!.id,
          type: "press_release",
          sourceUrl: `https://www.sec.gov/Archives/edgar/data/1692819/${fiscalPeriod}.htm`,
          provider: "edgar",
          externalId: `history-${fiscalPeriod}`,
          sha256: `history-${fiscalPeriod}`,
          rawPath: `VST/history/${fiscalPeriod}.htm`,
          status: "extracted",
          fetchedAt: new Date(reportDate),
        })
        .returning();
      return { event: e!, doc: d! };
    };
    const q1 = await history("2026-Q1", "2026-05-07T11:01:21Z");
    const [g] = await ctx.db
      .insert(guidance)
      .values({
        eventId: q1.event.id,
        companyId: event!.companyId,
        metric: "fcf",
        kind: "range",
        low: "3925000000",
        high: "4725000000",
        targetPeriod: "2026-FY",
        quote: FCF_GUIDE,
        documentId: q1.doc.id,
        charStart: 0,
        charEnd: FCF_GUIDE.length,
        confidence: "0.95",
        reviewStatus: "approved",
        promptVersion: "extract.v1",
        model: "test-model",
      })
      .returning();
    prevGuideId = g!.id;
    const py = await history("2025-Q2", "2025-08-07T11:00:00Z");
    await ctx.db.insert(metrics).values({
      eventId: py.event.id,
      name: "net_income",
      value: "327000000",
      unit: "usd",
      periodType: "quarter",
      quote: NET_INCOME_ROW,
      documentId: py.doc.id,
      charStart: 0,
      charEnd: NET_INCOME_ROW.length,
      confidence: "0.95",
      reviewStatus: "approved",
      promptVersion: "extract.v1",
      model: "test-model",
    });
    void pr;
  });

  it("runs only once every live document is extracted", async () => {
    const [event] = await ctx.db.select().from(earningsEvents).where(eq(earningsEvents.id, eventId));
    expect(event!.status).toBe("extracted");
    expect(await queued(Q.compareAndBrief)).toBe(1);
  });

  it("computes verdicts against the named consensus, in code (exit test)", async () => {
    const r = await compareAndBriefJob(ctx, { eventId });
    expect(r).toMatchObject({ brief: "published", version: 1, writer: "test-model" });

    const quarter = (await ctx.db.select().from(metrics).where(and(eq(metrics.eventId, eventId), eq(metrics.periodType, "quarter"))))[0]!;
    expect(quarter).toMatchObject({
      value: "305000000",
      consensusValue: "290000000",
      consensusProvider: "finnhub",
      surprisePct: "0.051724",
      verdict: "beat",
    });
    // Year-to-date figures have no consensus, so no verdict is invented.
    const ytd = (await ctx.db.select().from(metrics).where(and(eq(metrics.eventId, eventId), eq(metrics.periodType, "ytd"))))[0]!;
    expect(ytd.verdict).toBeNull();
  });

  it("labels the guidance change from two stored rows and records the inputs", async () => {
    const [g] = await ctx.db.select().from(guidance).where(eq(guidance.eventId, eventId));
    expect(g).toMatchObject({ change: "maintained", prevGuidanceId: prevGuideId });
    expect(g!.compareInputs).toMatchObject({ prevId: prevGuideId, midpointDelta: "0", rule: "midpoint and width within tolerance" });
  });

  it("writes the brief from the fact sheet, rejecting a draft with an unverified figure", async () => {
    expect(briefRequests).toHaveLength(2);
    expect(String(briefRequests[0]!.input)).toMatch(/<fact_sheet>/);
    expect(String(briefRequests[0]!.input)).not.toMatch(/Forward-Looking|<document>/); // never the raw filing
    expect(String(briefRequests[1]!.input)).toMatch(/\$999 million.*not a fact-sheet value/);

    const [brief] = await ctx.db.select().from(briefs).where(eq(briefs.eventId, eventId));
    expect(brief).toMatchObject({ version: 1, model: "test-model", promptVersion: "brief.v1", bodyMd: GOOD_BRIEF });
    expect(Object.keys(brief!.citations).sort()).toEqual(["G1", "M1"]);

    const [event] = await ctx.db.select().from(earningsEvents).where(eq(earningsEvents.id, eventId));
    expect(event!.status).toBe("briefed");
    const feed = await ctx.db.select().from(alerts).where(eq(alerts.eventId, eventId));
    expect(feed.map((a) => a.message)).toContain(
      "VST 2026-Q2 brief ready - net income beat; fiscal 2026 free cash flow guide maintained",
    );
    const calls = await ctx.db.select().from(llmCalls).where(eq(llmCalls.purpose, "brief"));
    expect(calls).toHaveLength(2);
  });

  it("re-running on unchanged facts does not create a new version", async () => {
    const r = await compareAndBriefJob(ctx, { eventId });
    expect(r).toMatchObject({ brief: "unchanged", version: 1 });
    expect(await ctx.db.select().from(briefs).where(eq(briefs.eventId, eventId))).toHaveLength(1);
  });

  it("without a model, the template writer publishes a new version and supersedes the old one", async () => {
    const model = ctx.config.STRONG_MODEL;
    ctx.config.STRONG_MODEL = "";
    try {
      const r = await compareAndBriefJob(ctx, { eventId });
      expect(r).toMatchObject({ brief: "published", version: 2, writer: "template" });
    } finally {
      ctx.config.STRONG_MODEL = model;
    }
    const versions = await ctx.db.select().from(briefs).where(eq(briefs.eventId, eventId));
    expect(versions.find((b) => b.version === 1)!.supersededAt).not.toBeNull();
    const current = versions.find((b) => b.version === 2)!;
    expect(current.supersededAt).toBeNull();
    expect(current.bodyMd).toContain(
      "- Net income: $305 million, beat consensus (finnhub) of $290 million, a surprise of +5.2%; $327 million a year earlier (-6.7%) [M1]",
    );
    expect(current.bodyMd).toContain(`- "${FCF_GUIDE}" [G1]`);
  });

  it("withholds a brief that fails the check twice, keeping the published one", async () => {
    const r = await compareAndBriefJob(ctx, { eventId }, {
      model: "bad-writer",
      promptVersion: "test",
      drafter: async () => "**VST 2026-Q2:** shares look undervalued; buy ahead of Q3 [M1]",
    });
    expect(r).toMatchObject({ brief: "withheld" });
    const [event] = await ctx.db.select().from(earningsEvents).where(eq(earningsEvents.id, eventId));
    expect(event!.lastError).toMatch(/^brief withheld: .*recommendation language/);
    expect((await ctx.db.select().from(alerts).where(eq(alerts.kind, "brief_withheld"))).length).toBe(1);
    const current = await ctx.db.select().from(briefs).where(and(eq(briefs.eventId, eventId), isNull(briefs.supersededAt)));
    expect(current.map((b) => b.version)).toEqual([2]);
  });

  it("GET /events/:id/brief resolves every citation to its quote and source passage", async () => {
    const app = buildServer(ctx);
    const res = await app.inject({ method: "GET", url: `/events/${eventId}/brief` });
    expect(res.statusCode).toBe(200);
    const brief = res.json();
    expect(brief).toMatchObject({ ticker: "VST", fiscalPeriod: "2026-Q2", version: 2, previousVersions: 1, writer: "template" });
    const m1 = brief.citations.find((c: { marker: string }) => c.marker === "M1");
    expect(m1).toMatchObject({ kind: "metric", quote: NET_INCOME_ROW, documentType: "press_release", note: "Corrected by a reviewer" });

    const ctxRes = await app.inject({
      method: "GET",
      url: `/documents/${m1.documentId}/context?start=${m1.charStart}&end=${m1.charEnd}`,
    });
    const source = ctxRes.json();
    expect(source.text.slice(source.highlightStart, source.highlightEnd)).toBe(NET_INCOME_ROW);

    const list = (await app.inject({ method: "GET", url: "/briefs" })).json();
    expect(list.briefs[0]).toMatchObject({ ticker: "VST", fiscalPeriod: "2026-Q2", version: 2 });
    expect(list.briefs[0].headline).toMatch(/^VST 2026-Q2: /);

    const missing = await app.inject({ method: "GET", url: "/events/00000000-0000-4000-8000-000000000000/brief" });
    expect(missing.json().error.code).toBe("BRIEF_NOT_FOUND");
    await app.close();
  });
});

describe("Phase 5 read models: week, alerts, costs, ticker", () => {
  let app: ReturnType<typeof buildServer>;
  beforeAll(() => {
    app = buildServer(ctx);
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /events/week groups prints by New York day, with verdicts and guidance changes", async () => {
    const res = await app.inject({ method: "GET", url: "/events/week?from=2026-08-03" });
    expect(res.statusCode).toBe(200);
    const week = res.json();
    expect(week).toMatchObject({ from: "2026-08-03", to: "2026-08-09" });
    expect(week.days.map((d: { date: string }) => d.date)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);
    const friday = week.days.find((d: { date: string }) => d.date === "2026-08-07");
    expect(friday.events).toEqual([
      expect.objectContaining({
        ticker: "VST",
        fiscalPeriod: "2026-Q2",
        status: "compared",
        hasBrief: true,
        verdicts: [{ metric: "net_income", verdict: "beat" }],
        guidanceChanges: [{ metric: "fcf", targetPeriod: "2026-FY", change: "maintained" }],
      }),
    ]);
    expect(week.lastDiscoverAt).not.toBeNull();

    const bad = await app.inject({ method: "GET", url: "/events/week?from=2026-08-09&to=2026-08-01" });
    expect(bad.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("GET /alerts lists the feed newest first, with a cursor for the next page", async () => {
    const res = (await app.inject({ method: "GET", url: "/alerts" })).json();
    expect(res.alerts.length).toBeGreaterThanOrEqual(3);
    expect(res.alerts[0]).toMatchObject({ ticker: "VST", fiscalPeriod: "2026-Q2", kind: "brief_withheld" });
    const times = res.alerts.map((a: { createdAt: string }) => Date.parse(a.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(res.nextCursor).toBeNull();

    const bad = await app.inject({ method: "GET", url: "/alerts?cursor=nonsense" });
    expect(bad.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("GET /admin/costs groups spend by print and purpose and names unpriced models", async () => {
    const res = (await app.inject({ method: "GET", url: "/admin/costs" })).json();
    const purposes = res.rows.filter((r: { ticker: string }) => r.ticker === "VST").map((r: { purpose: string }) => r.purpose);
    expect(purposes.sort()).toEqual(["brief", "extract"]);
    const extract = res.rows.find((r: { purpose: string; ticker: string }) => r.purpose === "extract" && r.ticker === "VST");
    // 3 calls in the first extraction, 2 when re-extracting the release, 3 after the reprocess.
    expect(extract).toMatchObject({ calls: 8, failedCalls: 0, inputTokens: 40000 });
    expect(res.unpricedModels).toContain("test-model");
    expect(res.perEvent[0]).toMatchObject({ ticker: "VST", fiscalPeriod: "2026-Q2" });
  });

  it("GET /companies/:ticker shows the guidance table across quarters", async () => {
    const res = (await app.inject({ method: "GET", url: "/companies/vst" })).json();
    expect(res.company).toMatchObject({ ticker: "VST", name: "Vistra Corp." });
    expect(res.events.map((e: { fiscalPeriod: string }) => e.fiscalPeriod)).toEqual(["2026-Q2", "2026-Q1", "2025-Q2"]);
    expect(res.guidance).toEqual([
      expect.objectContaining({
        metric: "fcf",
        targetPeriod: "2026-FY",
        unit: "usd",
        delivered: null,
        entries: [
          expect.objectContaining({ fiscalPeriod: "2026-Q1", low: 3.925e9, high: 4.725e9, change: null }),
          expect.objectContaining({ fiscalPeriod: "2026-Q2", low: 3.925e9, high: 4.725e9, change: "maintained" }),
        ],
      }),
    ]);
    expect((await app.inject({ method: "GET", url: "/companies/ZZZZ" })).json().error.code).toBe("COMPANY_NOT_FOUND");
  });
});


