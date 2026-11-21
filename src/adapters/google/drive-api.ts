import { RESUMABLE_UPLOAD_THRESHOLD_BYTES } from "../../domain/constants";
import { withRetry, type RetryPolicy } from "../../lib/retry";
import type { HttpRequest, HttpResponse } from "../../ports/http-transport";
import { DriveHttpError } from "./drive-errors";
import { FOLDER_MIME_TYPE } from "./drive-query";
import { parseJson, type HttpClient } from "./http-client";
import type { OAuthTokenProvider } from "./oauth-token-provider";

const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FILE_FIELDS = "id,name,mimeType,parents,createdTime,modifiedTime,md5Checksum,size,trashed";
const PAGE_SIZE = 1000;
/** IDs fetched per `generateIds` call. */
const ID_BATCH_SIZE = 100;

/** The subset of the Drive v3 file resource the plugin uses. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  createdTime: string;
  modifiedTime: string;
  md5Checksum?: string;
  /** Bytes, as a decimal string. */
  size?: string;
  trashed?: boolean;
}

interface FileList {
  files: DriveFile[];
  nextPageToken?: string;
}

/** Metadata sent on create. Never includes `modifiedTime` (DESIGN §6.1). */
interface CreateMetadata {
  /** Pre-generated ID that makes creates idempotent (DESIGN §6.3). */
  id: string;
  name: string;
  parents: string[];
  mimeType?: string;
}

