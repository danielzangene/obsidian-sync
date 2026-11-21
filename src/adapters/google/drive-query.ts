/** Builders for Drive v3 `q` expressions. */

export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
export const GOOGLE_NATIVE_MIME_PREFIX = "application/vnd.google-apps.";

/** Quotes a string literal, escaping `\` and `'`. */
export function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export const inParents = (folderId: string) => `${quote(folderId)} in parents`;
export const nameEquals = (name: string) => `name = ${quote(name)}`;
export const modifiedAfter = (timeMs: number) =>
  `modifiedTime > ${quote(new Date(timeMs).toISOString())}`;
export const NOT_TRASHED = "trashed = false";
export const IS_FOLDER = `mimeType = ${quote(FOLDER_MIME_TYPE)}`;

export const and = (...clauses: string[]) => clauses.join(" and ");
