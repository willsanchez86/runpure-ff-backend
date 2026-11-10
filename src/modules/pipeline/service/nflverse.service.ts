import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { parse } from 'csv-parse';
import { RELEASE_BASE, type DatasetDef } from './datasets.js';

// Generic client name; never put personal details here.
const USER_AGENT = 'runpure-ff-pipeline';

export interface SourceVersion {
  url: string;
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
}

export function sourceUrl(def: DatasetDef, season: number): string {
  return `${RELEASE_BASE}/${def.path(season)}`;
}

/**
 * Version check without downloading. GitHub redirects release assets to a storage host;
 * fetch follows the redirect. Whether that host returns ETag and Last-Modified is to be
 * verified at build (ETL spec Â§4.2); without them every run reloads the piece.
 */
export async function headSource(url: string): Promise<SourceVersion> {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HEAD ${url} -> HTTP ${res.status}`);
  const length = res.headers.get('content-length');
  return {
    url,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    contentLength: length === null ? null : Number(length),
  };
}

/**
 * Streams a CSV from its URL and yields one object per row (header -> string value).
 * Nothing is held in memory beyond the current parser buffers (ADR-0008: jobs share the
 * API process, so files are never loaded whole).
 */
export async function openCsv(url: string, gzip = false): Promise<AsyncIterable<Record<string, string>>> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> HTTP ${res.status}`);

  let stream: NodeJS.ReadableStream = Readable.fromWeb(res.body as unknown as WebReadableStream);
  if (gzip) stream = stream.pipe(createGunzip());

  const parser = parse({
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  return stream.pipe(parser) as unknown as AsyncIterable<Record<string, string>>;
}
