import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_NOTE, refusalInfo, type AppState } from '../../src/app/controller.ts';
import { PIPELINE_REASONS, REFUSAL_MESSAGES, Refusal } from '../../src/pipeline/reasons.ts';
import { AskCard } from '../../src/ui/AskCard.tsx';
import { CapabilityCard } from '../../src/ui/CapabilityCard.tsx';
import { DocumentCard, KEEP_WARNING } from '../../src/ui/DocumentCard.tsx';
import { Framed } from '../../src/ui/Framed.tsx';
import { ModelCard } from '../../src/ui/ModelCard.tsx';
import { RefusalBox } from '../../src/ui/RefusalBox.tsx';
import { sanitiseDisplay } from '../../src/ui/answer-text.ts';

const noop = () => undefined;
const stages = (over: Record<string, string> = {}) =>
  ['read', 'triage', 'extract', 'chunk', 'gate', 'embed', 'index'].map((stage) => ({
    stage: stage as never,
    status: (over[stage] ?? 'waiting') as never,
  }));
const doc = (over: Partial<AppState['doc']> = {}): AppState['doc'] => ({
  status: 'none',
  stages: stages(),
  info: undefined,
  refusal: undefined,
  keep: false,
  ...over,
});
const ask = (over: Partial<AppState['ask']> = {}): AppState['ask'] => ({
  status: 'idle',
  answer: undefined,
  displayText: '',
  refusal: undefined,
  streamed: '',
  ...over,
});
const model = (over: Partial<AppState['model']> = {}): AppState['model'] => ({
  status: 'absent',
  plannedBytes: 736_000_000,
  receivedBytes: 0,
  totalBytes: 0,
  refusal: undefined,
  ...over,
});

describe('plain-language refusals', () => {
  it('every PIPELINE_REASONS value has a plain message with no code name in it', () => {
    for (const r of PIPELINE_REASONS) {
      expect(REFUSAL_MESSAGES[r], r).toMatch(/\.$/);
      expect(REFUSAL_MESSAGES[r], r).not.toMatch(/_/);
    }
  });

  it.each([
    ['no_text_layer', 'OCR is not yet supported'],
    ['too_large', '20 MiB'],
    ['corrupt', 'damaged'],
    ['encrypted', 'password-protected'],
    ['model_not_cached', 'Connect once and press Download.'],
    ['manifest_refused', 'refused'],
    ['integrity', 'did not match'],
    ['framed', 'Open it directly.'],
  ] as const)('%s shows its message', (reason, phrase) => {
    const info = refusalInfo(new Refusal(reason))!;
    const html = renderToStaticMarkup(<RefusalBox refusal={info} testId="r" />);
    expect(html).toContain(phrase);
    expect(html).toContain(`data-reason="${reason}"`);
    expect(html).toContain('role="alert"');
  });

  it('model_not_cached reads exactly: The model is not downloaded on this device. Connect once and press Download.', () => {
    expect(REFUSAL_MESSAGES.model_not_cached).toBe(
      'The model is not downloaded on this device. Connect once and press Download.',
    );
  });

  it('manifest_refused shows the verifier reason', () => {
    const info = refusalInfo(
      new Refusal('manifest_refused', undefined, { reason: 'unexpected_id' }),
    )!;
    expect(renderToStaticMarkup(<RefusalBox refusal={info} testId="r" />)).toContain(
      'Reason: unexpected_id',
    );
  });

  it('no_text_layer lists each skipped page with its reason', () => {
    const info = refusalInfo(
      new Refusal('no_text_layer', undefined, {
        pages: [
          { page: 1, reason: 'ocr_not_yet' },
          { page: 2, reason: 'ocr_not_yet' },
        ],
      }),
    )!;
    const html = renderToStaticMarkup(<RefusalBox refusal={info} testId="r" />);
    expect(html).toContain('Page 1: This page is an image only');
    expect(html).toContain('Page 2:');
  });

  it('refusal text is escaped: markup in a message or detail is a text node', () => {
    const html = renderToStaticMarkup(
      <RefusalBox
        refusal={{
          reason: 'corrupt',
          message: '<img src=x onerror=alert(1)>',
          detail: '<script>1</script>',
        }}
        testId="r"
      />,
    );
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;img');
  });
});

