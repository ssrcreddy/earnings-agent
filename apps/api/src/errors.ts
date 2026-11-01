import type { ErrorCode } from "@eia/shared";

/** An error the API turns into `{ error: { code, message } }` with a stable code (§21). */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** A non-2xx response from an upstream API, kept separate so jobs can classify it (§15). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} from ${url}`);
    this.name = "HttpError";
  }

  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
