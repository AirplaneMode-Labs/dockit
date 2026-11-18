import type { AppState } from '../app/controller.ts';

/** The runtime capability profile and the verdict against the model's minProfile. Every figure is a text node. */
export function CapabilityCard({ capability }: { capability: AppState['capability'] }) {
  const p = capability.profile;
  const verdictText =
    capability.verdict === 'meets'
      ? 'This device meets the minimum for the demo model.'
      : capability.verdict === 'below'
        ? 'This device is below the minimum for the demo model.'
        : 'Not measured yet.';
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
