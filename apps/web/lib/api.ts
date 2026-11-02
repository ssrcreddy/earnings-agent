// Server-side API client. Response types come from @eia/shared, so the UI can't invent a shape
// (or a status) the backend doesn't have (§22).
import "server-only";
import type {
  BriefResponse,
  BriefSummary,
  DocumentContext,
  ErrorBody,
  ReviewAction,
  ReviewKind,
  ReviewListResponse,
  ReviewResult,
} from "@eia/shared";

const API_URL = process.env.API_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null;
    throw new ApiError(res.status, body?.error.code ?? "INTERNAL", body?.error.message ?? `API error ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  review: () => request<ReviewListResponse>("/review"),
  act: (kind: ReviewKind, id: string, action: ReviewAction) =>
    request<ReviewResult>(`/review/${kind}/${id}`, { method: "PATCH", body: JSON.stringify(action) }),
  briefs: () => request<{ briefs: BriefSummary[] }>("/briefs"),
  brief: (eventId: string) => request<BriefResponse>(`/events/${encodeURIComponent(eventId)}/brief`),
  documentContext: (documentId: string, start: number, end: number) =>
    request<DocumentContext>(`/documents/${encodeURIComponent(documentId)}/context?start=${start}&end=${end}`),
};
