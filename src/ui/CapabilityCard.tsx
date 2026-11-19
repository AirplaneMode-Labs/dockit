import type { AppState } from '../app/controller.ts';
import { MEMORY_UNKNOWN_TEXT, memoryBelowText, memoryLineText } from '../pipeline/memory-line.ts';

/** The runtime capability profile and the verdict against the model's minProfile. Every figure is a text node. */
export function CapabilityCard({ capability }: { capability: AppState['capability'] }) {
  const p = capability.profile;
  // The verdict is the memory line (TD-67): read from the verified manifest, never a constant of the page. Unknown is not below it (TD-84).
  const m = capability.memory;
  const verdictText =
    m.kind === 'meets'
      ? memoryLineText(m.reportedGb, m.requiredGb)
      : m.kind === 'below'
        ? memoryBelowText(m.reportedGb, m.requiredGb)
        : m.kind === 'unknown'
          ? MEMORY_UNKNOWN_TEXT
          : 'No memory line yet: the model list is not verified on this device.';
  return (
    <section className="card" data-testid="capability-card">
      <h2>Capability profile</h2>
      {p === null ? (
        <p className="muted" data-testid="capability-pending">
          Measuring this browser...
        </p>
      ) : (
        <dl className="kv">
          <dt>gpu</dt>
          <dd data-testid="cap-gpu">{p.gpu}</dd>
          <dt>ramGb</dt>
          <dd data-testid="cap-ram">{p.ramGb === 0 ? 'unknown' : String(p.ramGb)}</dd>
          <dt>storageFreeGb</dt>
          <dd data-testid="cap-storage">{String(p.storageFreeGb)}</dd>
          <dt>cores</dt>
          <dd data-testid="cap-cores">{String(p.cores)}</dd>
          <dt>backendTier</dt>
          <dd data-testid="cap-tier">{p.backendTier}</dd>
        </dl>
      )}
      <p data-testid="capability-verdict" data-verdict={capability.verdict}>
        {verdictText}
      </p>
      <p className="muted small" data-testid="capability-note">
        {capability.note}
      </p>
    </section>
  );
}
