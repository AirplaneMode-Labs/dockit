import { useRef, useState } from 'react';
import type { AppState } from '../app/controller.ts';
import { RefusalBox } from './RefusalBox.tsx';

/** S1-112 c: the first sentence is the one S1 reviewed; the second says what the stored record holds. */
export const KEEP_WARNING =
  'Stored unencrypted in this browser profile; any page on airplanemode-labs.github.io can read it. ' +
  'What is stored: the chunk text, the embeddings, the page numbers and the SHA-256 of the file, and that hash can confirm whether a known document was processed.';

const STAGE_LABEL: Record<string, string> = {
  read: 'Read the file',
  triage: 'Triage each page (pagetriage)',
  extract: 'Extract the text layer',
  chunk: 'Split into passages',
  gate: 'Glyph gate (glyphsift)',
  embed: 'Embed the passages',
  index: 'Store the vectors and passages',
};

interface Props {
  doc: AppState['doc'];
  kept: AppState['kept'];
  onFile: (file: File) => void;
  onKeep: (keep: boolean) => void;
  onDelete: () => void;
  onUseKept: (docId: string) => void;
  onDeleteKept: (docId: string) => void;
}

/** Choose or drop a PDF; per-stage progress; the document's facts; Delete; the 'Keep on this device' opt-in. */
export function DocumentCard({
  doc,
  kept,
  onFile,
  onKeep,
  onDelete,
  onUseKept,
  onDeleteKept,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const busy = doc.status === 'working';
  return (
    <section className="card card-wide" data-testid="document-card">
      <h2>Document</h2>
      <div
        className={over ? 'drop drop-over' : 'drop'}
        data-testid="drop-zone"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f !== undefined && !busy) onFile(f);
        }}
      >
        <p>Drop a PDF here, or</p>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          data-testid="file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f !== undefined) onFile(f);
            e.target.value = '';
          }}
        />
        <p className="muted small">The file stays in this tab. It is never uploaded.</p>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={doc.keep}
          onChange={(e) => onKeep(e.target.checked)}
          data-testid="keep-on-device"
        />
        <span> Keep on this device</span>
      </label>
      {doc.keep ? (
        <p className="muted small" data-testid="keep-warning">
          {KEEP_WARNING}
        </p>
      ) : null}
      {doc.status === 'none' ? null : (
        <ol className="stages" data-testid="stages">
          {doc.stages.map((r) => (
            <li key={r.stage} data-testid={`stage-${r.stage}`} data-status={r.status}>
              <span className="stage-title">{STAGE_LABEL[r.stage] ?? r.stage}</span>:{' '}
              <span className="stage-detail">
                {r.status === 'ok' && r.ms !== undefined
                  ? `done in ${Math.round(r.ms)} ms`
                  : r.status}
              </span>
            </li>
          ))}
        </ol>
      )}
      {doc.refusal === undefined ? null : <RefusalBox refusal={doc.refusal} testId="doc-refusal" />}
      {doc.info === undefined ? null : (
        <div data-testid="doc-info">
          <p data-testid="doc-summary">
            {doc.info.pages} pages, {doc.info.chunks} passages indexed
            {doc.info.held > 0 ? `, ${doc.info.held} held back` : ''}.
          </p>
          {doc.info.skippedPages.length === 0 ? null : (
            <ul className="small" data-testid="skipped-pages">
              {doc.info.skippedPages.map((p) => (
                <li key={p.page}>
                  Page {p.page} skipped: {p.reason}
                </li>
              ))}
            </ul>
          )}
          {doc.info.heldChunks.length === 0 ? null : (
            <ul className="small" data-testid="held-chunks">
              {doc.info.heldChunks.map((h) => (
                <li key={h.ordinal} data-reason={h.reason}>
                  {h.reason === 'held_low_score'
                    ? `Passage on page ${h.pages} was held back: ${h.reason}. Score ${h.ppm} ppm, threshold ${h.threshold} ppm.`
                    : `Passage on page ${h.pages} was not indexed. ${h.message}`}
                </li>
              ))}
            </ul>
          )}
          {doc.info.truncated ? (
            <p className="muted small">The text was cut at the size limit.</p>
          ) : null}
          <button type="button" onClick={onDelete} data-testid="delete-document">
            Delete this document
          </button>
        </div>
      )}
      {kept.length === 0 ? null : (
        <div data-testid="kept-list">
          <h3>Kept on this device</h3>
          <ul>
            {kept.map((k, i) => (
              <li key={k.docId}>
                Saved document {i + 1}: {k.pages} pages, {k.chunks} passages{' '}
                <button
                  type="button"
                  onClick={() => onUseKept(k.docId)}
                  data-testid={`use-kept-${i}`}
                >
                  Use
                </button>{' '}
                <button
                  type="button"
                  onClick={() => onDeleteKept(k.docId)}
                  data-testid={`delete-kept-${i}`}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
