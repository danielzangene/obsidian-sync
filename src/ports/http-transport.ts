export interface HttpRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  /** Header names are lower-case. */
  headers: Record<string, string>;
  body: ArrayBuffer;
}

/** Sends one HTTP request. Rejects only on network failure, never on HTTP status. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export class NetworkError extends Error {
  constructor(message = "Network error") {
    super(message);
    this.name = "NetworkError";
  }
}
