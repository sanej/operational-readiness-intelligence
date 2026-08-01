// Evaluation runner.
//
//   npm run eval                      # both domains
//   npm run eval -- --domain pharma   # one domain
//
// Results are printed and also written to D1 (evaluation_runs /
// evaluation_records) so runs can be compared over time.

import { AskPipeline } from '../src/core/ask';
import { runSuite, type CaseResult, type EvalSuite, type SuiteResult } from '../src/core/evaluation/harness';
import { Storage } from '../src/core/storage';
import { DOMAIN_PACKS, defaultCorpusId, getDomainPack } from '../src/domains';
import industrialEvals from '../src/domains/industrial/evals.json';
import pharmaEvals from '../src/domains/pharma/evals.json';
import { c, getCliBindings, hr } from './bindings';

const SUITES: Record<string, EvalSuite> = {
  industrial: industrialEvals as EvalSuite,
  pharma: pharmaEvals as EvalSuite,
};

function parseArgs(argv: string[]): { domains: string[]; corpus?: string } {
  let domain: string | undefined;
  let corpus: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--domain' || argv[i] === '-d') domain = argv[++i];
    else if (argv[i] === '--corpus' || argv[i] === '-c') corpus = argv[++i];
  }

  if (domain && !DOMAIN_PACKS[domain]) {
    console.error(`Unknown domain "${domain}". Available: ${Object.keys(DOMAIN_PACKS).join(', ')}.`);
    process.exit(1);
  }

  return { domains: domain ? [domain] : Object.keys(SUITES), corpus };
}

function printCase(result: CaseResult): void {
  const mark = result.passed ? c.green('PASS') : c.red('FAIL');
  const status = result.actualStatus ?? '—';

  console.log(
    `  ${mark}  ${result.caseId.padEnd(32)} ${c.dim(status.padEnd(22))}` +
      c.dim(`${(result.latencyMs / 1000).toFixed(1)}s`)
  );

  if (!result.passed) {
    for (const failure of result.failures) {
      console.log(`        ${c.red('·')} ${failure}`);
    }
  }
}

function printSuite(suite: SuiteResult): void {
  const pack = getDomainPack(suite.domain);
  const allPassed = suite.passed === suite.total;

  console.log();
  console.log(hr());
  console.log(
    `  ${c.bold(pack.displayName)}  ` +
      (allPassed
        ? c.green(`${suite.passed}/${suite.total} passed`)
        : c.yellow(`${suite.passed}/${suite.total} passed`))
  );
  console.log(
    c.dim(
      `  latency  p50 ${suite.latency.p50} ms · p95 ${suite.latency.p95} ms · ` +
        `mean ${suite.latency.mean} ms · max ${suite.latency.max} ms`
    )
  );
  console.log(
    c.dim(
      `  tokens   ${suite.tokens.prompt} prompt · ${suite.tokens.completion} completion · ` +
        `${suite.tokens.prompt + suite.tokens.completion} total`
    )
  );

  // Per-dimension roll-up: which capability is failing, not just which case.
  const byDimension = new Map<string, { passed: number; total: number }>();
  for (const result of suite.results) {
    for (const dimension of result.dimensions) {
      const entry = byDimension.get(dimension) ?? { passed: 0, total: 0 };
      entry.total++;
      if (result.passed) entry.passed++;
      byDimension.set(dimension, entry);
    }
  }

  console.log();
  console.log(c.dim('  by dimension'));
  for (const [dimension, { passed, total }] of [...byDimension].sort()) {
    const label = passed === total ? c.green(`${passed}/${total}`) : c.yellow(`${passed}/${total}`);
    console.log(`    ${dimension.padEnd(34)} ${label}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { bindings, dispose } = await getCliBindings();

  try {
    const storage = new Storage(bindings);
    const suites: SuiteResult[] = [];

    for (const domain of args.domains) {
      const pack = getDomainPack(domain);
      const suite = SUITES[domain];
      const corpusId = args.corpus ?? defaultCorpusId(domain);

      console.log();
      console.log(c.bold(`Evaluating ${pack.displayName}`));
      console.log(c.dim(`corpus: ${corpusId} · ${suite.cases.length} cases`));
      console.log();

      const pipeline = new AskPipeline(bindings, pack);
      const runId = await storage.d1.createEvalRun(domain, corpusId, suite.cases.length);

      const result = await runSuite(pipeline, suite, corpusId, (caseResult) => {
        printCase(caseResult);
      });

      for (const caseResult of result.results) {
        await storage.d1.saveEvalRecord({
          runId,
          caseId: caseResult.caseId,
          domain,
          question: caseResult.question,
          expectedStatus: caseResult.expectedStatus?.join('|'),
          actualStatus: caseResult.actualStatus,
          checks: Object.fromEntries(caseResult.checks.map((check) => [check.name, check.passed])),
          passed: caseResult.passed,
          failureReasons: caseResult.failures,
          latencyMs: caseResult.latencyMs,
          promptTokens: caseResult.promptTokens,
          completionTokens: caseResult.completionTokens,
        });
      }

      await storage.d1.finalizeEvalRun(
        runId,
        result.passed,
        `p50 ${result.latency.p50}ms, ${result.tokens.prompt + result.tokens.completion} tokens`
      );

      printSuite(result);
      suites.push(result);
    }

    const passed = suites.reduce((sum, s) => sum + s.passed, 0);
    const total = suites.reduce((sum, s) => sum + s.total, 0);

    console.log();
    console.log(hr('═'));
    console.log(
      `  ${c.bold('TOTAL')}  ` +
        (passed === total
          ? c.green(`${passed}/${total} passed`)
          : c.yellow(`${passed}/${total} passed`))
    );
    console.log();

    if (passed < total) process.exitCode = 1;
  } finally {
    await dispose();
  }
}

main().catch((error) => {
  console.error();
  console.error(c.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
