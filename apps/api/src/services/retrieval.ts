// Hybrid retrieval for Ask (§17): vector + full-text candidates, merged and reranked by a weighted blend.
import { companies } from "@eia/db";
import type { ChunkSection } from "@eia/shared";
import { eq, sql, type SQL } from "drizzle-orm";
import type { AppContext } from "../context";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  eventId: string;
  ticker: string;
  fiscalPeriod: string;
  section: ChunkSection;
  speaker: string | null;
  text: string;
  charStart: number;
  charEnd: number;
  documentType: string;
  sourceUrl: string;
  vectorScore: number | null;
  ftsScore: number | null;
  score: number;
}

export interface RetrieveOptions {
  ticker?: string;
  fiscalPeriod?: string;
  candidates?: number;
  topK?: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** Best cosine similarity seen, or null when the vector channel was unavailable. */
  bestSimilarity: number | null;
  /** Set when retrieval found nothing usable; Ask refuses without calling the LLM. */
  refusal: string | null;
  ticker: string | null;
}

export const WEIGHTS = { vector: 0.6, fts: 0.3, boost: 0.1 } as const;

/** Sections that carry stated facts; boosted for factual questions (§17). */
const SECTION_BOOST: Partial<Record<ChunkSection, number>> = {
  headline_table: 1,
  prepared_remarks: 1,
  mda: 0.5,
  release_body: 0.5,
};

export async function retrieve(ctx: AppContext, question: string, opts: RetrieveOptions = {}): Promise<RetrievalResult> {
  const candidates = opts.candidates ?? 20;
  const topK = opts.topK ?? 5;
  const company = await resolveCompany(ctx, question, opts.ticker);
  const ticker = company?.ticker ?? null;
  const filters = [sql`c.superseded_at is null`];
  if (ticker) filters.push(sql`c.ticker = ${ticker}`);
  if (opts.fiscalPeriod) filters.push(sql`c.fiscal_period = ${opts.fiscalPeriod}`);
  const where = sql.join(filters, sql` and `);

  const vectorHits = ctx.embedder ? await vectorCandidates(ctx, question, where, candidates) : null;
  // The ticker filter already scopes to the company, so its name words would only add noise.
  const terms = contentTerms(question, company ? companyWords(company) : []);
  // Without vectors there is no similarity floor, so keyword search must match every topic term.
  const ftsHits = await ftsCandidates(ctx, terms, where, candidates, { allowPartial: vectorHits !== null });

  const bestSimilarity = vectorHits ? Math.max(0, ...vectorHits.map((h) => h.score)) : null;
  if (vectorHits && bestSimilarity! < ctx.config.ASK_SIMILARITY_FLOOR) {
    return { chunks: [], bestSimilarity, refusal: "not covered in the available documents", ticker };
  }
  if (!vectorHits && ftsHits.length === 0) {
    return { chunks: [], bestSimilarity, refusal: "not covered in the available documents", ticker };
  }

  const ids = [...new Set([...(vectorHits ?? []), ...ftsHits].map((h) => h.id))];
  if (ids.length === 0) return { chunks: [], bestSimilarity, refusal: "not covered in the available documents", ticker };
  const details = await chunkDetails(ctx, ids);

  const vec = new Map((vectorHits ?? []).map((h) => [h.id, h.score]));
  const maxRank = Math.max(0, ...ftsHits.map((h) => h.score));
  const fts = new Map(ftsHits.map((h) => [h.id, maxRank > 0 ? h.score / maxRank : 0]));

  // Recency: newest fiscal period among the candidates = 1, oldest = 0.
  const periods = [...new Set(details.map((d) => d.fiscalPeriod))].sort();
  const recency = (p: string) => (periods.length > 1 ? periods.indexOf(p) / (periods.length - 1) : 1);

  const scored = details.map((d) => {
    const v = vec.get(d.chunkId) ?? null;
    const f = fts.get(d.chunkId) ?? null;
    const boost = 0.5 * (SECTION_BOOST[d.section] ?? 0) + 0.5 * recency(d.fiscalPeriod);
    return { ...d, vectorScore: v, ftsScore: f, score: WEIGHTS.vector * (v ?? 0) + WEIGHTS.fts * (f ?? 0) + WEIGHTS.boost * boost };
  });
  scored.sort((a, b) => b.score - a.score);
  return { chunks: scored.slice(0, topK), bestSimilarity, refusal: null, ticker };
}

async function vectorCandidates(ctx: AppContext, question: string, where: SQL, limit: number) {
  const [qv] = await ctx.embedder!.embed([question]);
  const literal = JSON.stringify(qv);
  const res = await ctx.db.execute<{ id: string; sim: number }>(sql`
    select c.id, 1 - (c.embedding <=> ${literal}::vector) as sim
    from chunks c
    where c.embedding is not null and ${where}
    order by c.embedding <=> ${literal}::vector
    limit ${limit}`);
  return res.rows.map((r) => ({ id: r.id, score: Number(r.sim) }));
}

