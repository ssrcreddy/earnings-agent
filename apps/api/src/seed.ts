import { loadConfig } from "./config";
import { closeContext, createContext } from "./context";
import { addCompany } from "./services/companies";

/** Loads WATCHLIST from .env into the companies table (idempotent). */
async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);
  const tickers = config.WATCHLIST.split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  if (tickers.length === 0) throw new Error("WATCHLIST is empty");
  try {
    for (const ticker of tickers) {
      try {
        const { company, created } = await addCompany(ctx, ticker);
        console.log(`${created ? "added  " : "exists "} ${company.ticker.padEnd(6)} CIK ${company.cik}  FYE ${company.fiscalYearEnd}  ${company.name}`);
      } catch (err) {
        console.error(`failed  ${ticker}: ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    await ctx.pool.end();
    void closeContext;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
