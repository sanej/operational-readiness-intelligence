// Document removal.
//
// A corpus that can only be added to is not a credible system of record for
// anything: superseded documents, mis-tagged uploads, and test files all need
// a way out. Removal spans three stores, so the ordering matters.
//
// Vectors are deleted FIRST, while D1 still holds the vector ids that identify
// them. Vectorize has no list API and no delete-by-namespace, so those ids
// exist in exactly one place — `chunks.vector_id`. Dropping the D1 rows first
// would strand the vectors permanently, and a stranded vector still answers
// queries: retrieval would surface a chunk whose text no longer exists,
// producing a citation that cannot be verified.

import type { OriBindings } from '../config';
import { Storage } from '../storage';

export interface DeleteResult {
  success: boolean;
  documentId: string;
  fileName?: string;
  chunksDeleted: number;
  vectorsDeleted: number;
  warnings: string[];
  error?: string;
}

export class DocumentRemovalService {
  private readonly storage: Storage;

  constructor(bindings: OriBindings) {
    this.storage = new Storage(bindings);
  }

  async remove(documentId: string, corpusId?: string): Promise<DeleteResult> {
    const warnings: string[] = [];

    const document = await this.storage.d1.getDocument(documentId);

    if (!document) {
      return {
        success: false,
        documentId,
        chunksDeleted: 0,
        vectorsDeleted: 0,
        warnings,
        error: 'Document not found.',
      };
    }

    // Scope check: a delete issued for one corpus must not remove a document
    // belonging to another.
    if (corpusId && document.corpus_id !== corpusId) {
      return {
        success: false,
        documentId,
        fileName: document.original_file_name,
        chunksDeleted: 0,
        vectorsDeleted: 0,
        warnings,
        error: `Document belongs to corpus "${document.corpus_id}", not "${corpusId}".`,
      };
    }

    try {
      // 1. Vectors first — their ids live only in the D1 rows we are about to
      //    drop, so this is the last moment they can be found.
      const vectorIds = await this.storage.d1.listVectorIdsByDocument(documentId);

      if (vectorIds.length > 0) {
        try {
          await this.storage.vectors.deleteByIds(vectorIds);
        } catch (error) {
          // Stop rather than proceed: deleting the D1 rows now would strand
          // these vectors, and a stranded vector still answers queries.
          const message = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            documentId,
            fileName: document.original_file_name,
            chunksDeleted: 0,
            vectorsDeleted: 0,
            warnings,
            error:
              `Could not remove ${vectorIds.length} vector(s) from Vectorize: ${message}. ` +
              `Nothing was deleted — retrying is safe.`,
          };
        }
      }

      // 2. R2 objects. Best effort: an orphaned R2 object is inert storage, so
      //    it must not block the removal of live index entries.
      for (const key of [document.r2_key, document.parsed_r2_key]) {
        if (!key) continue;
        try {
          await this.storage.r2.delete(key);
        } catch {
          warnings.push(`Could not remove the R2 object "${key}". It is orphaned but harmless.`);
        }
      }

      // 3. D1 last. `chunks` and `citations` cascade from `documents`.
      const chunkCount = document.chunk_count;
      await this.storage.d1.deleteDocument(documentId);

      return {
        success: true,
        documentId,
        fileName: document.original_file_name,
        chunksDeleted: chunkCount,
        vectorsDeleted: vectorIds.length,
        warnings,
      };
    } catch (error) {
      return {
        success: false,
        documentId,
        fileName: document.original_file_name,
        chunksDeleted: 0,
        vectorsDeleted: 0,
        warnings,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
