import type { Graph, GraphNode } from '@beluga/shared/graph-spec.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Markdown } from '../../chat/Markdown.js';
import { useActions } from '../../lib/actions.js';
import { useApp } from '../../lib/beluga.js';
import { Icon } from '../Icon.js';
import { IconButton } from '../ui.js';
import { KIND_NAME, connections, linkGoal } from './graph-model.js';
import { KindIcon, StatusMark, StatusPill } from './marks.js';
import g from './graph.module.css';

/**
 * A node's details, beside the graph: what it is, Claude's notes on it (Markdown), its fields,
 * links (files open in Beluga, pages in the browser) and what it's connected to (click one to go
 * there).
 */

/** A node's link: opens the page or the file (relative paths are in the workspace on screen). */
function NodeLink({ label, href }: { label: string; href: string }) {
  const actions = useActions();
  const root = useApp((s) => (s.view.kind === 'workspace' ? findWorkspace(s.projects, s.view.id)?.path : undefined));
  const goal = linkGoal(href, root);
  if (goal.kind === 'none') {
    return (
      <span className={g.nodeLinkOff} title={`${href} (can’t open this here)`}>
        {label}
      </span>
    );
  }
  return (
    <button type="button" className={g.nodeLink} title={goal.kind === 'url' ? goal.url : goal.path} onClick={() => actions.openLink(goal)}>
      <Icon name={goal.kind === 'url' ? 'external' : goal.dir ? 'folder' : 'file'} size={12} />
      <span>{label}</span>
    </button>
  );
}

export function Inspector({ graph, node, onPick, onClose, wide, onOpen, openLabel }: { graph: Graph; node: GraphNode; onPick: (id: string) => void; onClose: () => void; wide: boolean; onOpen?: () => void; openLabel?: string }) {
  const links = node.links ?? [];
  const lines = connections(graph, node.id);
  return (
    <aside className={g.inspector} data-wide={wide ? 'true' : 'false'} aria-label={`About ${node.label}`}>
      <header className={g.inspectorHead}>
        <span className={`${g.kindIcon} ${g.kindIconLg}`} data-kind={node.type}>
          <KindIcon kind={node.type} size={16} />
        </span>
        <span className={g.titles}>
          <span className={g.inspectorTitle}>{node.label}</span>
          <span className={g.sublabel}>{[KIND_NAME[node.type], node.tag].filter(Boolean).join(' · ')}</span>
        </span>
        <IconButton size="small" icon="x" label="Close" onClick={onClose} />
      </header>
      <div className={g.inspectorBody}>
        {onOpen ? (
          <button type="button" className={g.inspectorOpen} onClick={onOpen}>
            {openLabel ?? 'Open'}
            <Icon name="arrowRight" size={12} />
          </button>
        ) : null}
        {node.sublabel ? <p className={g.inspectorLead}>{node.sublabel}</p> : null}
        {node.status || node.value ? (
          <div className={g.inspectorFacts}>
            {node.status ? <StatusPill status={node.status} /> : null}
            {node.value ? <span className={g.inspectorValue}>{node.value}</span> : null}
          </div>
        ) : null}
        {node.details ? (
          <div className={g.inspectorText}>
            <Markdown text={node.details} />
          </div>
        ) : null}
        {node.fields?.length ? (
          <section>
            <h4 className={g.inspectorSection}>Fields</h4>
            <ul className={g.fields}>
              {node.fields.map((f, i) => (
                <li key={`${i}:${f.name}`} className={g.fieldRow}>
                  <span className={g.fieldKey} data-key={f.key}>
                    {f.key === 'pk' ? 'PK' : f.key === 'fk' ? 'FK' : null}
                  </span>
                  <span className={g.fieldName}>{f.name}</span>
                  {f.type ? <span className={g.fieldType}>{f.type}</span> : null}
                  {f.note ? <span className={g.fieldNote}>{f.note}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {node.items?.length ? (
          <section>
            <h4 className={g.inspectorSection}>Steps</h4>
            <ol className={g.inspectorItems}>
              {node.items.map((it, i) => (
                <li key={`${i}:${it.label}`} className={g.item} data-status={it.status}>
                  {it.status ? <StatusMark status={it.status} /> : <span className={g.itemDot} aria-hidden="true" />}
                  <span className={g.itemLabel}>{it.label}</span>
                  {it.note ? <span className={g.itemNote}>{it.note}</span> : null}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {links.length ? (
          <section>
            <h4 className={g.inspectorSection}>Links</h4>
            <div className={g.nodeLinks}>
              {links.map((l, i) => (
                <NodeLink key={`${i}:${l.href}`} label={l.label} href={l.href} />
              ))}
            </div>
          </section>
        ) : null}
        {lines.length ? (
          <section>
            <h4 className={g.inspectorSection}>Connections</h4>
            <ul className={g.connections}>
              {lines.map((c) => (
                <li key={`${c.edge.id}:${c.other.id}`}>
                  <button type="button" className={g.connection} onClick={() => onPick(c.other.id)}>
                    <span className={`${g.kindIcon} ${g.kindIconSm}`} data-kind={c.other.type}>
                      <KindIcon kind={c.other.type} size={12} />
                    </span>
                    <span className={g.connectionText}>
                      <span className={g.connectionVerb}>{c.verb}</span>
                      <span className={g.connectionName}>{c.other.label}</span>
                    </span>
                    {c.edge.label ? <span className={g.connectionLabel}>{c.edge.label}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {!node.details && !node.fields?.length && !node.items?.length && !links.length && !lines.length && !node.sublabel ? <p className={g.inspectorEmpty}>Nothing more about this one.</p> : null}
      </div>
    </aside>
  );
}