describe('framed state', () => {
  it('shows only an Open dockit directly link, with no file input, no Download and no Ask', () => {
    const html = renderToStaticMarkup(<Framed />);
    expect(html).toContain('Open dockit directly');
    expect(html).toContain('href="./"');
    expect(html).toContain('rel="noopener"');
    expect(html).not.toMatch(/<input|<button|Download|>Ask</);
    expect(html).toContain('dockit does not run inside another page');
  });
});

describe('answer rendering', () => {
  const answerText =
    'It is 45 days <img src=https://evil.example/x onerror=alert(1)> [S1] <a href="https://evil.example">click</a> **bold** [link](https://evil.example)';
  const answer = {
    text: answerText,
    sources: [
      {
        id: 'S1',
        pages: '2',
        cited: true,
        text: 'The grace period is 45 days. <script>alert(1)</script>',
      },
      { id: 'S2', pages: '2 to 3', cited: false, text: 'Other.' },
    ],
    cited: [],
    unknownCitations: 0,
    firstTokenMs: 812,
    totalMs: 4200,
    outTokens: 12,
    tokensPerSecond: 3,
    finishReason: 'stop' as const,
    budget: 256,
  };
  const html = renderToStaticMarkup(
    <AskCard
      ask={ask({ status: 'done', answer, displayText: sanitiseDisplay(answerText) })}
      ready
      onAsk={noop}
      onStop={noop}
    />,
  );

  it('renders the answer as escaped text: no img, a, iframe or script element, and no element with an href in the card', () => {
    expect(html).not.toMatch(/<img|<iframe|<svg|<script|<object|<embed/);
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toMatch(/<[a-z][^>]*\shref=/i); // no element carries an href (the escaped text above is not an element)
    expect(html).toContain('&lt;img src=https://evil.example/x onerror=alert(1)&gt;');
    expect(html).toContain('**bold**'); // no markdown
  });

  it('the answer is one text node inside an element with the answer-text class', () => {
    const m = /<p class="answer-text" data-testid="answer">([^<]*)<\/p>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('45 days');
  });

  it('shows the time to first token and the sources with pages from metadata; cited ones are marked', () => {
    expect(html).toContain('Time to first token: 812 ms');
    expect(html).toContain('S1, page 2 (cited)');
    expect(html).toContain('S2, page 2 to 3');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('the Ask button is disabled until a model is ready and a question is typed; Stop only while working', () => {
    const idle = renderToStaticMarkup(
      <AskCard ask={ask()} ready={false} onAsk={noop} onStop={noop} />,
    );
    expect(idle).toMatch(/data-testid="ask"[^>]*disabled|disabled=""[^>]*data-testid="ask"/);
    const working = renderToStaticMarkup(
      <AskCard
        ask={ask({ status: 'working', streamed: 'partial' })}
        ready
        onAsk={noop}
        onStop={noop}
      />,
    );
    expect(working).toContain('partial');
    expect(working).not.toMatch(
      /disabled=""[^>]*data-testid="stop"|data-testid="stop"[^>]*disabled/,
    );
  });

  // BUG-T1-S5-R2-02
  it('a Stopped answer card says Stopped. in plain text, with no answer text and no failure message', () => {
    const html = renderToStaticMarkup(
      <AskCard ask={ask({ status: 'stopped' })} ready onAsk={noop} onStop={noop} />,
    );
    expect(html).toMatch(/data-testid="ask-stopped"[^>]*>Stopped\.</);
    expect(html).not.toContain('The answer failed');
    expect(html).not.toContain('data-testid="ask-refusal"');
    expect(html).not.toContain('data-testid="answer-block"');
    expect(html).not.toContain('corrupt');
  });

  it('a generic failure is shown as The answer failed. with the reason failed, never corrupt', () => {
    const html = renderToStaticMarkup(
      <AskCard
        ask={ask({
          status: 'refused',
          refusal: { reason: 'failed', message: 'The answer failed.' },
        })}
        ready
        onAsk={noop}
        onStop={noop}
      />,
    );
    expect(html).toContain('The answer failed.');
    expect(html).toContain('data-reason="failed"');
    expect(html).not.toContain('corrupt');
  });

  it('strips tag characters and bidi controls from what is displayed', () => {
    expect(sanitiseDisplay('a\u{E0041}b‮c⁦d⁩e')).toBe('abcde');
    expect(sanitiseDisplay('क्‍ष')).toBe('क्‍ष');
  });
});

describe('model card', () => {
  it('offers Download model (about N MB, once) with the planned size, disabled while offline', () => {
    const on = renderToStaticMarkup(<ModelCard model={model()} online onDownload={noop} />);
    expect(on).toContain('Download model (about 736 MB, once)');
    const off = renderToStaticMarkup(
      <ModelCard model={model()} online={false} onDownload={noop} />,
    );
    expect(off).toMatch(/disabled=""/);
    expect(off).toContain('You are offline');
  });
  it('shows progress while downloading and hides the button once the model is on the device', () => {
    const dl = renderToStaticMarkup(
      <ModelCard
        model={model({
          status: 'downloading',
          receivedBytes: 100_000_000,
          totalBytes: 736_000_000,
        })}
        online
        onDownload={noop}
      />,
    );
    expect(dl).toContain('Downloading: 100 MB of 736 MB');
    expect(dl).toContain('<progress');
    const done = renderToStaticMarkup(
      <ModelCard model={model({ status: 'cached' })} online onDownload={noop} />,
    );
    expect(done).not.toContain('Download model');
    expect(done).toContain('Downloaded and verified on this device.');
  });
});

describe('model card while the model is loaded again (BUG-T1-S5-R2-01)', () => {
  it('says Loading the model again while a stopped model is re-loaded, and the first load keeps its own wording', () => {
    const again = renderToStaticMarkup(
      <ModelCard model={model({ status: 'loading', reloading: true })} online onDownload={noop} />,
    );
    expect(again).toContain('Loading the model again from this device...');
    expect(again).toContain('data-status="loading"');
    const first = renderToStaticMarkup(
      <ModelCard model={model({ status: 'loading' })} online onDownload={noop} />,
    );
    expect(first).toContain('Loading the model from this device...');
    expect(first).not.toContain('again');
  });

  it('a refused model is not described as not downloaded', () => {
    const html = renderToStaticMarkup(
      <ModelCard
        model={model({
          status: 'refused',
          refusal: {
            reason: 'integrity',
            message: 'A model file did not match its recorded hash and was not used.',
          },
        })}
        online
        onDownload={noop}
      />,
    );
    expect(html).toContain('The model could not be used.');
    expect(html).not.toContain('Not downloaded on this device.');
    expect(html).toContain('did not match its recorded hash');
  });
});

describe('capability card', () => {
  const profile = {
    spec: 'airplanemode.capability/0.1',
    gpu: 'none',
    ramGb: 8,
    storageFreeGb: 12.5,
    cores: 8,
    backendTier: 'wasm-simd',
    features: {},
    measuredAt: 'x',
  } as never;
  it('shows the profile fields, the verdict, and the note that ramGb is the rounded reported memory', () => {
    const html = renderToStaticMarkup(
      <CapabilityCard
        capability={{
          profile,
          verdict: 'meets',
          note: CAPABILITY_NOTE,
        }}
      />,
    );
    for (const t of [
      'wasm-simd',
      '12.5',
      'meets the minimum',
      'rounded memory the browser reports (navigator.deviceMemory)',
    ])
      expect(html).toContain(t);
    expect(html).not.toContain('cap the reported memory');
  });
  it('says Measuring while the profile is pending', () => {
    expect(
      renderToStaticMarkup(
        <CapabilityCard capability={{ profile: null, verdict: 'unknown', note: 'n' }} />,
      ),
    ).toContain('Measuring');
  });
});

describe('document card', () => {
  const info = {
    docId: 'd',
    ns: 'dockit.dd',
    pages: 3,
    chunks: 5,
    held: 1,
    heldChunks: [
      {
        ordinal: 2,
        pages: '2',
        reason: 'held_low_score' as const,
        ppm: 400000,
        threshold: 975000,
        message: 'm',
      },
    ],
    skippedPages: [{ page: 3, reason: 'ocr_not_yet' as const }],
    kept: false,
    truncated: false,
  };
  it('shows the held chunk with its reason, ppm and threshold, and the skipped page', () => {
    const html = renderToStaticMarkup(
      <DocumentCard
        doc={doc({ status: 'ready', info, stages: stages({ read: 'ok' }) })}
        kept={[]}
        onFile={noop}
        onKeep={noop}
        onDelete={noop}
        onUseKept={noop}
        onDeleteKept={noop}
      />,
    );
    expect(html).toContain('held_low_score');
    expect(html).toContain('Score 400000 ppm, threshold 975000 ppm');
    expect(html).toContain('Page 3 skipped: ocr_not_yet');
    expect(html).toContain('3 pages, 5 passages indexed, 1 held back.');
    expect(html).toContain('Delete this document');
  });
  it('a passage set aside because the embedder or the store refused it says so in words, with no score (BUG-T2-S5-10)', () => {
    const html = renderToStaticMarkup(
      <DocumentCard
        doc={doc({
          status: 'ready',
          info: {
            ...info,
            held: 1,
            heldChunks: [
              {
                ordinal: 1,
                pages: '2',
                reason: 'not_analysed' as const,
                ppm: null,
                threshold: null,
                message: 'This passage could not be embedded, so it is not searched.',
              },
            ],
          },
          stages: stages({ read: 'ok' }),
        })}
        kept={[]}
        onFile={noop}
        onKeep={noop}
        onDelete={noop}
        onUseKept={noop}
        onDeleteKept={noop}
      />,
    );
    expect(html).toContain('Passage on page 2 was not indexed');
    expect(html).toContain('This passage could not be embedded, so it is not searched.');
    expect(html).toContain('data-reason="not_analysed"');
    expect(html).not.toContain('Score');
    expect(html).not.toContain('null');
    expect(html).not.toContain('held_low_score');
  });
  it('the Keep on this device opt-in shows the warning: unencrypted, readable by any page of the origin, and what is stored (S1-112 c)', () => {
    // the S1-reviewed first sentence stays word for word; S1-112 c adds what the stored record holds
    expect(
      KEEP_WARNING.startsWith(
        'Stored unencrypted in this browser profile; any page on airplanemode-labs.github.io can read it',
      ),
    ).toBe(true);
    for (const t of [
      'chunk text',
      'embeddings',
      'page numbers',
      'SHA-256',
      'confirm whether a known document was processed',
    ])
      expect(KEEP_WARNING, t).toContain(t);
    const off = renderToStaticMarkup(
      <DocumentCard
        doc={doc()}
        kept={[]}
        onFile={noop}
        onKeep={noop}
        onDelete={noop}
        onUseKept={noop}
        onDeleteKept={noop}
      />,
    );
    expect(off).not.toContain('Stored unencrypted');
    const on = renderToStaticMarkup(
      <DocumentCard
        doc={doc({ keep: true })}
        kept={[]}
        onFile={noop}
        onKeep={noop}
        onDelete={noop}
        onUseKept={noop}
        onDeleteKept={noop}
      />,
    );
    expect(on).toContain(KEEP_WARNING);
  });
  it('the file input accepts PDFs only and is disabled while a document is being processed', () => {
    const html = renderToStaticMarkup(
      <DocumentCard
        doc={doc({ status: 'working' })}
        kept={[]}
        onFile={noop}
        onKeep={noop}
        onDelete={noop}
        onUseKept={noop}
        onDeleteKept={noop}
      />,
    );
    expect(html).toContain('accept="application/pdf,.pdf"');
    expect(html).toMatch(
      /disabled=""[^>]*data-testid="file-input"|data-testid="file-input"[^>]*disabled/,
    );
  });
  it('lists kept documents with Use and Delete and no document name or id', () => {
    const html = renderToStaticMarkup(
      <DocumentCard
        doc={doc()}
        kept={[
          { docId: 'abcdef0123456789abcdef0123456789', ns: 'dockit.dabc', pages: 3, chunks: 5 },
        ]}
        onFile={noop}
        onKeep={noop}
        onDelete={noop}
        onUseKept={noop}
        onDeleteKept={noop}
      />,
    );
    expect(html).toContain('Saved document 1: 3 pages, 5 passages');
    expect(html).not.toContain('abcdef0123');
  });
  it('shows a refusal in the document card', () => {
    const html = renderToStaticMarkup(
      <DocumentCard
        doc={doc({ status: 'refused', refusal: refusalInfo(new Refusal('no_text_layer'))! })}
        kept={[]}
        onFile={noop}
        onKeep={noop}
        onDelete={noop}
        onUseKept={noop}
        onDeleteKept={noop}
      />,
    );
    expect(html).toContain('OCR is not yet supported');
  });
});
