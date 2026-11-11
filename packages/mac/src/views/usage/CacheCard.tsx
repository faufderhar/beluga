import type { AppState } from '@beluga/core/store.js';
import { type CacheHitRow, cacheHitRows } from '@beluga/ui/cache-usage.js';
import { Card } from './parts.js';
import s from './usage.module.css';

function Table({ title, rows }: { title: string; rows: readonly CacheHitRow[] }) {
  return (
    <div>
      <h3 className={s.cacheHeading}>{title}</h3>
      {rows.length ? (
        <table className={s.cacheTable}>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td className={s.cachePct}>{r.pct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className={s.quiet}>No cache measurements yet.</p>
      )}
    </div>
  );
}

/** Hit rate for each conversation, and the same counts grouped by the model that conversation uses now. */
export function CacheCard({ state }: { state: AppState }) {
  const agent = state.prefs.defaultAgent;
  const tables = cacheHitRows(state.projects, state.context, {
    runtime: agent?.runtime ?? 'claude',
    ...(agent?.model || (agent?.runtime ?? 'claude') === 'claude' ? { model: agent?.model ?? state.prefs.model } : {}),
    ...(state.prefs.projectAgents ? { projectAgents: state.prefs.projectAgents } : {}),
  });
  const empty = tables.sessions.length === 0 && tables.models.length === 0;
  return (
    <Card label="Cache hit rate" title="Cache">
      {empty ? (
        <p className={s.quiet} data-cache-usage="empty">
          No cache measurements yet.
        </p>
      ) : (
        <>
          <p className={s.quiet}>By session is this conversation. By model counts each conversation under the model it uses now.</p>
          <div className={s.cacheGrid} data-cache-usage="">
            <Table title="By session" rows={tables.sessions} />
            <Table title="By model" rows={tables.models} />
          </div>
        </>
      )}
    </Card>
  );
}
