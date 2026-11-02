import { api, ApiError } from "@/lib/api";
import { ReviewQueue } from "./ReviewQueue";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  let data;
  try {
    data = await api.review();
  } catch (err) {
    const message = err instanceof ApiError ? err.message : "The API is not reachable. Is `pnpm dev:api` running?";
    return (
      <div className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100">
        {message}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">Review queue</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {data.total === 0 ? "Nothing waiting." : `${data.total} waiting`}
          {data.total > data.items.length ? ` (showing the oldest ${data.items.length})` : ""}
        </p>
      </div>
      {data.items.length === 0 ? (
        <p className="rounded-lg border border-stone-200 bg-white p-6 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          Every extraction is validated and approved. New items appear here when a figure fails validation or the model is
          unsure.
        </p>
      ) : (
        <ReviewQueue items={data.items} />
      )}
    </div>
  );
}
