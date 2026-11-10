import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Trusted documents (ADR-0016 item 3, ADR-0017 item 9): the frontend's operations from
 * persisted/frontend.json, plus this repo's operator operations, keyed by SHA-256.
 */
export function loadPersistedStore(dir = 'persisted'): Map<string, string> {
  const store = new Map<string, string>();

  const frontendFile = join(dir, 'frontend.json');
  if (existsSync(frontendFile)) {
    const entries = JSON.parse(readFileSync(frontendFile, 'utf8')) as Record<string, string>;
    for (const [hash, document] of Object.entries(entries)) store.set(hash, document);
  }

  const operatorDir = join(dir, 'operator');
  if (existsSync(operatorDir)) {
    for (const file of readdirSync(operatorDir).filter((f) => f.endsWith('.graphql'))) {
      const document = readFileSync(join(operatorDir, file), 'utf8');
      const hash = createHash('sha256').update(document).digest('hex');
      store.set(hash, document);
      console.log(`trusted operator operation ${file}: ${hash}`);
    }
  }
  return store;
}
