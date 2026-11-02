"use client";

import type { ReviewEntry } from "@eia/shared";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { submitReview, type ActionResult } from "./actions";

type Mode = "view" | "correct" | "reject";

/** Base-unit figures shown the way a filing writes them. */
function formatValue(value: unknown, unit: unknown): string {
  if (typeof value !== "number") return "—";
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "usd_per_share") return `$${value.toFixed(2)}`;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(3).replace(/\.?0+$/, "")}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  return `${sign}$${abs.toLocaleString()}`;
}

/** "305m", "4.02b", "1,334,000,000" -> base units. Percent and per-share figures are typed as shown. */
export function parseAmount(input: string): number | null {
  const m = /^\s*(-?[\d,]*\.?\d+)\s*([kmbt])?\s*$/i.exec(input);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  const scale = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b" | "t"] ?? 1;
  return Number.isFinite(n) ? n * scale : null;
}

function unitOf(entry: ReviewEntry): string {
  const item = entry.item;
  if (typeof item.unit === "string") return item.unit;
  return item.metric === "gross_margin" ? "percent" : String(item.metric ?? "").startsWith("eps") ? "usd_per_share" : "usd";
}

function isGuidance(entry: ReviewEntry): boolean {
  return entry.kind === "guidance" || entry.item.itemKind === "guidance";
}

