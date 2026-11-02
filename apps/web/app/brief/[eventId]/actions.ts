"use server";

import type { DocumentContext } from "@eia/shared";
import { api, ApiError } from "@/lib/api";

/** Source text around a citation, fetched on the server so the browser never calls the API. */
export async function loadSource(
  documentId: string,
  start: number,
  end: number,
): Promise<{ ok: true; context: DocumentContext } | { ok: false; message: string }> {
  try {
    return { ok: true, context: await api.documentContext(documentId, start, end) };
  } catch (err) {
    return { ok: false, message: err instanceof ApiError ? err.message : "The API could not be reached" };
  }
}