/** Low-level Drive v3 calls with auth and retries (DESIGN §6.1, §6.4). */
export class DriveApi {
  private readonly idPool: string[] = [];
  private idRefill: Promise<void> | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly tokens: OAuthTokenProvider,
    private readonly retryPolicy: RetryPolicy,
  ) {}

  async list(query: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: query,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: String(PAGE_SIZE),
        spaces: "drive",
      });
      if (pageToken !== undefined) params.set("pageToken", pageToken);
      const page = parseJson<FileList>(
        await this.call({ method: "GET", url: `${FILES_URL}?${params.toString()}` }),
      );
      files.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return files;
  }

  /** The file's metadata, or `null` if it doesn't exist. */
  get(fileId: string): Promise<DriveFile | null> {
    return withRetry(() => this.getOnce(fileId), this.retryPolicy);
  }

  async createFolder(name: string, parentId: string): Promise<DriveFile> {
    const metadata: CreateMetadata = {
      id: await this.nextId(),
      name,
      parents: [parentId],
      mimeType: FOLDER_MIME_TYPE,
    };
    return this.createIdempotently(metadata.id, async () =>
      parseJson<DriveFile>(
        await this.callOnce({
          method: "POST",
          url: `${FILES_URL}?fields=${FILE_FIELDS}`,
          contentType: "application/json; charset=UTF-8",
          body: JSON.stringify(metadata),
        }),
      ),
    );
  }

  async createFile(name: string, parentId: string, data: ArrayBuffer): Promise<DriveFile> {
    const metadata: CreateMetadata = { id: await this.nextId(), name, parents: [parentId] };
    if (data.byteLength > RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
      return this.createIdempotently(metadata.id, () =>
        this.resumableUploadOnce("POST", UPLOAD_URL, metadata, data),
      );
    }
    const { body, contentType } = multipartBody(metadata, data);
    return this.createIdempotently(metadata.id, async () =>
      parseJson<DriveFile>(
        await this.callOnce({
          method: "POST",
          url: `${UPLOAD_URL}?uploadType=multipart&fields=${FILE_FIELDS}`,
          contentType,
          body,
        }),
      ),
    );
  }

  /** Replaces the file's content. Sends no metadata, so `modifiedTime` is never set. */
  async updateFile(fileId: string, data: ArrayBuffer): Promise<DriveFile> {
    const url = `${UPLOAD_URL}/${fileId}`;
    if (data.byteLength > RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
      return withRetry(() => this.resumableUploadOnce("PATCH", url, {}, data), this.retryPolicy);
    }
    return parseJson<DriveFile>(
      await this.call({
        method: "PATCH",
        url: `${url}?uploadType=media&fields=${FILE_FIELDS}`,
        contentType: "application/octet-stream",
        body: data,
      }),
    );
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    return (await this.call({ method: "GET", url: `${FILES_URL}/${fileId}?alt=media` })).body;
  }

  /** Initiates a resumable session and sends the bytes in one PUT. */
  private async resumableUploadOnce(
    method: "POST" | "PATCH",
    url: string,
    metadata: CreateMetadata | Record<string, never>,
    data: ArrayBuffer,
  ): Promise<DriveFile> {
    const session = await this.callOnce({
      method,
      url: `${url}?uploadType=resumable&fields=${FILE_FIELDS}`,
      contentType: "application/json; charset=UTF-8",
      headers: { "X-Upload-Content-Type": "application/octet-stream" },
      body: JSON.stringify(metadata),
    });
    const location = session.headers["location"];
    if (location === undefined) throw new DriveHttpError(session.status, "missingUploadLocation");
    const response = await this.callOnce({
      method: "PUT",
      url: location,
      contentType: "application/octet-stream",
      body: data,
    });
    return parseJson<DriveFile>(response);
  }

  /**
   * Retries a create safely: the ID is fixed up front, so if a request fails (e.g. its response
   * was lost after Drive applied it), the file is looked up by ID before trying again. A retried
   * create can therefore never produce a duplicate.
   */
  private createIdempotently(id: string, create: () => Promise<DriveFile>): Promise<DriveFile> {
    return withRetry(async () => {
      try {
        return await create();
      } catch (error) {
        const existing = await this.getOnce(id);
        if (existing !== null) return existing;
        throw error;
      }
    }, this.retryPolicy);
  }

  private async getOnce(fileId: string): Promise<DriveFile | null> {
    try {
      return parseJson<DriveFile>(
        await this.callOnce({ method: "GET", url: `${FILES_URL}/${fileId}?fields=${FILE_FIELDS}` }),
      );
    } catch (error) {
      if (error instanceof DriveHttpError && error.status === 404) return null;
      throw error;
    }
  }

  /** A pre-generated file ID; refilled in batches, one refill at a time. */
  private async nextId(): Promise<string> {
    while (this.idPool.length === 0) {
      this.idRefill ??= this.fetchIds().finally(() => {
        this.idRefill = null;
      });
      await this.idRefill;
    }
    return this.idPool.pop() as string;
  }

  private async fetchIds(): Promise<void> {
    const response = await this.call({
      method: "GET",
      url: `${FILES_URL}/generateIds?count=${ID_BATCH_SIZE}&space=drive&type=files`,
    });
    this.idPool.push(...parseJson<{ ids: string[] }>(response).ids);
  }

  private call(request: HttpRequest): Promise<HttpResponse> {
    return withRetry(() => this.callOnce(request), this.retryPolicy);
  }

  /** One authorized request; on 401 refreshes the access token once and retries. */
  private async callOnce(request: HttpRequest): Promise<HttpResponse> {
    let response = await this.http.send(await this.authorize(request));
    if (response.status === 401) {
      this.tokens.invalidate();
      response = await this.http.send(await this.authorize(request));
    }
    if (response.status >= 400) throw DriveHttpError.fromResponse(response);
    return response;
  }

  private async authorize(request: HttpRequest): Promise<HttpRequest> {
    const token = await this.tokens.getAccessToken();
    return { ...request, headers: { ...request.headers, Authorization: `Bearer ${token}` } };
  }
}

/** `multipart/related` body: JSON metadata part, then the media part. */
export function multipartBody(
  metadata: object,
  data: ArrayBuffer,
): { body: ArrayBuffer; contentType: string } {
  const boundary = `gdrive-sync-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(new Uint8Array(data), head.byteLength);
  body.set(tail, head.byteLength + data.byteLength);
  return { body: body.buffer, contentType: `multipart/related; boundary=${boundary}` };
}
