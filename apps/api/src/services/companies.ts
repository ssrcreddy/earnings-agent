import { companies } from "@eia/db";
import type { CompanyResponse } from "@eia/shared";
import { asc, eq } from "drizzle-orm";
import type { AppContext } from "../context";
import { AppError } from "../errors";

type CompanyRow = typeof companies.$inferSelect;

export function toCompanyResponse(c: CompanyRow): CompanyResponse {
  return {
    id: c.id,
    ticker: c.ticker,
    cik: c.cik,
    name: c.name,
    exchange: c.exchange,
    fiscalYearEnd: c.fiscalYearEnd,
    watched: c.watched,
  };
}

export async function listCompanies(ctx: AppContext): Promise<CompanyRow[]> {
  return ctx.db.select().from(companies).orderBy(asc(companies.ticker));
}

export async function findCompany(ctx: AppContext, ticker: string): Promise<CompanyRow | null> {
  const [row] = await ctx.db.select().from(companies).where(eq(companies.ticker, ticker.toUpperCase()));
  return row ?? null;
}

/**
 * Adds a ticker to the watchlist, resolving its CIK from EDGAR's ticker file (§21).
 * Idempotent: an existing company is re-watched and returned with created=false.
 */
export async function addCompany(
  ctx: AppContext,
  ticker: string,
): Promise<{ company: CompanyRow; created: boolean }> {
  const symbol = ticker.toUpperCase();
  const existing = await findCompany(ctx, symbol);
  if (existing) {
    if (!existing.watched) {
      const [row] = await ctx.db
        .update(companies)
        .set({ watched: true })
        .where(eq(companies.id, existing.id))
        .returning();
      return { company: row!, created: false };
    }
    return { company: existing, created: false };
  }

  const entry = await ctx.edgar.lookupTicker(symbol);
  if (!entry) throw new AppError("UNKNOWN_TICKER", `EDGAR has no company with ticker ${symbol}`, 422);
  const profile = await ctx.edgar.getProfile(entry.cik);

  const [inserted] = await ctx.db
    .insert(companies)
    .values({
      ticker: symbol,
      cik: entry.cik,
      name: profile.name,
      exchange: profile.exchange,
      fiscalYearEnd: profile.fiscalYearEnd,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { company: inserted, created: true };
  // Lost a race with a concurrent add.
  return { company: (await findCompany(ctx, symbol))!, created: false };
}
