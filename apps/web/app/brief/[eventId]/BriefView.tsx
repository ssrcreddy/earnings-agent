"use client";

import type { BriefCitation, BriefResponse, DocumentContext } from "@eia/shared";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import { loadSource } from "./actions";

/** [M1] markers become links the renderer turns into citation buttons. */
function linkCitations(md: string): string {
  return md.replace(/\[([MG]\d+)\]/g, "[$1](#cite-$1)");
}

export function BriefView({ brief }: { brief: BriefResponse }) {
  const [active, setActive] = useState<BriefCitation | null>(null);
  const [source, setSource] = useState<DocumentContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const markRef = useRef<HTMLElement>(null);
  const byMarker = new Map(brief.citations.map((c) => [c.marker, c]));

  const open = (c: BriefCitation) => {
    setActive(c);
    setError(null);
    startTransition(async () => {
      const r = await loadSource(c.documentId, c.charStart, c.charEnd);
      if (r.ok) setSource(r.context);
      else {
        setSource(null);
        setError(r.message);
      }
    });
  };

  // Bring the highlighted passage into view whenever a citation opens.
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [source]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <Link href="/briefs" className="text-sm text-slate-500 hover:underline">
            ← All briefs
          </Link>
          <h1 className="text-xl font-semibold">
            {brief.companyName} ({brief.ticker}) · {brief.fiscalPeriod}
          </h1>
        </div>
        <p className="text-xs text-slate-500">
          Reported {new Date(brief.reportDate).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · v
          {brief.version}
          {brief.previousVersions ? ` (${brief.previousVersions} earlier)` : ""} · written by {brief.writer}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <article className="brief rounded-lg border border-stone-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <ReactMarkdown
            skipHtml
            components={{
              a: ({ href, children }) => {
                const marker = href?.startsWith("#cite-") ? href.slice("#cite-".length) : null;
                const c = marker ? byMarker.get(marker) : undefined;
                if (!c) return <a href={href}>{children}</a>;
                return (
                  <button
                    type="button"
                    onClick={() => open(c)}
                    title={`${c.label}: "${c.quote}"`}
                    className={`cite ${active?.marker === c.marker ? "cite-active" : ""}`}
                  >
                    {children}
                  </button>
                );
              },
            }}
          >
            {linkCitations(brief.bodyMd)}
          </ReactMarkdown>
          <p className="mt-6 border-t border-stone-200 pt-3 text-xs text-slate-500 dark:border-slate-800">
            Every figure is checked against the fact sheet before publishing; click a citation to see the passage it comes from.
            Factual summary only - not investment advice.
          </p>
        </article>

        <aside className="space-y-3">
          <section className="rounded-lg border border-stone-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <h2 className="border-b border-stone-200 px-4 py-2 text-sm font-medium dark:border-slate-800">
              {active ? (
                <>
                  {active.marker} · {active.label}
                  {active.note && <span className="ml-2 font-normal text-amber-700 dark:text-amber-400">{active.note}</span>}
                </>
              ) : (
                "Source"
              )}
            </h2>
            <div className="max-h-[60vh] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[13px] leading-relaxed">
              {!active && <p className="font-sans text-slate-500">Click a citation such as [M1] to open its source passage.</p>}
              {active && pending && <p className="font-sans text-slate-500">Loading the source…</p>}
              {active && error && <p className="font-sans text-rose-600">{error}</p>}
              {active && source && !pending && (
                <>
                  {source.text.slice(0, source.highlightStart)}
                  <mark ref={markRef} className="quote">
                    {source.text.slice(source.highlightStart, source.highlightEnd)}
                  </mark>
                  {source.text.slice(source.highlightEnd)}
                </>
              )}
            </div>
            {active && (
              <p className="border-t border-stone-200 px-4 py-2 text-xs dark:border-slate-800">
                <a href={active.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                  Open the {active.documentType.replace("_", " ")} on SEC EDGAR
                </a>
              </p>
            )}
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
            <h2 className="mb-2 font-medium">Citations</h2>
            <ol className="space-y-2">
              {brief.citations.map((c) => (
                <li key={c.marker}>
                  <button type="button" onClick={() => open(c)} className="cite">
                    {c.marker}
                  </button>{" "}
                  <span className="font-medium">{c.label}</span>
                  {c.note && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">({c.note})</span>}
                  <p className="mt-0.5 text-xs text-slate-500">“{c.quote}”</p>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
