import type { IconName } from '../components/Icon.js';
import { Button, Empty, EmptyActions } from '../components/ui.js';
import { useActions } from '../lib/actions.js';

/** A Work page before any project is added: what it needs, and the button that adds one (the sidebar's own "Add a project…"). */
export function NoProjects({ icon, detail }: { icon: IconName; detail: string }) {
  const actions = useActions();
  return (
    <Empty
      icon={icon}
      title="No projects yet"
      detail={detail}
      action={
        <EmptyActions>
          <Button size="large" variant="primary" icon="plus" onClick={() => actions.run({ type: 'add_project' })}>
            Add a Project…
          </Button>
        </EmptyActions>
      }
    />
  );
}
