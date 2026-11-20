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

/**
 * The columns of a Windows emulated run's runs file written before the limit was read back (the first dispatch of bench-windows, run 44656249868). The committed
 * docs/benchmarks/e2e-emulated-win-vm.csv still has exactly this header, so every reader accepts it (EMULATED_HEADERS) and treats the columns it lacks as empty:
 * 'limit unproven'. Nothing writes this header any more.
 */
export const E2E_EMULATED_COLUMNS_V1 = [
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
 * The columns of a Windows emulated run's runs file. job_* figures and the six limit-evidence columns after failure_reason are filled from job-summary.json by
 * scripts/bench-emulated-merge.mjs; bench-e2e writes them empty. An empty evidence cell means 'not read back / not probed' (a run before the evidence existed, or
 * a leg with nothing to probe), never 'passed'.
 */
export const E2E_EMULATED_COLUMNS = [
  ...E2E_EMULATED_COLUMNS_V1,
  'job_limit_readback_bytes', // JobMemoryLimit as QueryInformationJobObject reports it after the process was assigned; 0 on the leg with no limit
  'job_limit_flags_readback', // LimitFlags as reported, '0x2200' (job memory and kill on close) or '0x2000' (kill on close only)
  'limit_probe_refused', // 'true': a commit of limit + 256 MiB made from inside the job was refused; 'false': it succeeded; empty: no probe (or an inconclusive one)
  'job_peak_after_probe_bytes', // PeakJobMemoryUsed right after the probe (a refused commit that is counted in the peak shows here)
  'job_memory_limit_messages', // JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages the job's completion port received over the whole run; empty when no port was attached
  'control_leg', // 'true' on the control leg (a limit the benchmark must not complete under), 'false' on the others; empty before the field existed
];

/** The two headers a committed emulated runs CSV may have: the current one and the one written before the limit evidence existed. */
export const EMULATED_HEADERS = Object.freeze([
  E2E_EMULATED_COLUMNS.join(','),
  E2E_EMULATED_COLUMNS_V1.join(','),
]);

/** The legs there are: name -> job commit limit in bytes (null: none). The control leg is the one whose limit is far below what the benchmark needs. */
export const LEG_CAPS = Object.freeze({
  none: null,
  '8GiB': 8589934592,
  '6GiB': 6442450944,
  '5GiB': 5368709120,
  '2GiB': 2147483648,
});
/** The legs that are controls: the benchmark must NOT complete under their limit, and their rows are never benchmark figures. */
export const CONTROL_CAPS = Object.freeze(['2GiB']);

/** What the probe commits above the limit, in bytes (256 MiB): scripts/win/run-capped.ps1 and the evidence text of the README and the site. */
export const PROBE_OVER_LIMIT_BYTES = 268435456;

/** The values a limit-evidence cell may hold. */
export const LIMIT_FLAGS_READBACK = Object.freeze(['', '0x2000', '0x2200']);
const TRUE_FALSE_OR_EMPTY = Object.freeze(['', 'true', 'false']);
const COUNT_CELL = /^\d{1,16}$/;

/**
 * What one leg's evidence says about its commit limit, from the evidence cells of ONE of its rows (every row of a leg carries the same cells):
 *   no_limit           the leg sets no limit (with or without a read-back: flags 0x2000, JobMemoryLimit 0)
 *   proven             the limit read back equals what was set (0x2200 and the limit) AND the probe commit above the limit was refused
 *   not_enforced       the limit read back equals what was set, and the probe commit above the limit succeeded: the cap was not in force
 *   readback_mismatch  a read-back that differs from what was set
 *   unproven           no read-back or no (conclusive) probe: a run before the evidence existed, or an inconclusive probe
 * 'proven' needs both halves. A copy of this function is in site/scripts/import-dockit-emulated.mjs (test:siblings compares them on a table of rows).
 */
export function limitProof(row) {
  const limit = row.job_commit_limit_bytes ?? '';
  const bytes = row.job_limit_readback_bytes ?? '';
  const flags = row.job_limit_flags_readback ?? '';
  const probe = row.limit_probe_refused ?? '';
  const read = bytes !== '' || flags !== '';
  if (limit === '') {
    // no limit is set: a read-back, when there is one, must say so (0x2000, 0)
    return read && !(flags === '0x2000' && bytes === '0') ? 'readback_mismatch' : 'no_limit';
  }
  if (!read) return 'unproven';
  if (!(flags === '0x2200' && bytes === limit)) return 'readback_mismatch';
  if (probe === 'true') return 'proven';
  if (probe === 'false') return 'not_enforced';
  return 'unproven';
}

/** The wording of each reading, shared by the README block (scripts/bench-readme.mjs); site/scripts/build.mjs holds the same sentences. */
export const LIMIT_PROOF_TEXT = Object.freeze({
  no_limit: 'no limit set',
  proven: 'limit proven in force (probe refused, read-back equal)',
  not_enforced: 'cap NOT in force (the probe committed over the limit)',
  readback_mismatch: 'read-back differs from what was set (not a result under this cap)',
  unproven: 'limit unproven',
});

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
    job_limit_readback_bytes: '',
    job_limit_flags_readback: '',
    limit_probe_refused: '',
    job_peak_after_probe_bytes: '',
    job_memory_limit_messages: '',
    control_leg: '',
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
  if (cols.includes('limit_probe_refused')) {
    rows.forEach((r, i) => {
      const bad = (c, ok) => `row ${i + 1}: ${c} must be ${ok}, not '${r[c] ?? ''}'`;
      for (const c of ['limit_probe_refused', 'control_leg'])
        if (!TRUE_FALSE_OR_EMPTY.includes(String(r[c] ?? '')))
          throw new Error(bad(c, 'empty, true or false'));
      if (!LIMIT_FLAGS_READBACK.includes(String(r.job_limit_flags_readback ?? '')))
        throw new Error(bad('job_limit_flags_readback', 'empty, 0x2000 or 0x2200'));
      for (const c of [
        'job_limit_readback_bytes',
        'job_peak_after_probe_bytes',
        'job_memory_limit_messages',
      ])
        if (String(r[c] ?? '') !== '' && !COUNT_CELL.test(String(r[c])))
          throw new Error(bad(c, 'empty or a non-negative integer'));
    });
  }
  return `${cols.join(',')}\n${rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\n')}\n`;
};
