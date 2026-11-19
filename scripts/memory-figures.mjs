// The before and after memory figures of Sprint 6 (B1, TD-66, TD-77), derived from the four committed CSVs and nothing else (BUG-T1-S6-04).
//
// ONE ROUNDING RULE, used by the README, the status line, the site benchmarks page and the write-up: every difference and every percentage is computed
// from the EXACT medians (in bytes, then MiB, never rounded in between) and is rounded only when it is written. A rounded median is a display value.
// "Median" means the median of the in-session runs (rows with restart = false); the run after a Chrome restart is a separate row and is not in it.

/** What TD-66 stated before the after-measurement (the architect, 19 Nov 2026): a median peak at most 5,120 MiB, the question set no worse than 24 of 36 and 4 of 6, a per-question total median at most 12,500 ms. */
export const TARGET = Object.freeze({
  rssMedianMiB: 5120,
  totalMedianMs: 12500,
  questionAllMin: 24,
  questionFirstRunMin: 4,
});

export function parseCsv(text) {
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  return lines
    .slice(1)
    .map((l) =>
      Object.fromEntries(
        head.map((h, i) => [
          h,
          (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((c) =>
            c.replace(/,$/, '').replace(/^"|"$/g, '').replaceAll('""', '"'),
          )[i] ?? '',
        ]),
      ),
    );
}

const MIB = 1048576;
/** Exact median of numbers (an even count averages the two middle ones). null when a value is missing: a median over some runs reads as all of them. */
export function exactMedian(values) {
  if (values.length === 0 || values.some((v) => v === null || !Number.isFinite(v))) return null;
  const a = [...values].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const num = (s) => (s === '' || s === undefined ? null : Number(s));
const col = (rows, c) => rows.map((r) => num(r[c]));

function one(e2eText, qText) {
  const rows = parseCsv(e2eText);
  const session = rows.filter((r) => r.restart !== 'true');
  const qs = parseCsv(qText);
  const rss = col(session, 'process_rss_peak_bytes');
  return {
    runs: session.length,
    restartRuns: rows.length - session.length,
    rssMedianMiB: exactMedian(rss) / MIB,
    rssWorstMiB: Math.max(...rss) / MIB,
    perQuestionTotalMedianMs: exactMedian(col(qs, 'total_ms')),
    perQuestionTotalWorstMs: Math.max(...col(qs, 'total_ms')),
  };
}

/** The figures for the baseline pair and the after pair, with every difference taken from the exact medians. */
export function memoryFigures(baseE2e, baseQ, afterE2e, afterQ) {
  const b = one(baseE2e, baseQ);
  const a = one(afterE2e, afterQ);
  const fallMiB = b.rssMedianMiB - a.rssMedianMiB;
  const timeRiseMs = a.perQuestionTotalMedianMs - b.perQuestionTotalMedianMs;
  return {
    before: b,
    after: a,
    fallMiB,
    fallPercent: (fallMiB / b.rssMedianMiB) * 100,
    timeRiseMs,
  };
}

const n0 = (x) => Math.round(x).toLocaleString('en-US');
/** The sentence fragments every document uses, so the rounding is in one place. */
export function memoryWords(f) {
  return {
    beforeMedian: `${n0(f.before.rssMedianMiB)} MiB`,
    afterMedian: `${n0(f.after.rssMedianMiB)} MiB`,
    afterWorst: `${n0(f.after.rssWorstMiB)} MiB`,
    fall: `${n0(f.fallMiB)} MiB`,
    fallExact1: `${f.fallMiB.toFixed(1)} MiB`,
    fallPercent: f.fallPercent.toFixed(1),
    beforeWorst: `${n0(f.before.rssWorstMiB)} MiB`,
    beforeQMedianMs: `${n0(f.before.perQuestionTotalMedianMs)} ms`,
    afterQMedianMs: `${n0(f.after.perQuestionTotalMedianMs)} ms`,
    afterQWorstMs: `${n0(f.after.perQuestionTotalWorstMs)} ms`,
    slowerSeconds: (f.timeRiseMs / 1000).toFixed(1),
    runsNote: `median of the ${f.after.runs} in-session runs; the run after a Chrome restart is shown separately`,
    roundingNote: `Differences and percentages are computed from the exact medians (the exact fall is ${f.fallMiB.toFixed(1)} MiB, shown as ${n0(f.fallMiB)} MiB) and then rounded, so a difference can differ by 1 MiB from the subtraction of the two rounded medians.`,
  };
}
