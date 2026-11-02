import { ApiError } from "@/lib/api";

export function ApiErrorNote({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError ? error.message : "The API is not reachable. Is `pnpm dev:api` running?";
  return (
    <p className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100">
      {message}
    </p>
  );
}
