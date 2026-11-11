import { z } from 'zod';

/**
 * How many people starred Beluga on GitHub, for the Star sheet ("be number 492"). One unauthenticated
 * request to GitHub's public API (nothing about you is sent), at most once a day; any failure just
 * means no number on the sheet. The window can't ask GitHub itself (its CSP allows only the daemon).
 */

export const BELUGA_REPO = 'beluga-labs/beluga';
const TIMEOUT_MS = 8_000;

const RepoSchema = z.object({ stargazers_count: z.number().int().min(0) });

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** The repo's star count, or undefined when GitHub can't be reached or says something unexpected. */
export async function fetchStars(repo: string = BELUGA_REPO, fetcher: Fetch = fetch): Promise<number | undefined> {
  try {
    const res = await fetcher(`https://api.github.com/repos/${repo}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Beluga' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const parsed = RepoSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.stargazers_count : undefined;
  } catch {
    return undefined;
  }
}
