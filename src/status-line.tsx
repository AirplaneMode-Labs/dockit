import { SPRINT_STATUS_LINE } from './status-line-text.ts';

/** The sprint status line as a plain text node, so the CSP and index.html stay unchanged. */
export function StatusLine() {
  return (
    <p className="status-line" id="sprint-status" data-testid="sprint-status">
      {SPRINT_STATUS_LINE}
    </p>
  );
}
