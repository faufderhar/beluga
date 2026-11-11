import type { AnchorHTMLAttributes } from 'react';
import { Icon, type IconName } from '../components/Icon.js';
import m from './mention.module.css';

/**
 * An image in the words: a small chip with its icon and name. The same chip in the message box
 * (over its reference, MentionHighlighter) and in a sent message (a link that opens the image).
 * A name too long for it loses its start, not its end ("…8.14.32@2x"): the end tells them apart.
 * `icon`: another thing pasted in the words the same way (a worktree's link: its branch, BLG-878).
 */
export function ImageChip({ label, className, href, icon = 'image', ...rest }: { label: string; className?: string | undefined; icon?: IconName } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const inside = (
    <>
      <Icon name={icon} size={11} />
      {/* Right to left only to put the cut at the start; the name itself stays left to right. */}
      <span className={m.chipName}>
        <bdi dir="ltr">{label}</bdi>
      </span>
    </>
  );
  const cls = `${m.chip}${className ? ` ${className}` : ''}`;
  return href ? (
    <a href={href} className={cls} data-image-chip="" {...rest}>
      {inside}
    </a>
  ) : (
    <span className={cls} data-image-chip="">
      {inside}
    </span>
  );
}
