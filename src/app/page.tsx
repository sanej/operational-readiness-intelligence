'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, Loader2, Search, Upload } from 'lucide-react';
import { AnswerPanel } from '@/components/answer-panel';
import { DocumentList, type DocumentSummary } from '@/components/document-list';
import { cn } from '@/lib/utils';
import type { GroundedAnswer, QueryExample } from '@/core/types';

interface DomainInfo {
  id: string;
  displayName: string;
  description: string;
  corpusId: string;
  filterableFields: Array<{ field: string; label: string }>;
  queryExamples: QueryExample[];
}

interface UploadResult {
  fileName: string;
  success: boolean;
  duplicate: boolean;
  chunkCount: number;
  extractionMethod: string;
  errors: string[];
}

export default function Home() {
  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [domainId, setDomainId] = useState('industrial');

  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState<string>();

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<GroundedAnswer>();
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string>();

  const [uploading, setUploading] = useState(false);
  const [uploadResults, setUploadResults] = useState<UploadResult[]>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const domain = domains.find((d) => d.id === domainId);

  useEffect(() => {
    fetch('/api/domains')
      .then((r) => r.json())
      .then((data: { domains: DomainInfo[] }) => setDomains(data.domains))
      .catch(() => setDocumentsError('Could not load domain configuration.'));
  }, []);

  const loadDocuments = useCallback(async () => {
    setDocumentsLoading(true);
    setDocumentsError(undefined);
    try {
      const response = await fetch(`/api/documents?domain=${domainId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to load documents.');
      setDocuments(data.documents);
    } catch (error) {
      setDocumentsError(error instanceof Error ? error.message : 'Failed to load documents.');
      setDocuments([]);
    } finally {
      setDocumentsLoading(false);
    }
  }, [domainId]);

  useEffect(() => {
    // Fetch the corpus on mount and whenever the domain changes. The rule
    // cannot see that loadDocuments sets state only around an await, so it
    // treats this as a synchronous cascading render; it is the ordinary
    // fetch-on-mount pattern, and the loading state it sets is precisely what
    // the UI needs to show a skeleton.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDocuments();
  }, [loadDocuments]);

  /**
   * Switching domain switches corpus, so any answer on screen was produced
   * against a different document set. Clearing it in the change handler rather
   * than in an effect keeps the reset an explicit consequence of the user's
   * action instead of a cascading re-render.
   */
  function handleDomainChange(next: string) {
    setDomainId(next);
    setAnswer(undefined);
    setAskError(undefined);
    setUploadResults(undefined);
  }

  async function handleAsk(submitted?: string) {
    const text = (submitted ?? question).trim();
    if (!text || asking) return;

    setQuestion(text);
    setAsking(true);
    setAskError(undefined);
    setAnswer(undefined);

    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainId, question: text }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'The question could not be answered.');
      setAnswer(data.answer);
    } catch (error) {
      setAskError(error instanceof Error ? error.message : 'The question could not be answered.');
    } finally {
      setAsking(false);
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;

    setUploading(true);
    setUploadResults(undefined);

    try {
      const formData = new FormData();
      formData.append('domain', domainId);
      for (const file of Array.from(files)) formData.append('files', file);

      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Upload failed.');

      setUploadResults(data.results);
      await loadDocuments();
    } catch (error) {
      setUploadResults([
        {
          fileName: 'Upload',
          success: false,
          duplicate: false,
          chunkCount: 0,
          extractionMethod: '',
          errors: [error instanceof Error ? error.message : 'Upload failed.'],
        },
      ]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-5 py-6">
      <header className="mb-6 border-b border-border pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              ORI <span className="font-normal text-muted-foreground">· Operational Readiness Intelligence</span>
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Grounded, cited answers from operational, quality, safety, and compliance documents.
              ORI supports human review — it does not approve equipment, work, or release.
            </p>
          </div>

          <div>
            <label htmlFor="domain" className="mb-1 block text-[11px] font-medium text-muted-foreground">
              Domain
            </label>
            <select
              id="domain"
              value={domainId}
              onChange={(e) => handleDomainChange(e.target.value)}
              className="rounded-md border border-input bg-card px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {domains.length === 0 && <option value="industrial">Loading…</option>}
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.displayName}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* ---------------------------------------------------------------- */}
        <aside className="space-y-5">
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Upload documents
            </h2>

            <label
              className={cn(
                'flex cursor-pointer flex-col items-center rounded-md border border-dashed border-border bg-card px-4 py-5 text-center transition-colors hover:border-primary/50 hover:bg-accent',
                uploading && 'pointer-events-none opacity-60'
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                accept=".pdf,.png,.jpg,.jpeg,.docx,.pptx,.md,.txt,.csv,.json"
                onChange={(e) => void handleUpload(e.target.files)}
                disabled={uploading}
              />
              {uploading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="mt-2 text-xs font-medium">Extracting and indexing…</span>
                  <span className="mt-0.5 text-[11px] text-muted-foreground">
                    PDFs go through Mistral OCR — this can take a minute.
                  </span>
                </>
              ) : (
                <>
                  <Upload className="h-5 w-5 text-muted-foreground" />
                  <span className="mt-2 text-xs font-medium">Choose files</span>
                  <span className="mt-0.5 text-[11px] text-muted-foreground">
                    PDF, images, Office, Markdown, CSV, JSON
                  </span>
                </>
              )}
            </label>

            {uploadResults && (
              <ul className="mt-2 space-y-1">
                {uploadResults.map((result, i) => (
                  <li
                    key={i}
                    className={cn(
                      'rounded border px-2 py-1.5 text-[11px]',
                      result.success
                        ? 'border-[var(--color-supported)]/25 bg-[var(--color-supported-bg)] text-[var(--color-supported)]'
                        : 'border-destructive/25 bg-destructive/5 text-destructive'
                    )}
                  >
                    <span className="font-medium">{result.fileName}</span>{' '}
                    {result.success
                      ? result.duplicate
                        ? '— already indexed'
                        : `— ${result.chunkCount} chunks${result.extractionMethod === 'ocr' ? ' via OCR' : ''}`
                      : `— ${result.errors[0] ?? 'failed'}`}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Corpus
              </h2>
              {domain && <span className="text-[11px] text-muted-foreground">{domain.corpusId}</span>}
            </div>
            <DocumentList documents={documents} loading={documentsLoading} error={documentsError} />
          </section>
        </aside>

        {/* ---------------------------------------------------------------- */}
        <section className="min-w-0 space-y-5">
          <div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleAsk();
              }}
              className="flex gap-2"
            >
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={
                    domain
                      ? `Ask about ${domain.displayName.toLowerCase()}…`
                      : 'Ask an operational-readiness question…'
                  }
                  className="w-full rounded-md border border-input bg-card py-2.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  disabled={asking}
                />
              </div>
              <button
                type="submit"
                disabled={asking || !question.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {asking && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {asking ? 'Analysing' : 'Ask'}
              </button>
            </form>

            {domain && domain.queryExamples.length > 0 && !answer && !asking && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {domain.queryExamples.map((example) => (
                  <button
                    key={example.id}
                    type="button"
                    onClick={() => void handleAsk(example.question)}
                    className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
                  >
                    {example.question}
                  </button>
                ))}
              </div>
            )}
          </div>

          {asking && (
            <div className="space-y-3" aria-busy="true">
              <div className="animate-ori-pulse rounded-lg border border-border bg-muted/40 p-4">
                <div className="h-4 w-40 rounded bg-muted" />
              </div>
              <div className="animate-ori-pulse rounded-lg border border-border bg-muted/40 p-5">
                <div className="h-3 w-full rounded bg-muted" />
                <div className="mt-2.5 h-3 w-11/12 rounded bg-muted" />
                <div className="mt-2.5 h-3 w-4/5 rounded bg-muted" />
                <div className="mt-2.5 h-3 w-2/3 rounded bg-muted" />
              </div>
              <p className="text-xs text-muted-foreground">
                Retrieving evidence, generating a grounded answer, and validating every citation
                against the retrieved chunks.
              </p>
            </div>
          )}

          {askError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <p className="flex items-start gap-2 text-sm text-destructive">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{askError}</span>
              </p>
            </div>
          )}

          {answer && !asking && <AnswerPanel answer={answer} />}

          {!answer && !asking && !askError && (
            <div className="rounded-lg border border-dashed border-border p-10 text-center">
              <Search className="mx-auto h-7 w-7 text-muted-foreground/40" />
              <p className="mt-3 text-sm font-medium">Ask an operational-readiness question</p>
              <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground">
                Every answer returns an evidence status, citations checked against the retrieved
                source text, the evidence that was retrieved but not cited, and what a qualified
                person must still verify.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
