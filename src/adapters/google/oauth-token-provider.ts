import { AuthError, MissingCredentialsError } from "../../domain/errors";
import { withRetry, type RetryPolicy } from "../../lib/retry";
import type { Clock } from "../../ports/clock";
import { DriveHttpError } from "./drive-errors";
import { parseJson, type HttpClient } from "./http-client";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Refresh slightly before expiry so a token can't expire mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Returns the credentials, or `null` if any is missing. */
export type CredentialsProvider = () => OAuthCredentials | null;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/** Exchanges the refresh token for access tokens. Access tokens live in memory only. */
export class OAuthTokenProvider {
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly credentials: CredentialsProvider,
    private readonly clock: Clock,
    private readonly retryPolicy: RetryPolicy,
  ) {}

  invalidate(): void {
    this.token = null;
  }

  async getAccessToken(): Promise<string> {
    if (this.token !== null && this.clock.now() < this.token.expiresAtMs - EXPIRY_MARGIN_MS) {
      return this.token.value;
    }
    const credentials = this.credentials();
    if (credentials === null) throw new MissingCredentialsError();

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
    }).toString();

    try {
      const response = await withRetry(async () => {
        const res = await this.http.send({
          method: "POST",
          url: TOKEN_URL,
          contentType: "application/x-www-form-urlencoded",
          body,
        });
        if (res.status >= 400) throw DriveHttpError.fromResponse(res);
        return res;
      }, this.retryPolicy);
      const parsed = parseJson<TokenResponse>(response);
      this.token = {
        value: parsed.access_token,
        expiresAtMs: this.clock.now() + parsed.expires_in * 1000,
      };
      return parsed.access_token;
    } catch (error) {
      throw toAuthError(error);
    }
  }
}

function toAuthError(error: unknown): unknown {
  if (!(error instanceof DriveHttpError)) return error;
  if (error.reason === "invalid_grant") return new AuthError();
  if (error.reason === "invalid_client" || error.reason === "unauthorized_client") {
    return new AuthError("Client ID or client secret is invalid. Check settings.");
  }
  return error;
}