/** Question words that say nothing about the topic. Postgres drops ordinary stopwords itself. */
const QUESTION_FILLER = new Set([
  "what", "did", "does", "say", "said", "says", "tell", "told", "about", "management", "managements",
  "company", "discuss", "discussed", "mention", "mentioned", "talk", "talked", "comment", "comments",
  "commentary", "how", "why", "when", "which", "their", "its", "there", "any", "anything", "latest", "recent",
  "give", "gave", "given", "gives", "provide", "provided", "provides", "offer", "offered", "share", "shared",
]);

/** Topic words of a question, minus filler and the named company's own words (§17 keyword channel). */
export function contentTerms(question: string, exclude: string[] = []): string[] {
  const skip = new Set(exclude.map((w) => w.toLowerCase()));
  const words = (question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => w.length > 2 && !QUESTION_FILLER.has(w) && !skip.has(w),
  );
  return [...new Set(words)].slice(0, 30);
}

/**
 * Keyword candidates: chunks containing every topic term first, ranked by ts_rank_cd. When
 * `allowPartial` (the vector channel is there to judge relevance), chunks matching any term
 * top up the list at half weight.
 */
async function ftsCandidates(
  ctx: AppContext,
  terms: string[],
  where: SQL,
  limit: number,
  { allowPartial }: { allowPartial: boolean },
) {
  if (terms.length === 0) return [];
  const run = async (tsq: string) =>
    (
      await ctx.db.execute<{ id: string; rank: number }>(sql`
        select c.id, ts_rank_cd(c.tsv, q, 32) as rank
        from chunks c, to_tsquery('english', ${tsq}) q
        where c.tsv @@ q and ${where}
        order by rank desc
        limit ${limit}`)
    ).rows.map((r) => ({ id: r.id, score: Number(r.rank) }));

  const all = await run(terms.join(" & "));
  if (!allowPartial || all.length >= limit || terms.length === 1) return all;
  const seen = new Set(all.map((h) => h.id));
  const any = (await run(terms.join(" | "))).filter((h) => !seen.has(h.id)).map((h) => ({ ...h, score: h.score / 2 }));
  return [...all, ...any].slice(0, limit);
}

type Detail = Omit<RetrievedChunk, "vectorScore" | "ftsScore" | "score">;

async function chunkDetails(ctx: AppContext, ids: string[]): Promise<Detail[]> {
  const res = await ctx.db.execute<{
    id: string;
    document_id: string;
    event_id: string;
    ticker: string;
    fiscal_period: string;
    section: ChunkSection;
    speaker: string | null;
    text: string;
    char_start: number;
    char_end: number;
    type: string;
    source_url: string;
  }>(sql`
    select c.id, c.document_id, c.event_id, c.ticker, c.fiscal_period, c.section, c.speaker, c.text,
           c.char_start, c.char_end, d.type, d.source_url
    from chunks c join documents d on d.id = c.document_id
    where c.id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})`);
  return res.rows.map((r) => ({
    chunkId: r.id,
    documentId: r.document_id,
    eventId: r.event_id,
    ticker: r.ticker,
    fiscalPeriod: r.fiscal_period,
    section: r.section,
    speaker: r.speaker,
    text: r.text,
    charStart: r.char_start,
    charEnd: r.char_end,
    documentType: r.type,
    sourceUrl: r.source_url,
  }));
}

interface CompanyRef {
  ticker: string;
  name: string;
}

/** Words that identify a company in text: its ticker and the words of its name ("Vistra", "Corp"). */
export function companyWords(c: CompanyRef): string[] {
  return [c.ticker, ...c.name.split(/[^A-Za-z0-9]+/)].filter(Boolean).map((w) => w.toLowerCase());
}

/**
 * The company a question is about: the explicit ticker, or - "What did Vistra say about capex?" ->
 * VST - the one watched company it names. Only scopes when exactly one is named.
 */
async function resolveCompany(ctx: AppContext, question: string, ticker?: string): Promise<CompanyRef | null> {
  const watched = await ctx.db
    .select({ ticker: companies.ticker, name: companies.name })
    .from(companies)
    .where(eq(companies.watched, true));
  if (ticker) {
    const t = ticker.toUpperCase();
    return watched.find((c) => c.ticker === t) ?? { ticker: t, name: "" };
  }
  // Tickers match case-sensitively ("VST", not "vst" inside a word); names by their first word.
  const tokens = new Set(question.split(/[^A-Za-z0-9.]+/).map((t) => t.replace(/\.$/, "")));
  const lowerTokens = new Set([...tokens].map((t) => t.toLowerCase()));
  const named = watched.filter((c) => {
    if (tokens.has(c.ticker)) return true;
    const first = c.name.split(/[^A-Za-z0-9]+/)[0]?.toLowerCase() ?? "";
    return first.length > 3 && lowerTokens.has(first);
  });
  return named.length === 1 ? named[0]! : null;
}
