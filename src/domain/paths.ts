/** Vault-relative, `/`-separated path helpers. The vault root is `""`. */

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

export function pathSegments(path: string): string[] {
  return path === "" ? [] : path.split("/");
}
