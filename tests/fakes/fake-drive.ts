import SparkMD5 from "spark-md5";
import {
  NetworkError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "../../src/ports/http-transport";
import type { SimWorld } from "./sim-world";

const FOLDER = "application/vnd.google-apps.folder";
const ROOT_ID = "root-folder";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface Item {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  createdTime: number;
  modifiedTime: number;
  trashed: boolean;
  content?: Uint8Array;
}

interface Metadata {
  id?: string;
  name?: string;
  parents?: string[];
  mimeType?: string;
}

interface UploadSession {
  fileId?: string;
  metadata: Metadata;
}

/** Returns a response to short-circuit a request, throws to simulate a network failure. */
export type Interceptor = (request: HttpRequest) => HttpResponse | undefined;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBytes = (body: string | ArrayBuffer | undefined): Uint8Array =>
  body === undefined
    ? new Uint8Array()
    : typeof body === "string"
      ? encoder.encode(body)
      : new Uint8Array(body);

/**
 * In-memory Google Drive v3 + OAuth token endpoint behind an `HttpTransport` (DESIGN §8).
 * Models only what the plugin uses, and fails loudly on anything else.
 */
export class FakeDrive {
  readonly items = new Map<string, Item>();
  /** Every request received, for call-count assertions. */
  readonly requests: HttpRequest[] = [];
  clientId = "client-id";
  clientSecret = "client-secret";
  refreshToken = "refresh-token";
  /** Simulated time per request. */
  latencyMs = 5;
  /** Items modified within this window are hidden from `files.list` queries. */
  searchLagMs = 0;
  interceptor: Interceptor | undefined;
  /** Applies the request, then loses the response (the client sees a network error). */
  dropResponse: ((request: HttpRequest) => boolean) | undefined;

  private readonly accessTokens = new Set<string>();
  private readonly sessions = new Map<string, UploadSession>();
  private nextId = 1;

  constructor(private readonly world: SimWorld) {
    this.items.set(ROOT_ID, {
      id: ROOT_ID,
      name: "My Drive",
      mimeType: FOLDER,
      parents: [],
      createdTime: world.now,
      modifiedTime: world.now,
      trashed: false,
    });
  }

  readonly transport: HttpTransport = (request) => {
    this.requests.push(request);
    this.world.advance(this.latencyMs);
    const response = this.interceptor?.(request) ?? this.handle(request);
    if (this.dropResponse?.(request) === true) return Promise.reject(new NetworkError());
    return Promise.resolve(response);
  };

  // ── Test helpers ────────────────────────────────────────────────────────────────────────────

  /** Like Google, revoking the refresh token also invalidates its access tokens. */
  revokeRefreshToken(): void {
    this.refreshToken = "revoked";
    this.accessTokens.clear();
  }

  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  /** Creates folders along `path` (like a user in the Drive web UI) and returns the last ID. */
  mkdirs(path: string): string {
    let parent = ROOT_ID;
    for (const name of path.split("/").filter(Boolean)) {
      const existing = this.children(parent).find((i) => i.name === name && i.mimeType === FOLDER);
      parent = existing?.id ?? this.insert({ name, mimeType: FOLDER, parents: [parent] }).id;
    }
    return parent;
  }

  /** Writes a file at `path` as another app would (creating folders as needed). */
  putFile(path: string, text: string, mimeType = "text/markdown"): string {
    const { parentPath, name } = splitPath(path);
    const parent = this.mkdirs(parentPath);
    const existing = this.children(parent).find((i) => i.name === name && i.mimeType !== FOLDER);
    if (existing !== undefined) {
      existing.content = encoder.encode(text);
      existing.modifiedTime = this.world.now;
      return existing.id;
    }
    return this.insert({ name, mimeType, parents: [parent], content: encoder.encode(text) }).id;
  }

  trash(path: string): void {
    const item = this.resolve(path);
    if (item === undefined) throw new Error(`No such item: ${path}`);
    item.trashed = true;
    item.modifiedTime = this.world.now;
  }

  /** The first non-trashed item at `path` (names matched exactly). */
  resolve(path: string): Item | undefined {
    let current = this.items.get(ROOT_ID);
    for (const name of path.split("/").filter(Boolean)) {
      if (current === undefined) return undefined;
      current = this.children(current.id)
        .filter((i) => i.name === name)
        .sort((a, b) => a.createdTime - b.createdTime)[0];
    }
    return current;
  }

  /** Non-trashed files under `path`, as relative path → text. */
  snapshot(path: string): Record<string, string> {
    const root = this.resolve(path);
    const result: Record<string, string> = {};
    const walk = (folderId: string, prefix: string) => {
      for (const child of this.children(folderId)) {
        const childPath = prefix === "" ? child.name : `${prefix}/${child.name}`;
        if (child.mimeType === FOLDER) walk(child.id, childPath);
        else {
          if (childPath in result) throw new Error(`Duplicate remote file: ${childPath}`);
          result[childPath] = decoder.decode(child.content ?? new Uint8Array());
        }
      }
    };
    if (root !== undefined) walk(root.id, "");
    return result;
  }

  /** Non-trashed child folders of `path` named `name`. */
  countFolders(path: string, name: string): number {
    const parent = this.resolve(path);
    if (parent === undefined) return 0;
    return this.children(parent.id).filter((i) => i.mimeType === FOLDER && i.name === name).length;
  }

  // ── Request handling ────────────────────────────────────────────────────────────────────────

  private handle(request: HttpRequest): HttpResponse {
    if (request.url === TOKEN_URL) return this.token(request);
    if (!this.isAuthorized(request)) return this.error(401, "authError");

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. [drive, v3, files, id]
    const upload = parts[0] === "upload";
    const fileId = parts[upload ? 4 : 3];
    const query = url.searchParams;

    if (request.method === "PUT" && query.has("upload_id"))
      return this.finishUpload(request, query);
    if (!upload && request.method === "GET" && fileId === "generateIds") {
      const count = Number(query.get("count") ?? 10);
      const ids = Array.from({ length: count }, () => `gen-${this.nextId++}`);
      return this.json(200, { kind: "drive#generatedIds", space: "drive", ids });
    }
    if (!upload && request.method === "GET" && fileId === undefined) return this.list(query);
    if (!upload && request.method === "GET" && fileId !== undefined) {
      const item = this.items.get(fileId);
      if (item === undefined) return this.error(404, "notFound");
      return query.get("alt") === "media"
        ? this.respond(200, (item.content ?? new Uint8Array()).slice().buffer)
        : this.json(200, this.resource(item));
    }
    if (!upload && request.method === "POST") {
      const metadata = this.parseMetadata(request.body);
      if (metadata === null) return this.error(400, "forbiddenModifiedTime");
      if (metadata.id !== undefined && this.items.has(metadata.id))
        return this.error(409, "duplicate");
      return this.json(200, this.resource(this.insert(metadataToItem(metadata))));
    }
    if (upload) return this.handleUpload(request, query, fileId);
    return this.error(400, "unsupportedRequest");
  }

  private token(request: HttpRequest): HttpResponse {
    const form = new URLSearchParams(decoder.decode(toBytes(request.body)));
    if (
      form.get("client_id") !== this.clientId ||
      form.get("client_secret") !== this.clientSecret
    ) {
      return this.json(401, { error: "invalid_client" });
    }
    if (form.get("refresh_token") !== this.refreshToken) {
      return this.json(400, { error: "invalid_grant" });
    }
    const token = `access-${this.nextId++}`;
    this.accessTokens.add(token);
    return this.json(200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
  }

  private list(query: URLSearchParams): HttpResponse {
    const predicate = compileQuery(query.get("q") ?? "", (item) => this.isTrashed(item));
    const visibleBefore = this.world.now - this.searchLagMs;
    const matches = [...this.items.values()]
      .filter((item) => item.id !== ROOT_ID && predicate(item))
      .filter((item) => this.searchLagMs === 0 || item.modifiedTime <= visibleBefore)
      .sort((a, b) => a.createdTime - b.createdTime || a.id.localeCompare(b.id));
    const pageSize = Number(query.get("pageSize") ?? 100);
    const start = Number(query.get("pageToken") ?? 0);
    const page = matches.slice(start, start + pageSize);
    const next = start + pageSize < matches.length ? String(start + pageSize) : undefined;
    return this.json(200, {
      files: page.map((item) => this.resource(item)),
      ...(next === undefined ? {} : { nextPageToken: next }),
    });
  }

  private handleUpload(
    request: HttpRequest,
    query: URLSearchParams,
    fileId: string | undefined,
  ): HttpResponse {
    const type = query.get("uploadType");
    if (fileId !== undefined && !this.items.has(fileId)) return this.error(404, "notFound");

    if (type === "resumable") {
      const metadata = this.parseMetadata(request.body);
      if (metadata === null) return this.error(400, "forbiddenModifiedTime");
      const uploadId = `session-${this.nextId++}`;
      this.sessions.set(uploadId, { fileId, metadata });
      return this.respond(200, new ArrayBuffer(0), {
        location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}`,
      });
    }
    if (type === "media" && request.method === "PATCH" && fileId !== undefined) {
      return this.json(200, this.resource(this.writeContent(fileId, toBytes(request.body))));
    }
    if (type === "multipart" && request.method === "POST") {
      const parsed = parseMultipart(request);
      const metadata = this.parseMetadata(parsed.metadata);
      if (metadata === null) return this.error(400, "forbiddenModifiedTime");
      if (metadata.id !== undefined && this.items.has(metadata.id))
        return this.error(409, "duplicate");
      const item = this.insert({ ...metadataToItem(metadata), content: parsed.content });
      return this.json(200, this.resource(item));
    }
    return this.error(400, "unsupportedUpload");
  }

  private finishUpload(request: HttpRequest, query: URLSearchParams): HttpResponse {
    const session = this.sessions.get(query.get("upload_id") ?? "");
    if (session === undefined) return this.error(404, "noSuchSession");
    const presetId = session.metadata.id;
    if (presetId !== undefined && this.items.has(presetId)) return this.error(409, "duplicate");
    const content = toBytes(request.body);
    const item =
      session.fileId !== undefined
        ? this.writeContent(session.fileId, content)
        : this.insert({ ...metadataToItem(session.metadata), content });
    return this.json(200, this.resource(item));
  }

  /** `null` if the metadata tries to set `modifiedTime`, which the plugin must never do. */
  private parseMetadata(body: string | ArrayBuffer | undefined): Metadata | null {
    const text = decoder.decode(toBytes(body));
    if (text.includes("modifiedTime")) return null;
    return text === "" ? {} : (JSON.parse(text) as Metadata);
  }

  private writeContent(fileId: string, content: Uint8Array): Item {
    const item = this.items.get(fileId);
    if (item === undefined) throw new Error(`No such file ${fileId}`);
    item.content = content;
    item.modifiedTime = this.world.now;
    return item;
  }

  private insert(
    fields: Omit<Item, "id" | "createdTime" | "modifiedTime" | "trashed"> & { id?: string },
  ): Item {
    const parents = fields.parents.map((p) => (p === "root" ? ROOT_ID : p));
    const item: Item = {
      ...fields,
      parents,
      id: fields.id ?? `id-${this.nextId++}`,
      createdTime: this.world.now,
      modifiedTime: this.world.now,
      trashed: false,
    };
    this.items.set(item.id, item);
    return item;
  }

  private children(folderId: string): Item[] {
    return [...this.items.values()].filter(
      (item) => item.parents.includes(folderId) && !this.isTrashed(item),
    );
  }

  /** Trashed explicitly or through a trashed ancestor, like Drive's `trashed` field. */
  private isTrashed(item: Item): boolean {
    if (item.trashed) return true;
    const parent = item.parents[0] === undefined ? undefined : this.items.get(item.parents[0]);
    return parent !== undefined && this.isTrashed(parent);
  }

  private isAuthorized(request: HttpRequest): boolean {
    const header = request.headers?.["Authorization"] ?? "";
    return this.accessTokens.has(header.replace(/^Bearer /, ""));
  }

  private resource(item: Item): Record<string, unknown> {
    const isFile =
      item.mimeType !== FOLDER && !item.mimeType.startsWith("application/vnd.google-apps.");
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      parents: item.parents,
      createdTime: new Date(item.createdTime).toISOString(),
      modifiedTime: new Date(item.modifiedTime).toISOString(),
      trashed: this.isTrashed(item),
      ...(isFile
        ? {
            md5Checksum: SparkMD5.ArrayBuffer.hash(
              (item.content ?? new Uint8Array()).slice().buffer,
            ),
            size: String(item.content?.byteLength ?? 0),
          }
        : {}),
    };
  }

  private json(status: number, body: unknown): HttpResponse {
    return this.respond(status, encoder.encode(JSON.stringify(body)).buffer, {
      "content-type": "application/json",
    });
  }

  private error(status: number, reason: string): HttpResponse {
    return this.json(status, { error: { code: status, errors: [{ reason }] } });
  }

  private respond(
    status: number,
    body: ArrayBuffer,
    headers: Record<string, string> = {},
  ): HttpResponse {
    return { status, headers: { date: new Date(this.world.now).toUTCString(), ...headers }, body };
  }
}

function splitPath(path: string): { parentPath: string; name: string } {
  const i = path.lastIndexOf("/");
  return { parentPath: i === -1 ? "" : path.slice(0, i), name: path.slice(i + 1) };
}

function metadataToItem(
  metadata: Metadata,
): Omit<Item, "id" | "createdTime" | "modifiedTime" | "trashed"> & { id?: string } {
  if (metadata.name === undefined || metadata.parents?.length !== 1) {
    throw new Error("Create requires a name and exactly one parent");
  }
  return {
    ...(metadata.id === undefined ? {} : { id: metadata.id }),
    name: metadata.name,
    parents: metadata.parents,
    mimeType: metadata.mimeType ?? "application/octet-stream",
  };
}

// ── Query language subset (DESIGN §6.2) ──────────────────────────────────────────────────────

type Predicate = (item: Item) => boolean;

const unescape = (value: string) => value.replace(/\\(.)/g, "$1");

/** Splits on ` and ` outside quoted strings. */
function splitClauses(q: string): string[] {
  const clauses: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < q.length; i++) {
    const char = q[i] as string;
    if (char === "\\" && inQuote) {
      current += char + (q[++i] ?? "");
      continue;
    }
    if (char === "'") inQuote = !inQuote;
    if (!inQuote && q.startsWith(" and ", i)) {
      clauses.push(current);
      current = "";
      i += 4;
      continue;
    }
    current += char;
  }
  clauses.push(current);
  return clauses.map((c) => c.trim()).filter(Boolean);
}

function compileQuery(q: string, isTrashed: (item: Item) => boolean): Predicate {
  const predicates = splitClauses(q).map((clause): Predicate => {
    let m: RegExpMatchArray | null;
    if ((m = clause.match(/^'((?:[^'\\]|\\.)*)' in parents$/))) {
      const id = unescape(m[1] ?? "");
      const target = id === "root" ? ROOT_ID : id;
      return (item) => item.parents.includes(target);
    }
    if ((m = clause.match(/^trashed = (true|false)$/))) {
      const wanted = m[1] === "true";
      return (item) => isTrashed(item) === wanted;
    }
    if ((m = clause.match(/^mimeType (=|!=) '((?:[^'\\]|\\.)*)'$/))) {
      const [, op, value] = m;
      return (item) => (item.mimeType === unescape(value ?? "")) === (op === "=");
    }
    if ((m = clause.match(/^name = '((?:[^'\\]|\\.)*)'$/))) {
      const name = unescape(m[1] ?? "");
      return (item) => item.name === name;
    }
    if ((m = clause.match(/^modifiedTime > '((?:[^'\\]|\\.)*)'$/))) {
      const time = Date.parse(unescape(m[1] ?? ""));
      return (item) => item.modifiedTime > time;
    }
    throw new Error(`FakeDrive: unsupported query clause: ${clause}`);
  });
  return (item) => predicates.every((p) => p(item));
}

// ── multipart/related parsing ────────────────────────────────────────────────────────────────

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function parseMultipart(request: HttpRequest): { metadata: string; content: Uint8Array } {
  const boundary = /boundary=(.+)$/.exec(request.contentType ?? "")?.[1];
  if (boundary === undefined) throw new Error("multipart request without boundary");
  const body = toBytes(request.body);
  const headerEnd = encoder.encode("\r\n\r\n");
  const delimiter = encoder.encode(`\r\n--${boundary}`);

  const metaStart = indexOfBytes(body, headerEnd) + headerEnd.length;
  const metaEnd = indexOfBytes(body, delimiter, metaStart);
  const contentStart = indexOfBytes(body, headerEnd, metaEnd) + headerEnd.length;
  const contentEnd = indexOfBytes(body, encoder.encode(`\r\n--${boundary}--`), contentStart);
  return {
    metadata: decoder.decode(body.slice(metaStart, metaEnd)),
    content: body.slice(contentStart, contentEnd),
  };
}
