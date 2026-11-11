import { describe, expect, it } from 'vitest';
import { BELUGA_REPO, fetchStars } from '../src/core/github-stars.js';
import { MergeCounter } from '../src/core/merge-counter.js';
import { Store, initialState } from '../src/core/store.js';

/** Beluga's star count for the Star sheet: one public GitHub request, failures mean no number. */
describe('fetchStars', () => {
  const reply = (ok: boolean, body: unknown) => async () => ({ ok, json: async () => body });

  it('reads stargazers_count from the repo', async () => {
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ stargazers_count: 491, name: 'beluga' }) };
    };
    expect(await fetchStars(BELUGA_REPO, fetcher)).toBe(491);
    expect(urls).toEqual(['https://api.github.com/repos/beluga-labs/beluga']);
  });

  it('gives nothing for an error, an odd answer or no network', async () => {
    expect(await fetchStars(BELUGA_REPO, reply(false, { message: 'rate limited' }))).toBeUndefined();
    expect(await fetchStars(BELUGA_REPO, reply(true, { stargazers_count: 'lots' }))).toBeUndefined();
    expect(await fetchStars(BELUGA_REPO, async () => Promise.reject(new Error('offline')))).toBeUndefined();
  });
});

describe('the star count in the support state', () => {
  it('shows once looked up, and stays when a later look fails', async () => {
    const store = new Store(initialState('test', 'ask'));
    const answers: Array<number | undefined> = [491, undefined];
    const counter = new MergeCounter({ store, file: null, stars: async () => answers.shift() });
    expect(store.getState().support.stars).toBeUndefined();
    await counter.refreshStars();
    expect(store.getState().support).toMatchObject({ merges: 0, stars: 491 });
    await counter.refreshStars();
    expect(store.getState().support.stars).toBe(491);
    counter.stop();
  });
});
