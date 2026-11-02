"use server";

import { ReviewAction, ReviewKind } from "@eia/shared";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

/** Review actions run on the server, so the browser never talks to the API directly. */
export async function submitReview(kind: string, id: string, action: unknown): Promise<ActionResult> {
  const k = ReviewKind.safeParse(kind);
  const a = ReviewAction.safeParse(action);
  if (!k.success || !a.success) return { ok: false, message: "Invalid review action" };
  try {
    const r = await api.act(k.data, id, a.data);
    revalidatePath("/review");
    const golden = r.goldenFile ? " Saved to the golden set." : "";
    return { ok: true, message: `${r.status[0]!.toUpperCase()}${r.status.slice(1)}.${golden}` };
  } catch (err) {
    return { ok: false, message: err instanceof ApiError ? err.message : "The API could not be reached" };
  }
}
