import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { PluggableList } from 'unified';
import { remarkAlerts } from './md-alerts.js';
import { DOC_SCHEMA } from './md-schema.js';

/**
 * How the reader turns Markdown into HTML: GitHub-flavored Markdown with math and alerts, the
 * document's own HTML parsed and then cut down to what GitHub allows, and ids on the headings.
 * The order matters: ids are added after sanitizing (so they're the reader's, not the document's).
 */
export const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkMath, remarkAlerts];
export const REHYPE_PLUGINS: PluggableList = [rehypeRaw, [rehypeSanitize, DOC_SCHEMA], rehypeSlug];
/** GitHub's own words in the app (an issue, a PR comment): their HTML read and cut down as GitHub does. */
export const GITHUB_REHYPE: PluggableList = [rehypeRaw, [rehypeSanitize, DOC_SCHEMA]];
/** Ids from the document get one `user-content-` prefix, from the sanitizer (footnotes included). */
export const TO_HTML = { clobberPrefix: '' } as const;
