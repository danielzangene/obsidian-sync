import SparkMD5 from "spark-md5";

/** Hex MD5 of `data`. Used as a content checksum (matches Drive's `md5Checksum`), not for security. */
export function md5(data: ArrayBuffer): string {
  return SparkMD5.ArrayBuffer.hash(data);
}
