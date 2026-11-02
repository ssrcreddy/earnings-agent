import Link from "next/link";
import { ApiErrorNote } from "@/components/ApiErrorNote";
import { ChangeTag, StatusChip, VerdictTag } from "@/components/StatusChip";
import { api } from "@/lib/api";
import { formatRange, formatValue, metricLabel, periodLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TickerPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  let data;
  try {
    data = await api.ticker(symbol);
  } catch (err) {
    return <ApiErrorNote error={err} />;
  }
  const { company, events, guidance } = data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">
          {company.name} ({company.ticker})
        </h1>
        <p className="text-sm text-slate-500">
          {company.exchange ?? "—"} · fiscal year ends {company.fiscalYearEnd ? `${company.fiscalYearEnd.slice(0, 2)}/${company.fiscalYearEnd.slice(2)}` : "—"}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Guidance history</h2>
        {guidance.length === 0 ? (
          <p className="rounded-lg border border-stone-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900">
            No guidance extracted yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-sm">
              <thead className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-2">Guide for</th>
                  <th className="px-4 py-2">Given in</th>
                  <th className="px-4 py-2">Range</th>
                  <th className="px-4 py-2">Change</th>
                  <th className="px-4 py-2">Delivered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-slate-800">
                {guidance.flatMap((row) =>
                  row.entries.map((entry, i) => (
                    <tr key={`${row.metric}-${row.targetPeriod}-${entry.eventId}`} title={entry.quote}>
                      <td className="px-4 py-2">
                        {i === 0 ? (
                          <>
                            <span className="font-medium">{metricLabel(row.metric)}</span> {periodLabel(row.targetPeriod)}
                          </>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{periodLabel(entry.fiscalPeriod)}</td>
                      <td className="px-4 py-2 tabular-nums">
                        {entry.kind === "withdrawn" ? "Withdrawn" : formatRange(entry.low, entry.high, row.unit)}
                      </td>
                      <td className="px-4 py-2">
                        <ChangeTag change={entry.change} />
                      </td>
                      <td className="px-4 py-2 tabular-nums">
                        {i === row.entries.length - 1 ? (
                          row.delivered ? (
                            <>
                              {formatValue(row.delivered.value, row.unit)}{" "}
                              {row.delivered.verdict && <VerdictTag verdict={row.delivered.verdict} />}
                            </>
                          ) : (
                            <span className="text-slate-400">Not reported yet</span>
                          )
                        ) : null}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-slate-500">Hover a row for the quote it came from. Change labels are computed from stored guides, never inferred from prose.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Prints</h2>
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <span className="font-medium">{periodLabel(e.fiscalPeriod)}</span>{" "}
                <span className="text-sm text-slate-500">
                  {new Date(e.reportDate).toLocaleDateString("en-US", { dateStyle: "medium" })} ·{" "}
                  {e.documents.map((d) => d.type.replace("_", " ")).join(", ") || "no documents yet"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <StatusChip status={e.status} />
                {e.status === "briefed" || e.status === "compared" ? (
                  <Link href={`/brief/${e.id}`} className="text-sm font-medium text-sky-700 hover:underline dark:text-sky-400">
                    Brief →
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
