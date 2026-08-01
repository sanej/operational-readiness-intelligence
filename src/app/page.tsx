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

/**
 * Turn a bindings failure into something actionable.
 *
 * The raw error names an internal OpenNext function, which tells a user
 * nothing. The actual cause is almost always that the app is running without
 * Cloudflare bindings attached, and the fix is a specific command.
 */
function friendlyError(message: string): { title: string; detail: string; hint?: string } {
  if (/getCloudflareContext|initOpenNextCloudflareForDev|bindings unavailable/i.test(message)) {
    return {
      title: 'Cloudflare bindings are not attached',
      detail:
        'D1, R2, and Vectorize are unavailable, so the corpus cannot be read. This happens when the app runs without the Cloudflare dev bindings.',
      hint: 'npm run dev  —  or  npm run preview  for the full Workers runtime',
    };
  }

  if (/MISTRAL_API_KEY/i.test(message)) {
    return {
      title: 'Mistral API key is not set',
      detail: 'Add MISTRAL_API_KEY to .dev.vars in the project root, then restart the server.',
      hint: 'echo \'MISTRAL_API_KEY="your-key"\' > .dev.vars',
    };
  }

  if (/rate limit/i.test(message)) {
    return {
      title: 'Mistral rate limit reached',
      detail: 'The API is throttling requests. Wait a moment and ask again.',
    };
  }

  return { title: 'Something went wrong', detail: message };
}

function ErrorCard({ message }: { message: string }) {
  const { title, detail, hint } = friendlyError(message);
  return (
    <div className="rounded-xl border border-destructive/25 bg-destructive-subtle p-5">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 h-4.5 w-4.5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-destructive">{title}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/80">{detail}</p>
          {hint && (
            <code className="mt-3 inline-block rounded bg-surface px-2.5 py-1.5 text-[11.5px]">
              {hint}
            </code>
          )}
        </div>
      </div>
    </div>
  );
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
  const indexedCount = documents.filter((d) => d.status === 'indexed').length;
  const chunkTotal = documents.reduce((sum, d) => sum + d.chunkCount, 0);

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
    <div className="min-h-screen">
      {/* ---------------------------------------------------------------- */}
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-[11px] font-bold text-primary-foreground">
              ORI
            </span>
            <div>
              <h1 className="text-[15px] font-semibold leading-tight">
                Operational Readiness Intelligence
              </h1>
              <p className="mt-0.5 text-[12px] leading-tight text-muted-foreground">
                Grounded, cited answers — supports human review, does not approve work
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <label
              htmlFor="domain"
              className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              Domain
            </label>
            <select
              id="domain"
              value={domainId}
              onChange={(e) => handleDomainChange(e.target.value)}
              className="rounded-lg border border-input bg-surface px-3 py-2 text-[13px] font-medium transition-colors hover:border-border-strong focus:outline-none focus:ring-2 focus:ring-ring/40"
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

      {/* ---------------------------------------------------------------- */}
      <main className="mx-auto max-w-[1400px] px-6 py-6">
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          {/* ------------------------------------------------------------ */}
          <aside className="space-y-5">
            <section>
              <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Add documents
              </h2>

              <label
                className={cn(
                  'flex cursor-pointer flex-col items-center rounded-xl border border-dashed border-border-strong bg-surface px-4 py-6 text-center transition-colors hover:border-primary/50 hover:bg-primary-subtle',
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
                    <span className="mt-2.5 text-[13px] font-medium">Extracting and indexing…</span>
                    <span className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                      PDFs go through Mistral OCR
                    </span>
                  </>
                ) : (
                  <>
                    <Upload className="h-5 w-5 text-muted-foreground" />
                    <span className="mt-2.5 text-[13px] font-medium">Choose files</span>
                    <span className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                      PDF · images · Office · Markdown · CSV · JSON
                    </span>
                  </>
                )}
              </label>

              {uploadResults && (
                <ul className="mt-2 space-y-1.5">
                  {uploadResults.map((result, i) => (
                    <li
                      key={i}
                      className={cn(
                        'rounded-lg border px-2.5 py-2 text-[11.5px] leading-relaxed',
                        result.success
                          ? 'border-[var(--color-supported-border)] bg-[var(--color-supported-bg)] text-[var(--color-supported)]'
                          : 'border-destructive/25 bg-destructive-subtle text-destructive'
                      )}
                    >
                      <span className="font-semibold">{result.fileName}</span>{' '}
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
              <div className="mb-2.5 flex items-baseline justify-between gap-2">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Corpus
                </h2>
                {!documentsLoading && !documentsError && documents.length > 0 && (
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {indexedCount} docs · {chunkTotal} chunks
                  </span>
                )}
              </div>
              <DocumentList
                documents={documents}
                loading={documentsLoading}
                error={documentsError}
              />
            </section>
          </aside>

          {/* ------------------------------------------------------------ */}
          <section className="min-w-0 space-y-5">
            <div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleAsk();
                }}
                className="flex gap-2.5"
              >
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder={
                      domain
                        ? `Ask about ${domain.displayName.toLowerCase()}…`
                        : 'Ask an operational-readiness question…'
                    }
                    className="w-full rounded-xl border border-input bg-surface py-3 pl-10 pr-4 text-[14px] transition-colors placeholder:text-muted-foreground hover:border-border-strong focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring/25"
                    disabled={asking}
                  />
                </div>
                <button
                  type="submit"
                  disabled={asking || !question.trim()}
                  className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-[14px] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-45"
                >
                  {asking && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {asking ? 'Analysing' : 'Ask'}
                </button>
              </form>

              {domain && domain.queryExamples.length > 0 && !answer && !asking && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {domain.queryExamples.map((example) => (
                    <button
                      key={example.id}
                      type="button"
                      onClick={() => void handleAsk(example.question)}
                      className="rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-primary/45 hover:bg-primary-subtle hover:text-foreground"
                    >
                      {example.question}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {asking && (
              <div className="space-y-4" aria-busy="true">
                <div className="animate-ori-pulse rounded-xl border border-border bg-surface p-5">
                  <div className="h-6 w-40 rounded-full bg-muted" />
                  <div className="mt-3 h-3 w-72 rounded bg-muted" />
                </div>
                <div className="animate-ori-pulse rounded-xl border border-border bg-surface p-6">
                  <div className="h-3 w-24 rounded bg-muted" />
                  <div className="mt-4 h-3 w-full rounded bg-muted" />
                  <div className="mt-2.5 h-3 w-11/12 rounded bg-muted" />
                  <div className="mt-2.5 h-3 w-4/5 rounded bg-muted" />
                  <div className="mt-2.5 h-3 w-2/3 rounded bg-muted" />
                </div>
                <p className="px-1 text-[12px] leading-relaxed text-muted-foreground">
                  Retrieving evidence, generating a grounded answer, and validating every citation
                  against the retrieved chunks. This usually takes 20–60 seconds.
                </p>
              </div>
            )}

            {askError && <ErrorCard message={askError} />}

            {answer && !asking && <AnswerPanel answer={answer} />}

            {!answer && !asking && !askError && (
              <div className="rounded-xl border border-dashed border-border-strong px-8 py-14 text-center">
                <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary-subtle">
                  <Search className="h-5 w-5 text-primary" />
                </span>
                <p className="mt-4 text-[15px] font-semibold">
                  Ask an operational-readiness question
                </p>
                <p className="mx-auto mt-2 max-w-lg text-[13px] leading-relaxed text-muted-foreground">
                  Every answer returns an evidence status, citations checked against the retrieved
                  source text, the evidence that was retrieved but not cited, and what a qualified
                  person must still verify.
                </p>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
