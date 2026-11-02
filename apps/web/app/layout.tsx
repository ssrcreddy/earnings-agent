import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Earnings Intelligence",
  description: "Cited earnings briefs, guidance history and extraction review.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <header className="border-b border-stone-200 bg-white/80 dark:border-slate-800 dark:bg-slate-900/80">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 text-sm">
            <span className="font-semibold">Earnings Intelligence</span>
            <Link href="/week" className="text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">
              Week
            </Link>
            <Link href="/briefs" className="text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">
              Briefs
            </Link>
            <Link href="/alerts" className="text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">
              Alerts
            </Link>
            <Link href="/review" className="text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">
              Review queue
            </Link>
            <Link href="/costs" className="text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">
              Costs
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
