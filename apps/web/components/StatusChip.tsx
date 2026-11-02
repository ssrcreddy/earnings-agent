import type { EventStatus } from "@eia/shared";

// One entry per EventStatus value: the UI can't show a status the backend doesn't have (§22).
const STYLES: Record<EventStatus, { label: string; className: string }> = {
  discovered: { label: "Discovered", className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200" },
  ingested: { label: "Ingested", className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200" },
  parsed: { label: "Parsed", className: "bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-100" },
  extracted: { label: "Extracted", className: "bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-100" },
  compared: { label: "Compared", className: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-100" },
  briefed: { label: "Briefed", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-100" },
  needs_review: { label: "Needs review", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-100" },
  failed: { label: "Failed", className: "bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-100" },
};

export function StatusChip({ status }: { status: string }) {
  const s = STYLES[status as EventStatus] ?? { label: status, className: "bg-slate-100 text-slate-700" };
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${s.className}`}>{s.label}</span>;
}

const VERDICT_STYLES: Record<string, string> = {
  beat: "text-emerald-700 dark:text-emerald-400",
  miss: "text-rose-700 dark:text-rose-400",
  inline: "text-slate-600 dark:text-slate-300",
  no_consensus: "text-slate-400",
};

export function VerdictTag({ verdict }: { verdict: string }) {
  const label = verdict === "inline" ? "in line" : verdict === "no_consensus" ? "no consensus" : verdict;
  return <span className={`font-medium ${VERDICT_STYLES[verdict] ?? ""}`}>{label}</span>;
}

const CHANGE_STYLES: Record<string, string> = {
  raised: "text-emerald-700 dark:text-emerald-400",
  lowered: "text-rose-700 dark:text-rose-400",
  withdrawn: "text-rose-700 dark:text-rose-400",
};

export function ChangeTag({ change }: { change: string | null }) {
  if (!change) return <span className="text-slate-400">—</span>;
  return <span className={`font-medium ${CHANGE_STYLES[change] ?? "text-slate-600 dark:text-slate-300"}`}>{change}</span>;
}
