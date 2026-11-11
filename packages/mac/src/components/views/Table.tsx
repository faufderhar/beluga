import { baseName, isAbsolutePath } from '@beluga/shared/os-path.js';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import type { Cell, Column, Row, View } from '@beluga/shared/view-spec.js';
import { Icon } from '../Icon.js';
import { cx } from '../ui.js';
import { useActions } from '../../lib/actions.js';
import { useBeluga } from '../../lib/beluga.js';
import { loadImage } from '../../chat/images.js';
import type { ViewData } from './use-view-data.js';
import { alignOf, formatCell, formatNumber, headingOf, isNumeric, parseColor, toneOf } from './format.js';
import v from './views.module.css';

/**
 * A view's rows as a table: headings sort (again: the other way; a third time: as they came),
 * the search finds rows across every column (at the source when it can), and pages step on
 * without Claude. Cells read by their column's type: numbers line up, statuses are badges, links
 * and paths open, colors show, images are thumbnails. A row opens to show all of itself.
 * `cell`: a table that knows more about some columns draws their cells itself (a sentinel's kept
 * rows: documents, progress bars, people); nothing back is the usual cell.
 */
export type DrawCell = (cell: Cell, col: Column, row: Row, full: boolean) => ReactNode | undefined;

export function DataTable({ view, data, full, cell }: { view: View; data: ViewData; full: boolean; cell?: DrawCell }) {
  const actions = useActions();
  const [open, setOpen] = useState<number>();
  const columns = data.columns.filter((c) => !c.hidden);
  useEffect(() => setOpen(undefined), [data.page, data.sort, data.search, data.rows]);
  const from = data.page * data.pageSize;
  const shown = data.rows.length;
  const total = data.total;
  const canSearch = view.search && (data.mode === 'live' || view.rows.length > 5);
  // A heading sorts (numbers and dates biggest first), then the other way, then as they came.
  const sortBy = (c: Column): void => {
    const first = isNumeric(c) || c.type === 'date' || c.type === 'datetime' ? 'desc' : 'asc';
    const now = data.sort?.key === c.key ? data.sort.dir : undefined;
    data.setSort(now === undefined ? { key: c.key, dir: first } : now === first ? { key: c.key, dir: first === 'asc' ? 'desc' : 'asc' } : undefined);
  };
  const openRow = (r: Row, i: number): void => {
    const target = view.link ? r[view.link] : undefined;
    if (typeof target === 'string' && target) {
      actions.openLink(/^https?:/i.test(target) ? { kind: 'url', url: target } : { kind: 'local', path: target, dir: target.endsWith('/') });
      return;
    }
    setOpen(open === i ? undefined : i);
  };
  return (
    <div className={cx(v.tableBox, full && v.tableFull)}>
      {canSearch ? (
        <div className={v.toolbar}>
          <label className={v.search}>
            <Icon name="search" size={12} />
            <input type="search" placeholder={data.mode === 'live' ? 'Search all rows' : 'Search'} value={data.search} onChange={(e) => data.setSearch(e.target.value)} aria-label="Search the rows" />
          </label>
          {data.sort ? (
            <button type="button" className={v.chipButton} onClick={() => data.setSort(undefined)}>
              Sorted by {headingOf(columns.find((c) => c.key === data.sort!.key) ?? { key: data.sort.key })} {data.sort.dir === 'asc' ? '↑' : '↓'}
              <Icon name="x" size={10} />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className={cx(v.scroll, data.loading && v.loadingRows)}>
        <table className={v.table} translate="no">
          <thead>
            <tr>
              {columns.map((c) => {
                const dir = data.sort?.key === c.key ? data.sort.dir : undefined;
                return (
                  <th key={c.key} style={{ textAlign: alignOf(c) }} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
                    <button type="button" className={cx(v.th, dir && v.thOn)} onClick={() => sortBy(c)}>
                      <span>{headingOf(c)}</span>
                      <span className={v.sortMark} data-dir={dir ?? 'none'} aria-hidden="true" />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <Fragment key={i}>
                <tr className={cx(v.tr, open === i && v.trOpen, view.link && v.trLink)} onClick={() => openRow(r, i)}>
                  {columns.map((c) => (
                    <td key={c.key} style={{ textAlign: alignOf(c) }} className={cx(isNumeric(c) && v.num)}>
                      {cell?.(r[c.key] ?? null, c, r, false) ?? <CellView cell={r[c.key] ?? null} col={c} local={data.mode !== 'snapshot'} />}
                    </td>
                  ))}
                </tr>
                {open === i ? (
                  <tr className={v.detailRow}>
                    <td colSpan={columns.length}>
                      <RowDetail row={r} columns={data.columns} local={data.mode !== 'snapshot'} {...(cell ? { cell } : {})} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!data.rows.length && !data.loading ? <div className={v.empty}>{data.search ? `Nothing matches “${data.search}”` : data.needsApproval ? 'Press Load to see the rows' : 'No rows'}</div> : null}
        {!data.rows.length && data.loading ? <div className={v.empty}>Loading…</div> : null}
      </div>
      {data.page > 0 || data.hasMore || (total !== undefined && total > shown) ? (
        <div className={v.pager}>
          <span className={v.count}>
            {shown ? `${formatNumber(from + 1)}–${formatNumber(from + shown)}` : '0'}
            {total !== undefined ? ` of ${formatNumber(total)}` : data.hasMore ? ' of many' : ''}
          </span>
          <span className={v.grow} />
          <button type="button" className={v.pageButton} disabled={data.page === 0 || data.loading} onClick={() => data.setPage(data.page - 1)} aria-label="Previous Page">
            <Icon name="back" size={11} />
          </button>
          <span className={v.pageNo}>
            Page {data.page + 1}
            {total !== undefined ? ` of ${Math.max(1, Math.ceil(total / data.pageSize))}` : ''}
          </span>
          <button type="button" className={v.pageButton} disabled={!data.hasMore || data.loading} onClick={() => data.setPage(data.page + 1)} aria-label="Next Page">
            <Icon name="forward" size={11} />
          </button>
        </div>
      ) : shown > 0 ? (
        <div className={v.pager}>
          <span className={v.count}>
            {formatNumber(shown)} {shown === 1 ? 'row' : 'rows'}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function RowDetail({ row, columns, local, cell }: { row: Row; columns: readonly Column[]; local: boolean; cell?: DrawCell }) {
  const keys = [...new Set([...columns.map((c) => c.key), ...Object.keys(row)])];
  const byKey = new Map(columns.map((c) => [c.key, c]));
  return (
    <dl className={v.detail} translate="no">
      {keys.map((k) => (
        <Fragment key={k}>
          <dt>{headingOf(byKey.get(k) ?? { key: k })}</dt>
          <dd>
            {cell?.(row[k] ?? null, byKey.get(k) ?? { key: k, type: 'text' }, row, true) ?? <CellView cell={row[k] ?? null} col={byKey.get(k) ?? { key: k, type: 'text' }} local={local} full />}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function CellView({ cell, col, local, full = false }: { cell: Cell; col: Column; local: boolean; full?: boolean }) {
  const actions = useActions();
  if (cell === null || cell === '') return <span className={v.nil}>—</span>;
  const text = formatCell(cell, col);
  switch (col.type) {
    case 'bool':
      return cell ? <Icon name="check" size={12} className={v.yes} /> : <span className={v.nil}>—</span>;
    case 'badge':
      return <span className={v.badge} data-tone={toneOf(String(cell))}>{text}</span>;
    case 'color': {
      const c = parseColor(String(cell));
      return (
        <span className={v.colorCell}>
          <span className={v.swatchDot} style={{ background: c ? String(cell) : 'transparent' }} />
          <code>{text}</code>
        </span>
      );
    }
    case 'url':
      return (
        <a
          href={String(cell)}
          className={v.link}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            actions.openLink({ kind: 'url', url: String(cell) });
          }}
          title={String(cell)}
        >
          {full ? String(cell) : String(cell).replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}
        </a>
      );
    case 'path':
      return (
        <a
          href={String(cell)}
          className={cx(v.link, v.mono)}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            actions.openLink({ kind: 'local', path: String(cell), dir: String(cell).endsWith('/') });
          }}
          title={String(cell)}
        >
          {full ? String(cell) : String(cell).replace(/^\/Users\/[^/]+/, '~')}
        </a>
      );
    case 'image':
      return <Thumb src={String(cell)} local={local} />;
    case 'code':
      return <code className={v.inlineCode}>{text}</code>;
    default:
      return full || text.length <= 120 ? <span className={cx(full && v.wrapText)}>{text}</span> : <span title={text}>{text.slice(0, 119)}…</span>;
  }
}

function Thumb({ src, local }: { src: string; local: boolean }) {
  const { client } = useBeluga();
  const web = /^https:\/\//i.test(src);
  const [url, setUrl] = useState<string | undefined>(web ? src : undefined);
  useEffect(() => {
    if (web || !local || !(isAbsolutePath(src) || /^~[\\/]/.test(src))) return;
    let alive = true;
    loadImage(client.api, { href: `local:${src}`, owner: '', file: '', local: src }, 'thumb').then(
      (u) => alive && setUrl(u),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [src, local]);
  return url ? <img className={v.thumb} src={url} alt="" loading="lazy" /> : <span className={cx(v.mono, v.nil)}>{baseName(src)}</span>;
}
