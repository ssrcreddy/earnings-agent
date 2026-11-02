import { ApiErrorNote } from "@/components/ApiErrorNote";
import { api } from "@/lib/api";
import { formatUsd, periodLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function CostsPage() {
  let data;
  try {
    data = await api.costs();
  } catch (err) {
    return <ApiErrorNote error={err} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">LLM costs</h1>
        <p className="text-lg font-semibold tabular-nums">{formatUsd(data.totalUsd)} total</p>
      </div>
      {data.unpricedModels.length > 0 && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          No price is configured for {data.unpricedModels.join(", ")}, so their calls count as $0. Set LLM_PRICES_JSON to price them.
        </p>
      )}
      {data.rows.length === 0 ? (
        <p className="rounded-lg border border-stone-200 bg-white p-6 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          No model calls logged yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2">Print</th>
                <th className="px-4 py-2">Purpose</th>
                <th className="px-4 py-2 text-right">Calls</th>
                <th className="px-4 py-2 text-right">Input tokens</th>
                <th className="px-4 py-2 text-right">Output tokens</th>
                <th className="px-4 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 tabular-nums dark:divide-slate-800">
              {data.rows.map((r) => (
                <tr key={`${r.eventId ?? "none"}-${r.purpose}`}>
                  <td className="px-4 py-2">{r.ticker ? `${r.ticker} ${periodLabel(r.fiscalPeriod!)}` : <span className="text-slate-400">Not tied to a print</span>}</td>
                  <td className="px-4 py-2">{r.purpose}</td>
                  <td className="px-4 py-2 text-right">
                    {r.calls}
                    {r.failedCalls ? <span className="text-rose-600"> ({r.failedCalls} failed)</span> : null}
                  </td>
                  <td className="px-4 py-2 text-right">{r.inputTokens.toLocaleString("en-US")}</td>
                  <td className="px-4 py-2 text-right">{r.outputTokens.toLocaleString("en-US")}</td>
                  <td className="px-4 py-2 text-right">{formatUsd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
