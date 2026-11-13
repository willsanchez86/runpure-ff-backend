/** Reads nflverse release files over HTTPS with transport guards (ETL spec §4.1, §4.2). */
import { Readable, Transform, pipeline, type TransformCallback } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { parse } from 'csv-parse';
import { env } from '../../../config/env.js';
import type { DatasetDef } from './datasets.js';

// Generic client name; never put personal details here.
const USER_AGENT = 'runpure-ff-pipeline';
// GitHub redirects a release asset once to its storage host; a few hops is ample headroom.
const MAX_REDIRECTS = 4;

/** Version headers of a release file, compared with the ledger to skip unchanged files. */
export interface SourceVersion {
  url: string;
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
}

/** Full download URL of a dataset's file for one season. */
export function sourceUrl(def: DatasetDef, season: number): string {
  return `${env.releaseBase}/${def.path(season)}`;
}

/** True when `raw` is an https URL whose host is in the release allowlist (SSRF guard, §4.2). */
export function isAllowedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return env.releaseHostAllowlist.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/**
 * Fetches `url`, following redirects by hand so the start URL and every hop are host-checked
 * (§4.2): `redirect: 'follow'` would let a redirect escape the allowlist. An AbortController bounds
 * the time to response headers (not the whole download, which streams at insert speed).
 */
async function fetchGuarded(url: string, method: 'GET' | 'HEAD'): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUrl(current)) throw new Error(`${method} blocked to disallowed URL: ${current}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('response header timeout')), env.downloadHeaderTimeoutMs);
    let res: Response;
    try {
      res = await fetch(current, { method, redirect: 'manual', headers: { 'user-agent': USER_AGENT }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`redirect without Location from ${new URL(current).hostname}`);
      current = new URL(location, current).toString();
      continue;
    }
    return res; // final (non-redirect) response; headers such as ETag come from here
  }
  throw new Error(`too many redirects for ${url}`);
}

/** Passes bytes through, destroying the stream if more than `max` pass (size / bomb guard). */
class ByteCap extends Transform {
  private total = 0;
  constructor(private readonly max: number, private readonly label: string) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.total += chunk.length;
    if (this.total > this.max) cb(new Error(`${this.label} exceeded ${this.max} bytes`));
    else cb(null, chunk);
  }
}

/** Passes bytes through, destroying the stream if no chunk arrives for `ms` (stall guard). */
class IdleTimeout extends Transform {
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly ms: number) {
    super();
    this.arm();
  }
  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.destroy(new Error(`download idle for ${this.ms}ms`)), this.ms);
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.arm();
    cb(null, chunk);
  }
  override _flush(cb: TransformCallback): void {
    clearTimeout(this.timer);
    cb();
  }
  override _destroy(err: Error | null, cb: (e: Error | null) => void): void {
    clearTimeout(this.timer);
    cb(err);
  }
}

/**
 * Version check without downloading. Follows GitHub's redirect to its storage host by hand (§4.2),
 * returning the ETag, Last-Modified and Content-Length of the final response (the redirect itself
 * carries none). If the host returns no ETag the piece reloads every run (§4.2).
 */
export async function headSource(url: string): Promise<SourceVersion> {
  const res = await fetchGuarded(url, 'HEAD');
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
 * Streams a CSV from its URL and yields one object per row (header -> string value). The stream is
 * guarded by an idle timeout, a download size cap and (for gzip) a decompressed size cap, so a
 * stalled, oversized or decompression-bomb download fails the piece instead of exhausting the
 * always-on process (§4.2). Nothing is held in memory beyond the parser buffers (ADR-0008).
 */
export async function openCsv(url: string, gzip = false): Promise<AsyncIterable<Record<string, string>>> {
  const res = await fetchGuarded(url, 'GET');
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> HTTP ${res.status}`);

  const source = Readable.fromWeb(res.body as unknown as WebReadableStream);
  const parser = parse({ columns: true, bom: true, skip_empty_lines: true, relax_column_count: true });
  const idle = new IdleTimeout(env.downloadIdleTimeoutMs);
  const downloadCap = new ByteCap(env.maxDownloadBytes, 'download');
  // pipeline, unlike pipe, passes a download/gunzip/guard error on to the parser, so the caller's
  // loop over rows fails (and the run lock is released) instead of waiting forever.
  const ignore = (): void => {};
  if (gzip) {
    const decompressCap = new ByteCap(env.maxDecompressedBytes, 'decompressed data');
    pipeline(source, idle, downloadCap, createGunzip(), decompressCap, parser, ignore);
  } else {
    pipeline(source, idle, downloadCap, parser, ignore);
  }
  return parser as unknown as AsyncIterable<Record<string, string>>;
}
