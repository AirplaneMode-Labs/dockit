import type { AppState } from '../app/controller.ts';
import { RefusalBox } from './RefusalBox.tsx';
import { mb } from './format.ts';

export const MODEL_LABEL = 'Qwen3-0.6B (answers) and multilingual-e5-small (search)';

/** The one-time model download, its progress, and the state of the model on this device. */
export function ModelCard({
  model,
  online,
  onDownload,
}: {
  model: AppState['model'];
  online: boolean;
  onDownload: () => void;
}) {
  const total =
    model.plannedBytes === undefined ? 'a few hundred' : mb(model.plannedBytes).replace(' MB', '');
  const busy = model.status === 'downloading' || model.status === 'loading';
  return (
    <section className="card" data-testid="model-card">
      <h2>Model</h2>
      <p data-testid="model-name">{MODEL_LABEL}. Runs in this browser; nothing is sent anywhere.</p>
      <p data-testid="model-status" data-status={model.status}>
        {model.status === 'cached' || model.status === 'ready'
          ? 'Downloaded and verified on this device.'
          : model.status === 'downloading'
            ? `Downloading: ${mb(model.receivedBytes)} of ${mb(model.totalBytes)}`
            : model.status === 'loading'
              ? model.reloading === true
                ? 'Loading the model again from this device...'
                : 'Loading the model from this device...'
              : model.status === 'unknown'
                ? 'Checking this device...'
                : model.status === 'refused'
                  ? 'The model could not be used.'
                  : 'Not downloaded on this device.'}
      </p>
      {model.status === 'downloading' ? (
        <progress
          max={Math.max(model.totalBytes, 1)}
          value={model.receivedBytes}
          data-testid="model-progress"
        />
      ) : null}
      {model.status === 'cached' ||
      model.status === 'ready' ||
      model.status === 'unknown' ? null : (
        <button
          type="button"
          onClick={onDownload}
          disabled={busy || !online}
          data-testid="download-model"
        >
          Download model (about {total} MB, once)
        </button>
      )}
      {!online && model.status !== 'cached' && model.status !== 'ready' ? (
        <p className="muted small" data-testid="model-offline">
          You are offline. Connect once to download the model.
        </p>
      ) : null}
      {model.refusal === undefined ? null : (
        <RefusalBox refusal={model.refusal} testId="model-refusal" />
      )}
    </section>
  );
}
