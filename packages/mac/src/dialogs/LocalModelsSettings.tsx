import { useEffect, useState } from 'react';
import { type EndpointView, OLLAMA_URL, modelsOfEndpoint } from '@beluga/shared/local-endpoints.js';
import { Button, Dot } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import { Group, Row } from './settings-controls.js';
import s from './settings.module.css';
import { thisComputer } from '../lib/os-words.js';

interface Draft {
  readonly id?: string;
  readonly label: string;
  readonly baseUrl: string;
  /** Typed here; empty keeps the saved one. */
  readonly key: string;
  readonly clearKey: boolean;
  readonly models: string;
  readonly hasKey: boolean;
}

const blank: Draft = { label: 'Ollama', baseUrl: OLLAMA_URL, key: '', clearKey: false, models: '', hasKey: false };
const errorText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Bad arguments for [\w.]+: /, '') : String(err));

function statusOf(e: EndpointView): { tone: 'ok' | 'warn' | 'error' | 'muted'; words: string } {
  if (e.reachable === undefined) return { tone: 'muted', words: 'Not looked at yet' };
  if (!e.reachable) return { tone: 'error', words: e.builtIn ? `Not running on ${thisComputer()}` : 'Not answering' };
  const models = modelsOfEndpoint(e);
  return models.length ? { tone: 'ok', words: `${models.length} model${models.length === 1 ? '' : 's'}: ${models.slice(0, 3).join(', ')}${models.length > 3 ? '…' : ''}` } : { tone: 'warn', words: 'Answering, no models yet' };
}

/**
 * Settings › Claude › Local models (BLG-449): Anthropic-compatible endpoints your agent can run on
 * instead of Anthropic. Ollama first: running on this Mac, it shows up by itself. Each endpoint is
 * kept on this Mac with your other secrets; its key is never shown again, only whether it has one.
 */
export function LocalModelsSettings() {
  const api = useApi();
  const [list, setList] = useState<readonly EndpointView[] | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.env.checkEndpoints().then(setList, () => setList([]));
  }, [api]);

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await work();
      setList(await api.env.endpoints());
      setDraft(undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (d: Draft): Promise<void> =>
    run(() =>
      api.env.saveEndpoint({
        ...(d.id ? { id: d.id } : {}),
        label: d.label,
        baseUrl: d.baseUrl,
        ...(d.key ? { key: d.key } : d.clearKey ? { key: '' } : {}),
        models: d.models.split(/[,\n]/).map((m) => m.trim()).filter(Boolean),
      }),
    );

  const edit = (e: EndpointView): void => {
    setError('');
    setDraft({ ...(e.builtIn ? {} : { id: e.id }), label: e.label, baseUrl: e.baseUrl, key: '', clearKey: false, models: e.models.join(', '), hasKey: e.hasKey });
  };

  const form = draft ? (
    <form
      className={s.endpointForm}
      onSubmit={(ev) => {
        ev.preventDefault();
        void save(draft);
      }}
    >
      <label className={s.endpointField}>
        <span>Name</span>
        <input className={s.text} aria-label="Name" value={draft.label} onChange={(ev) => setDraft({ ...draft, label: ev.target.value })} autoFocus />
      </label>
      <label className={s.endpointField}>
        <span>Address</span>
        <input className={s.text} aria-label="Address" value={draft.baseUrl} spellCheck={false} placeholder={OLLAMA_URL} onChange={(ev) => setDraft({ ...draft, baseUrl: ev.target.value })} />
      </label>
      <label className={s.endpointField}>
        <span>Key</span>
        <input
          className={s.text}
          aria-label="Key"
          type="password"
          autoComplete="off"
          value={draft.key}
          placeholder={draft.hasKey && !draft.clearKey ? 'Saved (type to replace)' : 'None (Ollama needs none)'}
          onChange={(ev) => setDraft({ ...draft, key: ev.target.value })}
        />
        {draft.hasKey && !draft.key ? (
          <Button size="small" variant="quiet" onClick={() => setDraft({ ...draft, clearKey: !draft.clearKey })}>
            {draft.clearKey ? 'Keep Key' : 'Remove Key'}
          </Button>
        ) : null}
      </label>
      <label className={s.endpointField}>
        <span>Models</span>
        <input className={s.text} aria-label="Models" value={draft.models} spellCheck={false} placeholder="Empty: the ones it lists" onChange={(ev) => setDraft({ ...draft, models: ev.target.value })} />
      </label>
      {error ? <div className={s.endpointError}>{error}</div> : null}
      <div className={s.endpointBar}>
        <Button size="small" variant="quiet" onClick={() => setDraft(undefined)}>
          Cancel
        </Button>
        <Button size="small" variant="primary" type="submit" disabled={busy || !draft.label.trim() || !draft.baseUrl.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  ) : null;

  return (
    <Group title="Local models">
      <Row label="Run on your own models" detail={`Ollama on ${thisComputer()}, or any Anthropic-compatible address (LiteLLM, a company proxy). Same tools and features; how good the answers are depends on the model. Pick Local model in the agent box you type in.`}>
        <Button variant="quiet" icon="refresh" disabled={busy} onClick={() => void run(() => api.env.checkEndpoints())}>
          Check Again
        </Button>
        <Button
          icon="plus"
          disabled={busy}
          onClick={() => {
            setError('');
            setDraft(list?.some((e) => !e.builtIn && e.baseUrl === OLLAMA_URL) ? { ...blank, label: '', baseUrl: '' } : blank);
          }}
        >
          Add Endpoint
        </Button>
      </Row>
      {draft && !draft.id ? form : null}
      {list === undefined ? (
        <div className={s.note}>Looking…</div>
      ) : (
        list.map((e) => {
          const status = statusOf(e);
          if (draft?.id === e.id && !e.builtIn) return <div key={e.id}>{form}</div>;
          return (
            <Row key={e.id} label={e.builtIn ? `Ollama on ${thisComputer()}` : e.label} detail={e.builtIn && !e.reachable ? 'Install it from ollama.com, start it with OLLAMA_CONTEXT_LENGTH=32768 ollama serve, and pull a model (ollama pull qwen3-coder).' : `${e.baseUrl}${e.hasKey ? ' · key saved' : ''} · ${status.words}`}>
              <Dot tone={status.tone} />
              <Button size="small" variant="quiet" disabled={busy} onClick={() => edit(e)}>
                {e.builtIn ? 'Set Up…' : 'Edit…'}
              </Button>
              {e.builtIn ? null : (
                <Button size="small" variant="quiet" disabled={busy} onClick={() => void run(() => api.env.removeEndpoint(e.id))}>
                  Remove
                </Button>
              )}
            </Row>
          );
        })
      )}
      {error && !draft ? <div className={s.endpointError}>{error}</div> : null}
    </Group>
  );
}
