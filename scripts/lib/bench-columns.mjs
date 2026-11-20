// The columns of docs/benchmarks/e2e.csv and e2e-questions.csv, and the CSV writer, shared by scripts/bench-e2e.mjs and the tests.
//
// e2e-questions.csv carries two page columns (TD-59): correct_source_page (a cited source names the page) and top_retrieved_page_ok (retrieval).
//
// Every row of both files ends with laptop_8gb = 'not measured on 8 GB' (BUG-T1-S5-07): every figure comes from the machine named in
// the row's own `machine` column, and nothing has been measured on an 8 GB Windows laptop. The writer refuses a row without the phrase,
// so a CSV that leaves this script can never be read as an 8 GB result.

export const LAPTOP_8GB = 'not measured on 8 GB';

/** The columns of every e2e.csv written before BUG-T1-S6-05 (the committed baseline has exactly these). */
export const E2E_COLUMNS_BASE = [
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

/**
 * BUG-T1-S6-05: two trailing columns say how busy the host was (os.loadavg() 1-minute, two decimals) at the start and end of the run, so a peak taken under
 * load can be told from a quiet one. A CSV without them is still valid input to every reader.
 */
export const E2E_COLUMNS = [...E2E_COLUMNS_BASE, 'host_load_1m_start', 'host_load_1m_end'];

/** One load-average figure as written to the CSV. */
export const hostLoad = (v) => Number(v).toFixed(2);

/** The load-average cell: empty on win32, where os.loadavg() is always [0, 0, 0] and a figure would read as an idle machine. */
export const hostLoadCell = (v, platform = process.platform) =>
  platform === 'win32' ? '' : hostLoad(v);

// ---- emulated runs (B6, TD-113) ----
//
// An emulated run (a GitHub-hosted Windows VM, with or without a job commit limit on the pwsh, node and Chrome process tree) is NOT a laptop figure. Its rows
// go in files of their own, with the columns below, and carry an `environment` label that says what was run. The writer refuses a row whose label is missing or
// reads as a laptop or an 8 GB machine, exactly as it refuses a row without the laptop_8gb phrase. laptop_8gb stays 'not measured on 8 GB' on every row.

/** docs/benchmarks/ file names of the emulated results: never e2e.csv and never e2e-questions.csv. */
export const EMULATED_E2E_FILE = 'e2e-emulated-win-vm.csv';
export const EMULATED_Q_FILE = 'e2e-emulated-win-vm-questions.csv';

/** The reasons a run may be recorded as failed (scripts/lib/fail-fast.mjs). */
export const FAILURE_REASONS = Object.freeze([
  'renderer_crash',
  'browser_disconnected',
  'worker_crash',
  'out_of_memory',
]);

/** 'emulated: <what was run>; not a laptop', at most 300 characters between the prefix and the suffix, from a small safe alphabet (no markup, quote or '='). */
export const ENVIRONMENT_LABEL_RE = /^emulated: [A-Za-z0-9 ,.;:()/+-]{1,300}; not a laptop$/;
const LABEL_SUFFIX = '; not a laptop';

/**
 * BUG-T1-S7-05: one pattern for 'reads as an 8 GB machine or a laptop', copied byte for byte into site/scripts/import-dockit-emulated.mjs (a test in each repo pins it).
 * It is a safety net for hand-typed labels (an '8 GiB', '8.0 GB', '8-GB', '8192 MB' or 'notebook' machine). The real label comes from WMI facts in
 * scripts/win/run-capped.ps1 ('16 GB RAM', '4 vCPU', a job limit written in bytes), so it never trips this. 'laptop' is allowed only in the fixed suffix,
 * which is cut off before the test.
 */
export const MACHINE_8GB_OR_LAPTOP_RE =
  /(^|[^0-9.,])(8([.,][0-9]+)?[ .-]{0,2}(GiB|GBytes?|GBs?|gigabytes?|gibibytes?|gig|G)\b|(8000|8192)([.,]0+)? ?(MiB|MB|M)\b)|\beight[ -]?(GB|GiB|gigabytes?|gibibytes?)\b|notebook|laptop/i;

/**
 * Returns the label when it is acceptable, otherwise throws an Error whose message starts with 'environment label'. Acceptable: the pattern above, the word
 * 'laptop' only in the suffix, and no 8 GB figure (see MACHINE_8GB_OR_LAPTOP_RE; a job limit is written in bytes).
 */
export function validateEnvironmentLabel(label) {
  if (typeof label !== 'string') throw new Error('environment label must be a string');
  if (!ENVIRONMENT_LABEL_RE.test(label))
    throw new Error(
      "environment label must read 'emulated: <what was run>; not a laptop' (letters, digits, spaces and , . ; : ( ) / + - only, at most 300 characters before the suffix)",
    );
  const body = label.slice(0, -LABEL_SUFFIX.length);
  if (/laptop/i.test(body))
    throw new Error("environment label may say 'laptop' only in its '; not a laptop' suffix");
  if (MACHINE_8GB_OR_LAPTOP_RE.test(body))
    throw new Error('environment label must not read as an 8 GB machine or a notebook');
  return label;
}

/** The columns of a Windows emulated run's runs file (job_* figures are filled from job-summary.json by scripts/bench-emulated-merge.mjs). */
export const E2E_EMULATED_COLUMNS = [
  ...E2E_COLUMNS,
  'environment',
  'job_commit_limit_bytes', // the Job Object commit limit; empty for the leg with no limit
  'job_commit_peak_bytes', // PeakJobMemoryUsed of the whole run: the pwsh, node and Chrome process tree (the same in every row of a leg)
  'process_commit_peak_bytes', // the Chrome-only sum of PrivatePageCount at its peak in this run
  'job_escapes', // Chrome processes seen outside the job
  'sampler_median_interval_ms',
  'failure_reason',
];

/**
 * BUG-T1-S7-06 (documented zero-row rule): an emulated run that fails before its first run completes (the model download, waitReady, the reload) still
 * leaves a trace. The runs CSV gets ONE row with run 0, restart false, every figure empty, answer_ok false, failure_reason set and the environment label
 * verbatim; the questions CSV gets ONE row with run 0 and an empty qid. laptop_8gb stays 'not measured on 8 GB' in both. A run that failed after its first
 * run began already has a row and never gets a run-0 one. Never used for the laptop CSVs (a laptop run that fails keeps its header-only file).
 */
export function runZeroRows({ date, label, commit, reason, loadStart = '', loadEnd = '' }) {
  const base = {
    date,
    machine: label,
    commit,
    run: 0,
    restart: false,
    answer_ok: false,
    laptop_8gb: LAPTOP_8GB,
  };
  const e2e = {
    ...base,
    chrome: '',
    host_load_1m_start: loadStart,
    host_load_1m_end: loadEnd,
    environment: label,
    job_commit_limit_bytes: '',
    job_commit_peak_bytes: '',
    process_commit_peak_bytes: '',
    job_escapes: '',
    sampler_median_interval_ms: '',
    failure_reason: reason,
  };
  const q = { ...base, qid: '', environment: label, failure_reason: reason };
  return { e2e, q };
}

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

export const Q_EMULATED_COLUMNS = [...Q_COLUMNS, 'environment', 'failure_reason'];

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
  if (cols.includes('environment')) {
    rows.forEach((r, i) => {
      try {
        validateEnvironmentLabel(r.environment);
      } catch (e) {
        throw new Error(`row ${i + 1}: ${e.message}`);
      }
    });
  }
  if (cols.includes('failure_reason')) {
    rows.forEach((r, i) => {
      const f = r.failure_reason ?? '';
      if (f !== '' && !FAILURE_REASONS.includes(f))
        throw new Error(
          `row ${i + 1}: failure_reason must be empty or one of ${FAILURE_REASONS.join(', ')}, not '${f}'`,
        );
    });
  }
  return `${cols.join(',')}\n${rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\n')}\n`;
};
