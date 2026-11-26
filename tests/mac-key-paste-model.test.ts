import { describe, expect, it } from 'vitest';

/** Through a variable: the root typecheck can't follow the Mac app's @beluga paths (its own tsc checks the file). */
const MODULE = '../packages/mac/src/chat/key-paste-model.js';
type Target = { readonly kind: string; readonly projectId?: string; readonly projectName?: string };
type Model = {
  targetOf: (channel: string, view: { readonly newChatProject?: { readonly id: string; readonly name: string; readonly root: string } }) => Target;
  scopeShort: (t: Target) => string;
};
const model = (): Promise<Model> => import(MODULE) as Promise<Model>;

// Where the key card keeps a pasted key (BLG-965), and the words it says for it.
describe('the key card’s place', () => {
  it('a new chat in a project: the project’s variables', async () => {
    const { targetOf, scopeShort } = await model();
    const t = targetOf('draft:p1', { newChatProject: { id: 'p1', name: 'app', root: '/code/app' } });
    expect(t).toEqual({ kind: 'project', projectId: 'p1', projectName: 'app' });
    expect(scopeShort(t)).toBe('Kept with app’s variables');
  });

  it('a new chat in Chats (no folder, so no project): your variables', async () => {
    const { targetOf, scopeShort } = await model();
    const t = targetOf('draft:chats', { newChatProject: { id: 'chats', name: 'Chats', root: '' } });
    expect(t).toEqual({ kind: 'yours' });
    expect(scopeShort(t)).toBe('Kept with your variables');
  });
});
