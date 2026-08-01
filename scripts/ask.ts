// CLI question answering.
//
//   npm run ask                                        # interactive, industrial
//   npm run ask -- --domain pharma                     # interactive, pharma
//   npm run ask -- "Is C-101 ready for maintenance?"   # one-shot
//   npm run ask -- --examples                          # list the pack's examples
//
// Uses the same AskPipeline as the web API, so a question asked here and the
// same question asked in the UI go through identical retrieval, generation,
// and citation validation.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { AskPipeline } from '../src/core/ask';
import type { GroundedAnswer } from '../src/core/types';
import { DOMAIN_PACKS, defaultCorpusId, getDomainPack } from '../src/domains';
import { c, getCliBindings, hr, statusColor } from './bindings';

interface Args {
  domain: string;
  corpus?: string;
  question?: string;
  topK?: number;
  examples: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let domain = 'industrial';
  let corpus: string | undefined;
  let topK: number | undefined;
  let examples = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--domain' || arg === '-d') domain = argv[++i];
    else if (arg === '--corpus' || arg === '-c') corpus = argv[++i];
    else if (arg === '--top-k' || arg === '-k') topK = Number.parseInt(argv[++i], 10);
    else if (arg === '--examples' || arg === '-e') examples = true;
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  if (!DOMAIN_PACKS[domain]) {
    console.error(
      `Unknown domain "${domain}". Available: ${Object.keys(DOMAIN_PACKS).join(', ')}.`
    );
    process.exit(1);
  }

  return {
    domain,
    corpus,
    question: positional.length > 0 ? positional.join(' ') : undefined,
    topK,
    examples,
  };
}

/** Indent wrapped prose so multi-line answers stay readable in a terminal. */
function wrapText(text: string, width = 74, indent = '  '): string {
  return text
    .split('\n')
    .flatMap((line) => {
      if (line.length <= width) return [indent + line];
      const words = line.split(' ');
      const out: string[] = [];
      let current = '';
      for (const word of words) {
        if (current && current.length + word.length + 1 > width) {
          out.push(indent + current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) out.push(indent + current);
      return out;
    })
    .join('\n');
}

function printAnswer(answer: GroundedAnswer): void {
  console.log();
  console.log(hr('═'));
  console.log(`  ${c.bold('EVIDENCE STATUS')}   ${statusColor(answer.evidenceStatus)}`);

  if (answer.claimedStatus && answer.claimedStatus !== answer.evidenceStatus) {
    console.log(
      `  ${c.dim('model proposed')}    ${c.dim(answer.claimedStatus)} ` +
        c.dim('→ adjusted by citation validation')
    );
  }

  const support = answer.evidenceSupport;
  console.log(
    `  ${c.dim('evidence support')}  ${support.label.toUpperCase()}` +
      c.dim(
        `   ${support.verified}/${support.claimed} citation(s) verified` +
        `   ${support.documents} source(s)` +
        `   ${answer.retrievedChunks.length} chunk(s) retrieved`
      )
  );
  console.log(hr('═'));
  console.log();
  console.log(wrapText(answer.answer));
  console.log();

  if (answer.conflicts.length > 0) {
    console.log(c.magenta(c.bold('  CONFLICTS')));
    for (const conflict of answer.conflicts) {
      console.log(wrapText(`• [${conflict.kind}] ${conflict.description}`, 72, '    '));
    }
    console.log();
  }

  if (answer.missingEvidence.length > 0) {
    console.log(c.yellow(c.bold('  MISSING EVIDENCE')));
    for (const item of answer.missingEvidence) {
      console.log(wrapText(`• ${item}`, 72, '    '));
    }
    console.log();
  }

  if (answer.verificationRequired.length > 0) {
    console.log(c.cyan(c.bold('  MUST BE VERIFIED BY A QUALIFIED PERSON')));
    for (const item of answer.verificationRequired) {
      console.log(wrapText(`• ${item}`, 72, '    '));
    }
    console.log();
  }

  if (answer.citations.length > 0) {
    console.log(c.bold('  CITATIONS'));
    answer.citations.forEach((citation, i) => {
      const where = [
        citation.documentTitle,
        citation.revision,
        citation.section,
        citation.pageNumber ? `p.${citation.pageNumber}` : null,
      ]
        .filter(Boolean)
        .join(' · ');

      console.log(`    ${c.bold(`[${i + 1}]`)} ${c.blue(where)}`);
      const quote = citation.citedContent.replace(/\s+/g, ' ').trim();
      console.log(
        wrapText(`"${quote.length > 260 ? `${quote.slice(0, 260)}…` : quote}"`, 68, '        ')
      );
    });
    console.log();
  }

  if (answer.warnings.length > 0) {
    console.log(c.yellow(c.bold('  VALIDATION WARNINGS')));
    for (const warning of answer.warnings) {
      console.log(wrapText(`• ${warning}`, 72, '    '));
    }
    console.log();
  }

  const usage = answer.usage;
  console.log(
    c.dim(
      `  ${answer.timings.totalMs} ms total ` +
        `(retrieval ${answer.timings.retrievalMs} ms, generation ${answer.timings.generationMs} ms)` +
        (usage?.promptTokens
          ? `  ·  ${usage.promptTokens} prompt + ${usage.completionTokens ?? 0} completion tokens`
          : '') +
        `  ·  ${answer.model}`
    )
  );
  console.log();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pack = getDomainPack(args.domain);
  const corpusId = args.corpus ?? defaultCorpusId(args.domain);

  if (args.examples) {
    console.log();
    console.log(c.bold(`${pack.displayName} — example questions`));
    console.log(hr());
    for (const example of pack.queryExamples) {
      console.log(`  ${c.dim(example.category.padEnd(18))} ${example.question}`);
    }
    console.log();
    return;
  }

  const { bindings, dispose } = await getCliBindings();

  try {
    const pipeline = new AskPipeline(bindings, pack);

    if (args.question) {
      console.log();
      console.log(`${c.bold('Q:')} ${args.question}   ${c.dim(`[${pack.displayName}]`)}`);
      const answer = await pipeline.ask({
        corpusId,
        question: args.question,
        topK: args.topK,
      });
      printAnswer(answer);
      return;
    }

    // Interactive mode.
    console.log();
    console.log(c.bold(`ORI — ${pack.displayName}`));
    console.log(hr());
    console.log(c.dim(`corpus: ${corpusId}`));
    console.log();
    console.log(c.dim('Example questions:'));
    pack.queryExamples.slice(0, 4).forEach((example, i) => {
      console.log(c.dim(`  ${i + 1}. ${example.question}`));
    });
    console.log();
    console.log(c.dim('Type a question, a number to use an example, or "exit".'));
    console.log();

    const rl = createInterface({ input: stdin, output: stdout });

    try {
      for (;;) {
        const input = (await rl.question(c.bold('Q: '))).trim();

        if (!input) continue;
        if (['exit', 'quit', 'q'].includes(input.toLowerCase())) break;

        const asNumber = Number.parseInt(input, 10);
        const question =
          Number.isFinite(asNumber) && pack.queryExamples[asNumber - 1]
            ? pack.queryExamples[asNumber - 1].question
            : input;

        if (question !== input) console.log(c.dim(`   → ${question}`));

        try {
          const answer = await pipeline.ask({ corpusId, question, topK: args.topK });
          printAnswer(answer);
        } catch (error) {
          console.error(c.red(`  ${error instanceof Error ? error.message : String(error)}`));
          console.log();
        }
      }
    } finally {
      rl.close();
    }
  } finally {
    await dispose();
  }
}

main().catch((error) => {
  console.error();
  console.error(c.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
