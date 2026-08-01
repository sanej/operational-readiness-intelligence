// Stable identifiers and content hashing.
//
// Uses WebCrypto rather than node:crypto so exactly one implementation serves
// both the Worker runtime and the Node CLI. Proofcase used node:crypto here,
// which forces the ingestion path to diverge between web and CLI; ORI's CLI
// and Worker run the same code.
//
// Every id is a pure function of its inputs, which is what makes re-ingestion
// idempotent: the same file in the same corpus produces the same document id,
// the same chunk ids, and the same vector ids, so a re-run upserts in place
// instead of duplicating the corpus.

const encoder = new TextEncoder();

async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === 'string'
      ? encoder.encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);

  // BufferSource wants a plain ArrayBuffer; slice detaches from any SAB.
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);

  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 of raw file bytes — the basis of duplicate detection. */
export async function contentHash(
  content: ArrayBuffer | Uint8Array | string
): Promise<string> {
  return sha256Hex(content);
}

/** Same content in the same corpus is the same document. */
export async function documentId(corpusId: string, hash: string): Promise<string> {
  return `doc_${(await sha256Hex(`${corpusId}:${hash}`)).slice(0, 16)}`;
}

/** Stable across re-ingestion so chunk rows and vectors upsert in place. */
export async function chunkId(docId: string, index: number): Promise<string> {
  return `chk_${(await sha256Hex(`${docId}:${index}`)).slice(0, 16)}`;
}

export async function vectorId(cId: string): Promise<string> {
  return `vec_${(await sha256Hex(cId)).slice(0, 16)}`;
}

/** R2 layout: corpus / document / filename, mirroring the D1 hierarchy. */
export function r2Key(corpusId: string, docId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `corpora/${corpusId}/documents/${docId}/${safe}`;
}

/** Where the normalized extraction is stored, alongside the original. */
export function parsedR2Key(corpusId: string, docId: string): string {
  return `corpora/${corpusId}/documents/${docId}/parsed.json`;
}

/** Non-deterministic id for rows that are genuinely new each time. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
