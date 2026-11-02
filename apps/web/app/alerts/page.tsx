import Link from "next/link";
import { ApiErrorNote } from "@/components/ApiErrorNote";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

const KIND_STYLES: Record<string, string> = {
  brief_ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-100",
  guidance_change: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-100",
  brief_withheld: "bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-100",
};

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await searchParams;
  let data;
  try {
    data = await api.alerts(cursor);
  } catch (err) {
    return <ApiErrorNote error={err} />;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Alerts</h1>
      {data.alerts.length === 0 ? (
        <p className="rounded-lg border border-stone-200 bg-white p-6 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          No alerts yet. One appears whenever a brief is published or guidance moves.
        </p>
      ) : (
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {data.alerts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-3 px-4 py-3">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${KIND_STYLES[a.kind] ?? "bg-slate-100 text-slate-700"}`}>
                {a.kind.replace(/_/g, " ")}
              </span>
              <Link href={a.kind === "brief_withheld" ? `/ticker/${a.ticker}` : `/brief/${a.eventId}`} className="flex-1 hover:underline">
                {a.message}
              </Link>
              <time className="text-xs text-slate-500" dateTime={a.createdAt}>
                {new Date(a.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
              </time>
            </li>
          ))}
        </ul>
      )}
      {data.nextCursor && (
        <Link className="btn inline-block" href={`/alerts?cursor=${encodeURIComponent(data.nextCursor)}`}>
          Older →
        </Link>
      )}
    </div>
  );
}
