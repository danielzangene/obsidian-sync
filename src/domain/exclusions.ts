import { pathSegments } from "./paths";

/** Characters Obsidian doesn't allow in file names (PRD FR-5). */
const INVALID_NAME_CHARS = /[*"\\/<>:|?]/;

const EXCLUDED_NAMES = new Set(["Thumbs.db"]);

/** True for paths that are never synced: any segment starting with `.`, or OS junk files. */
export function isExcludedPath(path: string): boolean {
  return pathSegments(path).some((name) => name.startsWith(".") || EXCLUDED_NAMES.has(name));
}

/** True if Obsidian can use `name` as a file or folder name. */
export function isValidName(name: string): boolean {
  return name.trim() !== "" && name !== "." && name !== ".." && !INVALID_NAME_CHARS.test(name);
}
