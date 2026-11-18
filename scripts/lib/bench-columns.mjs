// The columns of docs/benchmarks/e2e.csv and e2e-questions.csv, and the CSV writer, shared by scripts/bench-e2e.mjs and the tests.
//
// e2e-questions.csv carries two page columns (TD-59): correct_source_page (a cited source names the page) and top_retrieved_page_ok (retrieval).
//
// Every row of both files ends with laptop_8gb = 'not measured on 8 GB' (BUG-T1-S5-07): every figure comes from the machine named in
// the row's own `machine` column, and nothing has been measured on an 8 GB Windows laptop. The writer refuses a row without the phrase,
// so a CSV that leaves this script can never be read as an 8 GB result.

export const LAPTOP_8GB = 'not measured on 8 GB';

export const E2E_COLUMNS = [
  'date',
  'machine',
  'chrome',
  'commit',
  'run',
  'restart',
  'pdf',
  'pages',
  'chunks',
  'held',
  'triage_ms',
  'extract_ms',
  'gate_ms',
  'embed_ms',
  'index_ms',
  'retrieve_ms',
  'first_token_ms',
  'total_ms',
  'out_tokens',
  'tokens_per_s',
  'js_heap_peak_bytes',
  'wasm_memory_peak_bytes',
  'process_rss_peak_bytes',
  'storage_usage_bytes',
  'requests_after_offline',
  'model',
  'backend',
  'answer_ok',
  'laptop_8gb',
];

export const Q_COLUMNS = [
  'date',
  'machine',
  'commit',
  'run',
  'restart',
  'qid',
  'answer_ok',
  'correct_source_page',
  'top_retrieved_page_ok',
  'first_token_ms',
  'total_ms',
  'laptop_8gb',
];

const holds = (pages, expectPage) => {
  const [from, to] = String(pages).includes(' to ')
    ? String(pages).split(' to ').map(Number)
    : [Number(pages), Number(pages)];
  return from <= expectPage && expectPage <= to;
};

/**
 * The two page columns of one answer (TD-59, BUG-T1-S5-R2-05).
 *   correct_source_page    true only when a CITED source shown to the user names the expected page. False when the model refused or cited
 *                          nothing, so a refusal can never read as 'source page correct'.
 *   top_retrieved_page_ok  whether the top-ranked retrieved passage (S1) is on the expected page: retrieval quality, reported on its own.
 * The question with no answer in the document has no page: both are ''. `a.sources` is what the answer card showed: { id, pages, cited }.
 */
export function pageChecks(q, a) {
  if (q.expectPage === null || q.expectPage === undefined)
    return { correct_source_page: '', top_retrieved_page_ok: '' };
  const sources = a.ok ? a.sources : [];
  return {
    correct_source_page: sources.some((s) => s.cited && holds(s.pages, q.expectPage)),
    top_retrieved_page_ok: sources.length > 0 && holds(sources[0].pages, q.expectPage),
  };
}

export const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** CSV text for the rows, in the order of `cols`. Throws when a laptop_8gb column is present and any row does not carry the phrase. */
export const csv = (cols, rows) => {
  if (cols.includes('laptop_8gb')) {
    rows.forEach((r, i) => {
      if (r.laptop_8gb !== LAPTOP_8GB)
        throw new Error(
          `row ${i + 1}: laptop_8gb must read '${LAPTOP_8GB}', not '${r.laptop_8gb ?? ''}'`,
        );
    });
  }
  return `${cols.join(',')}\n${rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\n')}\n`;
};
