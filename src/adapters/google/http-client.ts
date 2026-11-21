import type { HttpRequest, HttpResponse, HttpTransport } from "../../ports/http-transport";

/**
 * Sends requests through the transport and captures the server time of the first response in a
 * run (DESIGN §5.1). All Google calls, including token requests, go through one instance.
 */
export class HttpClient {
  private capturing = false;
  private firstServerTimeMs: number | null = null;

  constructor(private readonly transport: HttpTransport) {}

  /** The `Date` header of the next response becomes this run's server time. */
  startRun(): void {
    this.capturing = true;
    this.firstServerTimeMs = null;
  }

  get serverTimeMs(): number | null {
    return this.firstServerTimeMs;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const response = await this.transport(request);
    if (this.capturing) {
      const time = Date.parse(response.headers["date"] ?? "");
      if (!Number.isNaN(time)) {
        this.firstServerTimeMs = time;
        this.capturing = false;
      }
    }
    return response;
  }
}

export function decodeText(body: ArrayBuffer): string {
  return new TextDecoder().decode(body);
}

export function parseJson<T>(response: HttpResponse): T {
  return JSON.parse(decodeText(response.body)) as T;
}
