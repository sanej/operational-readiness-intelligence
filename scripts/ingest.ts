// CLI ingestion.
//
//   npm run ingest -- ./sample-documents/industrial
//   npm run ingest -- ./sample-documents/pharma
//   npm run ingest -- ./docs --domain pharma --corpus my-corpus
//
// The domain is inferred from the directory name when it matches a known pack,
// so the two commands above need no flags. Uses the same IngestionPipeline as
// the web upload route.

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import { IngestionPipeline } from '../src/core/ingestion/pipeline';
import { detectFileType, isSupportedFileType, mimeTypeFor } from '../src/core/ingestion/normalize';
import { Storage } from '../src/core/storage';
import { DOMAIN_PACKS, defaultCorpusId, getDomainPack } from '../src/domains';
import { c, getCliBindings, hr } from './bindings';

interface Args {
  path: string;
  domain?: string;
  corpus?: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let domain: string | undefined;
  let corpus: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--domain' || arg === '-d') domain = argv[++i];
    else if (arg === '--corpus' || arg === '-c') corpus = argv[++i];
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  if (positional.length === 0) {
    console.error(
      `Usage: npm run ingest -- <directory-or-file> [--domain <${Object.keys(DOMAIN_PACKS).join('|')}>] [--corpus <id>]\n\n` +
        `Examples:\n` +
        `  npm run ingest -- ./sample-documents/industrial\n` +
        `  npm run ingest -- ./sample-documents/pharma`
    );
    process.exit(1);
  }

  return { path: positional[0], domain, corpus };
}

/** Infer the domain from the directory name when it names a known pack. */
function inferDomain(path: string, explicit?: string): string {
  if (explicit) return explicit;

  const name = basename(resolve(path)).toLowerCase();
  if (DOMAIN_PACKS[name]) return name;

  throw new Error(
    `Could not infer the domain from "${path}". ` +
      `Pass --domain <${Object.keys(DOMAIN_PACKS).join('|')}>.`
  );
}

/** Sidecar metadata: `report.pdf` may be accompanied by `report.meta.json`. */
const META_SUFFIX = '.meta.json';

async function collectFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];

  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(join(path, entry.name))));
      continue;
    }
    if (entry.name.startsWith('.')) continue;
    // Sidecars are metadata for another file, not documents in their own right.
    if (entry.name.endsWith(META_SUFFIX)) continue;

    const fileType = detectFileType(entry.name);
    if (isSupportedFileType(fileType)) files.push(join(path, entry.name));
  }

  return files.sort();
}

/**
 * Read a sidecar metadata file, if present.
 *
 * Markdown carries its metadata as YAML front matter, but a PDF or image
 * cannot. A `<name>.meta.json` sidecar supplies the same fields for those
 * formats, and is validated by the domain pack exactly like front matter.
 */
async function readSidecarMetadata(file: string): Promise<Record<string, unknown> | undefined> {
  const sidecar = file.replace(new RegExp(`${extname(file)}$`), '') + META_SUFFIX;

  try {
    return JSON.parse(await readFile(sidecar, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    // Absent is the normal case; malformed is a mistake worth surfacing.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not read ${sidecar}: ${(error as Error).message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const domain = inferDomain(args.path, args.domain);
  const pack = getDomainPack(domain);
  const corpusId = args.corpus ?? defaultCorpusId(domain);

  const files = await collectFiles(args.path);
  if (files.length === 0) {
    console.error(c.red(`No supported files found in ${args.path}`));
    process.exit(1);
  }

  console.log();
  console.log(c.bold(`ORI ingestion — ${pack.displayName}`));
  console.log(hr());
  console.log(`${c.dim('corpus:')} ${corpusId}`);
  console.log(`${c.dim('files: ')} ${files.length}`);
  console.log();

  const { bindings, dispose } = await getCliBindings();

  try {
    const storage = new Storage(bindings);
    await storage.d1.upsertCorpus(
      corpusId,
      domain,
      `${pack.displayName} demo corpus`,
      pack.description
    );

    const pipeline = new IngestionPipeline(bindings, pack);

    let indexed = 0;
    let duplicates = 0;
    let failed = 0;
    let totalChunks = 0;
    const startedAt = Date.now();

    for (const file of files) {
      const fileName = basename(file);
      const content = await readFile(file);
      const fileType = detectFileType(fileName);

      process.stdout.write(`  ${fileName.padEnd(52).slice(0, 52)} `);

      const result = await pipeline.ingest({
        corpusId,
        fileName,
        content: new Uint8Array(content),
        mimeType: mimeTypeFor(fileType),
        metadata: await readSidecarMetadata(file),
      });

      if (!result.success) {
        failed++;
        console.log(c.red('FAILED'));
        for (const error of result.errors) console.log(`      ${c.red(error)}`);
        continue;
      }

      if (result.duplicate) {
        duplicates++;
        console.log(c.dim(`skipped (already indexed, ${result.chunkCount} chunks)`));
        continue;
      }

      indexed++;
      totalChunks += result.chunkCount;
      const via = result.extractionMethod === 'ocr' ? ' via OCR' : '';
      console.log(
        c.green(`${String(result.chunkCount).padStart(3)} chunks`) +
          c.dim(` ${(result.timings.totalMs / 1000).toFixed(1)}s${via}`)
      );
    }

    console.log();
    console.log(hr());
    console.log(
      `${c.green(`${indexed} indexed`)}` +
        (duplicates ? c.dim(`  ${duplicates} already present`) : '') +
        (failed ? `  ${c.red(`${failed} failed`)}` : '') +
        c.dim(`  ${totalChunks} chunks  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    );
    console.log();
    console.log(c.dim(`Ask a question:  npm run ask -- --domain ${domain}`));
    console.log();

    if (failed > 0) process.exitCode = 1;
  } finally {
    await dispose();
  }
}

main().catch((error) => {
  console.error();
  console.error(c.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
