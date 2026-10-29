/** File names and MIME types: extensions, and Directus' MIME type allow list (FILES_MIME_TYPE_ALLOW_LIST). */

/** The usual extension of common MIME types (the first one mime-db lists, unless a better known one exists). */
const EXTENSIONS: Record<string, string> = {
  'application/gzip': 'gz',
  'application/javascript': 'js',
  'application/json': 'json',
  'application/msword': 'doc',
  'application/octet-stream': 'bin',
  'application/pdf': 'pdf',
  'application/rtf': 'rtf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/wasm': 'wasm',
  'application/x-7z-compressed': '7z',
  'application/x-tar': 'tar',
  'application/xml': 'xml',
  'application/zip': 'zip',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'oga',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'font/otf': 'otf',
  'font/ttf': 'ttf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tif',
  'image/vnd.microsoft.icon': 'ico',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'text/calendar': 'ics',
  'text/css': 'css',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/javascript': 'js',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'text/xml': 'xml',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
};

/** The extension (without the dot) for a MIME type; null when it isn't a known one. */
export const extensionOf = (mimeType: string | null | undefined): string | null =>
  (mimeType && EXTENSIONS[mimeType.split(';')[0]!.trim().toLowerCase()]) || null;

/** Node's path.extname of a file name: from its last dot, unless the name starts with it. */
export function extname(filename: string): string {
  const base = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

/** Node's path.parse(filename).name: the name without its extension. */
export function stem(filename: string): string {
  const base = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * The extension for a stored object (with the dot): the file name's, if it is a plain one,
 * otherwise the MIME type's (Directus: the file name's, else the type's).
 */
export function storageExtension(filename: string, mimeType: string | null | undefined): string {
  const ext = extname(filename);
  if (/^\.[A-Za-z0-9]{1,16}$/.test(ext)) return ext.toLowerCase();
  const fromType = extensionOf(mimeType);
  return fromType ? `.${fromType}` : '';
}

/** A MIME type matches a pattern of the allow list (`*` matches within a segment, as minimatch does): `image/*`, `*\/*`. */
export function mimeMatches(mimeType: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.trim().split('*').map(escape).join('[^/]*')}$`, 'i');
  return re.test(mimeType);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a MIME type is in the allow list (Directus FILES_MIME_TYPE_ALLOW_LIST; default `*\/*`). */
export const mimeAllowed = (mimeType: string, allowList: readonly string[]) => allowList.some((p) => mimeMatches(mimeType, p));
