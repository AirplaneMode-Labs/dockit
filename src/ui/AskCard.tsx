import { useState } from 'react';
import type { AppState } from '../app/controller.ts';
import { RefusalBox } from './RefusalBox.tsx';
import { ms } from './format.ts';

interface Props {
  ask: AppState['ask'];
  ready: boolean;
  onAsk: (question: string) => void;
  onStop: () => void;
}

/**
 * Ask and Stop, the answer, the time to first token, and the sources. A Stop before the first token shows a plain 'Stopped.' (no answer, no
 * refusal); a Stop after it keeps the partial answer. The answer is ONE text node (its CSS class keeps line
 * breaks and sets unicode-bidi: plaintext); no markdown, no auto-linking, no href from model or PDF text. Source pages come
 * from the retrieved chunk's metadata, never from the answer.
 */
export function AskCard({ ask, ready, onAsk, onStop }: Props) {
  const [question, setQuestion] = useState('');
  const working = ask.status === 'working';
  return (
    <section className="card card-wide" data-testid="ask-card">
      <h2>Ask</h2>
      <label className="field">
        <span>Question</span>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          autoComplete="off"
          disabled={!ready || working}
          data-testid="question"
        />
      </label>
      <button
        type="button"
        onClick={() => onAsk(question)}
        disabled={!ready || working || question.trim() === ''}
        data-testid="ask"
      >
        Ask
      </button>{' '}
      <button type="button" onClick={onStop} disabled={!working} data-testid="stop">
        Stop
      </button>
      {working ? (
        <p className="answer-text" data-testid="answer-streaming">
          {ask.streamed}
        </p>
      ) : null}
      {ask.status === 'stopped' ? (
        <p className="muted" data-testid="ask-stopped">
          Stopped.
        </p>
      ) : null}
      {ask.answer === undefined ? null : (
        <div data-testid="answer-block">
          <p className="answer-text" data-testid="answer">
            {ask.displayText}
          </p>
          <p className="muted small" data-testid="first-token">
            Time to first token: {ms(ask.answer.firstTokenMs)}. Total: {ms(ask.answer.totalMs)}.
          </p>
          {ask.answer.outTokens === null ? null : (
            <p className="muted small" data-testid="throughput">
              {ask.answer.outTokens} tokens
              {ask.answer.tokensPerSecond === null
                ? ''
                : ` at ${ask.answer.tokensPerSecond.toFixed(1)} tokens per second`}
              .
            </p>
          )}
          {ask.answer.sources.length === 0 ? null : (
            <div data-testid="sources">
              <h3>Sources</h3>
              <ul>
                {ask.answer.sources.map((s) => (
                  <li
                    key={s.id}
                    data-testid={`source-${s.id}`}
                    data-cited={s.cited ? 'true' : 'false'}
                  >
                    <span>
                      {s.id}, page {s.pages}
                      {s.cited ? ' (cited)' : ''}
                    </span>
                    <details>
                      <summary>Show the passage</summary>
                      <p className="answer-text">{s.text}</p>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {ask.refusal === undefined ? null : <RefusalBox refusal={ask.refusal} testId="ask-refusal" />}
    </section>
  );
}
