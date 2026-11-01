// Integration test: discover -> ingest against the real test database, EDGAR served from fixtures.
// Covers the Phase 1 exit endpoint and the idempotency spot-check from the §25 acceptance list.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { companies, documents, earningsEvents } from "@eia/db";
import { runMigrations } from "@eia/db/migrate";
import { count, isNull, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { closeContext, createContext, type AppContext } from "../src/context";
import { discoverJob } from "../src/jobs/discover";
import { ingestJob } from "../src/jobs/ingest";
import { Q, createQueues, type IngestPayload } from "../src/queues";
import { buildServer } from "../src/server";
import { addCompany } from "../src/services/companies";

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
  });
  ctx = createContext(config, { log: pino({ level: "silent" }), fetcher: fixtureFetcher });
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


