const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5 };

/**
 * A size such as "100mb", "1.5GB" or "2048" (bytes), as the `bytes` package Directus uses for
 * FILES_MAX_UPLOAD_SIZE reads it (units of 1024); null when it isn't one.
 */
export function parseBytes(value: string | undefined | null): number | null {
  if (value == null) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)?\s*$/i.exec(value);
  if (!m) return null;
  return Math.floor(Number(m[1]) * UNITS[(m[2] ?? 'b').toLowerCase()]!);
}
