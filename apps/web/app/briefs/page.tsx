import Link from "next/link";
import { api, ApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function BriefsPage() {
  let briefs;
  try {
    briefs = (await api.briefs()).briefs;
  } catch (err) {
    return (
      <p className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100">
        {err instanceof ApiError ? err.message : "The API is not reachable. Is `pnpm dev:api` running?"}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Briefs</h1>
      {briefs.length === 0 ? (
        <p className="rounded-lg border border-stone-200 bg-white p-6 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          No briefs yet. A brief is written once a print&apos;s figures are extracted, reviewed and compared.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {briefs.map((b) => (
            <li key={b.eventId}>
              <Link href={`/brief/${b.eventId}`} className="block px-4 py-3 hover:bg-stone-50 dark:hover:bg-slate-800/60">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-medium">
                    {b.ticker} {b.fiscalPeriod}
                  </span>
                  <span className="text-xs text-slate-500">
                    Reported {new Date(b.reportDate).toLocaleDateString("en-US", { dateStyle: "medium" })}
                    {b.version > 1 ? ` · v${b.version}` : ""}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{b.headline}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
