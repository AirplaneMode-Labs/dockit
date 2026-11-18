import type { RefusalInfo } from '../app/controller.ts';

/** A documented refusal in plain language. The message and every detail are text nodes. */
export function RefusalBox({ refusal, testId }: { refusal: RefusalInfo; testId: string }) {
  return (
    <div
      className="box box-warn refusal"
      role="alert"
      data-testid={testId}
      data-reason={refusal.reason}
    >
      <p data-testid={`${testId}-message`}>{refusal.message}</p>
      {refusal.detail === undefined ? null : (
        <p className="muted small" data-testid={`${testId}-detail`}>
          Reason: {refusal.detail}
        </p>
      )}
      {refusal.pages === undefined || refusal.pages.length === 0 ? null : (
        <ul className="small" data-testid={`${testId}-pages`}>
          {refusal.pages.map((p) => (
            <li key={p.page}>
              Page {p.page}: {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
