import Link from "next/link";
import { ApiErrorNote } from "@/components/ApiErrorNote";
import { ChangeTag, StatusChip, VerdictTag } from "@/components/StatusChip";
import { api } from "@/lib/api";
import { ageLabel, metricLabel, periodLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

function shiftWeek(isoDate: string, weeks: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export default async function WeekPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const { from } = await searchParams;
  let week;
  try {
    week = await api.week(from);
  } catch (err) {
    return <ApiErrorNote error={err} />;
  }
  const total = week.days.reduce((n, d) => n + d.events.length, 0);
  // A scheduler that hasn't run for over a day is worth saying out loud (§23).
  const stale = !week.lastDiscoverAt || Date.now() - Date.parse(week.lastDiscoverAt) > 26 * 3600_000;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          Week of {dayLabel(week.from)} – {dayLabel(week.to)}
        </h1>
        <nav className="flex gap-2 text-sm">
          <Link className="btn" href={`/week?from=${shiftWeek(week.from, -1)}`}>
            ← Previous
          </Link>
          <Link className="btn" href="/week">
            This week
          </Link>
          <Link className="btn" href={`/week?from=${shiftWeek(week.from, 1)}`}>
            Next →
          </Link>
        </nav>
      </div>
      <p className={`text-xs ${stale ? "text-amber-700 dark:text-amber-400" : "text-slate-500"}`}>
        Discovery last ran {ageLabel(week.lastDiscoverAt)}
        {stale ? " - check that the worker is running" : ""}. {total} {total === 1 ? "print" : "prints"} this week.
      </p>

      <div className="space-y-3">
        {week.days.map((day) => (
          <section key={day.date} className="rounded-lg border border-stone-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <h2 className="border-b border-stone-200 px-4 py-2 text-sm font-medium dark:border-slate-800">{dayLabel(day.date)}</h2>
            {day.events.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-400">No watched company reports.</p>
            ) : (
              <ul className="divide-y divide-stone-100 dark:divide-slate-800">
                {day.events.map((e) => (
                  <li key={e.eventId} className="grid gap-2 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-center">
                    <div>
                      <Link href={`/ticker/${e.ticker}`} className="font-semibold hover:underline">
                        {e.ticker}
                      </Link>{" "}
                      <span className="text-sm text-slate-500">{periodLabel(e.fiscalPeriod)}</span>
                      <div className="text-xs text-slate-500">
                        {new Date(e.reportDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}{" "}
                        ET
                      </div>
                    </div>
                    <div className="text-sm">
                      {e.verdicts.length === 0 && e.guidanceChanges.length === 0 ? (
                        <span className="text-slate-400">{e.lastError ? e.lastError : "Not compared yet"}</span>
                      ) : (
                        <span className="flex flex-wrap gap-x-4 gap-y-1">
                          {e.verdicts.map((v) => (
                            <span key={v.metric}>
                              {metricLabel(v.metric)} <VerdictTag verdict={v.verdict} />
                            </span>
                          ))}
                          {e.guidanceChanges.map((g) => (
                            <span key={`${g.metric}-${g.targetPeriod}`}>
                              {periodLabel(g.targetPeriod)} {metricLabel(g.metric).toLowerCase()} guide <ChangeTag change={g.change} />
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusChip status={e.status} />
                      {e.hasBrief && (
                        <Link href={`/brief/${e.eventId}`} className="text-sm font-medium text-sky-700 hover:underline dark:text-sky-400">
                          Brief →
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
