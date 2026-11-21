import { requestUrl } from "obsidian";
import { NetworkError, type HttpTransport } from "../../ports/http-transport";

/** `HttpTransport` on Obsidian's `requestUrl` (no CORS limits on desktop or mobile). */
export const obsidianTransport: HttpTransport = async (request) => {
  try {
    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      contentType: request.contentType,
      body: request.body,
      throw: false,
    });
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers))
      headers[name.toLowerCase()] = value;
    return { status: response.status, headers, body: response.arrayBuffer };
  } catch {
    throw new NetworkError();
  }
};