export function ReviewQueue({ items }: { items: ReviewEntry[] }) {
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("view");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState("");
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");
  const [quote, setQuote] = useState("");
  const [reason, setReason] = useState("");
  const contextRef = useRef<HTMLDivElement>(null);

  const entry = items[Math.min(index, items.length - 1)]!;
  const guidance = isGuidance(entry);
  const unit = unitOf(entry);

  const startCorrect = useCallback(() => {
    // Text selected in the source panel becomes the quote: the quickest way to cite exactly.
    const selection = window.getSelection();
    const selected =
      selection && contextRef.current?.contains(selection.anchorNode) ? selection.toString().trim() : "";
    setQuote(selected || String(entry.item.quote ?? ""));
    setValue(entry.item.value === undefined ? "" : String(entry.item.value));
    setLow(entry.item.low == null ? "" : String(entry.item.low));
    setHigh(entry.item.high == null ? "" : String(entry.item.high));
    setResult(null);
    setMode("correct");
  }, [entry]);

  const run = useCallback(
    (action: unknown) => {
      startTransition(async () => {
        const r = await submitReview(entry.kind, entry.id, action);
        setResult(r);
        if (r.ok) setMode("view");
      });
    },
    [entry],
  );

  const approve = useCallback(() => {
    if (entry.kind === "candidate") {
      setResult({ ok: false, message: "This item failed validation: correct it (C) or reject it (R)." });
      return;
    }
    run({ action: "approve" });
  }, [entry, run]);

  const submitCorrection = () => {
    if (guidance) {
      const l = low.trim() === "" ? null : parseAmount(low);
      const h = high.trim() === "" ? null : parseAmount(high);
      if ((low.trim() !== "" && l === null) || (high.trim() !== "" && h === null)) {
        setResult({ ok: false, message: "Low and high must be numbers, such as 3.925b." });
        return;
      }
      run({ action: "correct", low: l, high: h, quote });
    } else {
      const v = parseAmount(value);
      if (v === null) {
        setResult({ ok: false, message: "The value must be a number, such as 305m or 2.46." });
        return;
      }
      run({ action: "correct", value: v, quote });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea") || e.metaKey || e.ctrlKey || e.altKey || pending) return;
      const key = e.key.toLowerCase();
      if (key === "a" && mode === "view") approve();
      else if (key === "c" && mode === "view") startCorrect();
      else if (key === "r" && mode === "view" && entry.kind === "candidate") {
        setResult(null);
        setMode("reject");
      } else if (key === "escape") setMode("view");
      else if (key === "j" || e.key === "ArrowRight") {
        setIndex((i) => Math.min(i + 1, items.length - 1));
        setMode("view");
        setResult(null);
      } else if (key === "k" || e.key === "ArrowLeft") {
        setIndex((i) => Math.max(i - 1, 0));
        setMode("view");
        setResult(null);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approve, startCorrect, mode, entry, items.length, pending]);

  const { text, quoteStart, quoteEnd } = entry.context;
  const label = guidance
    ? `Guidance: ${String(entry.item.metric)} for ${String(entry.item.targetPeriod)} (${String(entry.item.kind)})`
    : `${String(entry.item.name)}${entry.item.segment ? ` (${String(entry.item.segment)})` : ""}, ${String(entry.item.periodType)}`;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <section className="space-y-4 rounded-lg border border-stone-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>
            {index + 1} of {items.length} · {entry.ticker} {entry.fiscalPeriod} ·{" "}
            <a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="underline">
              {entry.documentType.replace("_", " ")}
            </a>
          </span>
          <span
            className={
              entry.kind === "candidate"
                ? "rounded bg-rose-100 px-2 py-0.5 font-medium text-rose-800 dark:bg-rose-900 dark:text-rose-100"
                : "rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-100"
            }
          >
            {entry.kind === "candidate" ? "Failed validation" : "Low confidence"}
          </span>
        </div>

        <div>
          <h2 className="text-lg font-semibold">{label}</h2>
          <p className="mt-1 text-3xl font-semibold tabular-nums">
            {guidance
              ? entry.item.low == null
                ? "No figures"
                : `${formatValue(entry.item.low, unit)} – ${formatValue(entry.item.high, unit)}`
              : formatValue(entry.item.value, unit)}
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">Model confidence {entry.confidence.toFixed(2)}</p>
        </div>

        <dl className="space-y-2 text-sm">
          <div>
            <dt className="font-medium">Why it's here</dt>
            <dd>
              <ul className="list-disc space-y-1 pl-5 text-slate-700 dark:text-slate-300">
                {entry.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </dd>
          </div>
          {entry.regexValue !== null && (
            <div>
              <dt className="font-medium">Headline table says</dt>
              <dd className="tabular-nums">{formatValue(entry.regexValue, unit)}</dd>
            </div>
          )}
          {!guidance && (
            <div>
              <dt className="font-medium">Company facts (XBRL) cross-check</dt>
              <dd className="tabular-nums">
                {entry.factValues.length ? entry.factValues.map((v) => formatValue(v, unit)).join(", ") : "No matching fact"}
              </dd>
            </div>
          )}
        </dl>

        {mode === "correct" && (
          <form
            className="space-y-3 border-t border-stone-200 pt-3 dark:border-slate-800"
            onSubmit={(e) => {
              e.preventDefault();
              submitCorrection();
            }}
          >
            {guidance ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm">
                  Low
                  <input className="field" value={low} onChange={(e) => setLow(e.target.value)} placeholder="3.925b" />
                </label>
                <label className="text-sm">
                  High
                  <input className="field" value={high} onChange={(e) => setHigh(e.target.value)} placeholder="4.725b" />
                </label>
              </div>
            ) : (
              <label className="block text-sm">
                Correct value ({unit === "usd" ? "dollars; 305m and 4.02b work" : unit === "percent" ? "percent" : "dollars per share"})
                <input autoFocus className="field" value={value} onChange={(e) => setValue(e.target.value)} />
              </label>
            )}
            <label className="block text-sm">
              Quote, copied exactly from the document (select text on the right, then press C)
              <textarea className="field min-h-24" value={quote} onChange={(e) => setQuote(e.target.value)} />
            </label>
            <div className="flex gap-2">
              <button type="submit" disabled={pending} className="btn-primary">
                Save correction
              </button>
              <button type="button" className="btn" onClick={() => setMode("view")}>
                Cancel (Esc)
              </button>
            </div>
          </form>
        )}

        {mode === "reject" && (
          <form
            className="space-y-3 border-t border-stone-200 pt-3 dark:border-slate-800"
            onSubmit={(e) => {
              e.preventDefault();
              run({ action: "reject", reason });
            }}
          >
            <label className="block text-sm">
              Why reject it?
              <input autoFocus className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Not in the document" />
            </label>
            <div className="flex gap-2">
              <button type="submit" disabled={pending || reason.trim().length < 3} className="btn-primary">
                Reject
              </button>
              <button type="button" className="btn" onClick={() => setMode("view")}>
                Cancel (Esc)
              </button>
            </div>
          </form>
        )}

        {mode === "view" && (
          <div className="flex flex-wrap gap-2 border-t border-stone-200 pt-3 dark:border-slate-800">
            <button className="btn-primary" disabled={pending || entry.kind === "candidate"} onClick={approve}>
              Approve <kbd>A</kbd>
            </button>
            <button className="btn" disabled={pending} onClick={startCorrect}>
              Correct <kbd>C</kbd>
            </button>
            {entry.kind === "candidate" && (
              <button className="btn" disabled={pending} onClick={() => setMode("reject")}>
                Reject <kbd>R</kbd>
              </button>
            )}
            <span className="ml-auto self-center text-xs text-slate-500">
              <kbd>J</kbd>/<kbd>K</kbd> next / previous
            </span>
          </div>
        )}

        {result && (
          <p
            role="status"
            className={result.ok ? "text-sm text-emerald-700 dark:text-emerald-400" : "text-sm text-rose-700 dark:text-rose-400"}
          >
            {result.message}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-stone-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <h3 className="border-b border-stone-200 px-4 py-2 text-sm font-medium dark:border-slate-800">
          Source text {quoteStart === null && <span className="font-normal text-rose-600">· quote not found in the document</span>}
        </h3>
        <div
          ref={contextRef}
          className="max-h-[70vh] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[13px] leading-relaxed"
        >
          {quoteStart === null || quoteEnd === null ? (
            text
          ) : (
            <>
              {text.slice(0, quoteStart)}
              <mark className="quote">{text.slice(quoteStart, quoteEnd)}</mark>
              {text.slice(quoteEnd)}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
