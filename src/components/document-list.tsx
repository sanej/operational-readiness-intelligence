'use client';

import { FileText, CircleAlert, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DocumentSummary {
  id: string;
  fileName: string;
  title: string;
  documentType: string | null;
  revision: string | null;
  effectiveDate: string | null;
  docStatus: string | null;
  extractionMethod: string;
  pageCount: number | null;
  chunkCount: number;
  status: string;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    indexed: 'bg-[var(--color-supported-bg)] text-[var(--color-supported)]',
    processing: 'bg-[var(--color-partial-bg)] text-[var(--color-partial)]',
    pending: 'bg-muted text-muted-foreground',
    failed: 'bg-destructive/10 text-destructive',
  };

  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', map[status] ?? map.pending)}>
      {status === 'processing' && <Loader2 className="mr-1 inline h-2.5 w-2.5 animate-spin" />}
      {status}
    </span>
  );
}

export function DocumentList({
  documents,
  loading,
  error,
}: {
  documents: DocumentSummary[];
  loading: boolean;
  error?: string;
}) {
  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading documents">
        {[0, 1, 2].map((i) => (
          <div key={i} className="animate-ori-pulse rounded-md border border-border bg-muted/40 p-3">
            <div className="h-3 w-2/3 rounded bg-muted" />
            <div className="mt-2 h-2.5 w-1/3 rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center">
        <FileText className="mx-auto h-6 w-6 text-muted-foreground/50" />
        <p className="mt-2 text-xs font-medium">No documents in this corpus</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Upload documents above, or run{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
            npm run ingest -- ./sample-documents
          </code>
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {documents.map((doc) => {
        const meta = [
          doc.documentType?.replace(/_/g, ' '),
          doc.revision,
          doc.effectiveDate,
        ]
          .filter(Boolean)
          .join(' · ');

        return (
          <li key={doc.id} className="rounded-md border border-border bg-card p-2.5">
            <div className="flex items-start gap-2">
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium" title={doc.title}>
                  {doc.title}
                </p>
                {meta && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{meta}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <StatusPill status={doc.status} />
                  <span className="text-[10px] text-muted-foreground">
                    {doc.chunkCount} chunk{doc.chunkCount === 1 ? '' : 's'}
                  </span>
                  {doc.extractionMethod === 'ocr' && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      OCR
                    </span>
                  )}
                  {doc.docStatus && doc.docStatus !== 'active' && (
                    <span className="rounded bg-[var(--color-partial-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-partial)]">
                      {doc.docStatus}
                    </span>
                  )}
                </div>
                {doc.errorMessage && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-destructive">{doc.errorMessage}</p>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
