import { MAX_RETRIES } from "../../domain/constants";
import type { RetryDecision, RetryPolicy } from "../../lib/retry";
import type { Clock } from "../../ports/clock";
import { NetworkError, type HttpResponse } from "../../ports/http-transport";
import { decodeText } from "./http-client";

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

interface GoogleErrorBody {
  error?: string | { status?: string; errors?: { reason?: string }[] };
}

/** An HTTP error from a Google endpoint. The message holds only status and reason. */
export class DriveHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}${reason ? ` ${reason}` : ""}`);
    this.name = "DriveHttpError";
  }

  static fromResponse(response: HttpResponse): DriveHttpError {
    return new DriveHttpError(
      response.status,
      parseReason(response),
      parseRetryAfter(response.headers["retry-after"]),
    );
  }
}

function parseReason(response: HttpResponse): string {
  try {
    const body = JSON.parse(decodeText(response.body)) as GoogleErrorBody;
    if (typeof body.error === "string") return body.error;
    return body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
  } catch {
    return "";
  }
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Retryable: network errors, 429, 5xx, and 403 rate-limit reasons (DESIGN §6.4). */
export function classifyDriveError(error: unknown): RetryDecision {
  if (error instanceof NetworkError) return { retry: true };
  if (error instanceof DriveHttpError) {
    const retry =
      error.status === 429 ||
      error.status >= 500 ||
      (error.status === 403 && RATE_LIMIT_REASONS.has(error.reason));
    return retry ? { retry, delayMs: error.retryAfterMs } : { retry: false };
  }
  return { retry: false };
}

export function driveRetryPolicy(clock: Clock, random: () => number): RetryPolicy {
  return {
    maxRetries: MAX_RETRIES,
    baseDelayMs: 500,
    maxDelayMs: 8000,
    classify: classifyDriveError,
    sleep: (ms) => clock.sleep(ms),
    random,
  };
}
