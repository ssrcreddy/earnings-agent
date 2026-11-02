import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { BriefView } from "./BriefView";

export const dynamic = "force-dynamic";

export default async function BriefPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  let brief;
  try {
    brief = await api.brief(eventId);
  } catch (err) {
    const notFound = err instanceof ApiError && err.code === "BRIEF_NOT_FOUND";
    return (
      <div className="space-y-3">
        <Link href="/briefs" className="text-sm text-slate-500 hover:underline">
          ← All briefs
        </Link>
        <p className="rounded-lg border border-stone-200 bg-white p-6 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          {notFound
            ? "There is no brief for this print yet."
            : err instanceof ApiError
              ? err.message
              : "The API is not reachable. Is `pnpm dev:api` running?"}
        </p>
      </div>
    );
  }
  return <BriefView brief={brief} />;
}
