import type { MethodRow, Scope } from './method-tool.js';

/** The rest of the board, plans, sentinels and dashboards. A remove, a merge and a pass ask once at every level. */

const task: Scope = { on: 'task', arg: 'task' };
const plan: Scope = { on: 'plan', arg: 'plan' };
const sentinel: Scope = { on: 'sentinel', arg: 'sentinel' };
const dashboard: Scope = { on: 'dashboard', arg: 'dashboard' };
const board: Scope = { on: 'board', arg: 'board' };
const project: Scope = { on: 'project', arg: 'project' };
const someProject: Scope = { on: 'project_if_named', arg: 'project' };
const none: Scope = { on: 'none' };

export const STATE_ROWS: readonly MethodRow[] = [
  // ---- the board
  { name: 'task_set_private', method: 'board.setPrivate', params: ['task', 'private'], scope: task, description: 'Make a task private, or not.' },
  { name: 'task_move', method: 'board.move', params: ['task', 'status', 'place'], scope: task, description: 'Move a task to a status, before or after another.' },
  { name: 'task_restore_revision', method: 'board.restoreRevision', params: ['task', 'revision'], scope: task, description: 'Put a task\'s brief back to an earlier revision.' },
  { name: 'task_remove_proof', method: 'board.removeProof', params: ['task', 'proof'], scope: task, description: 'Take a proof off a task.' },
  { name: 'task_remove', method: 'board.remove', params: ['task'], scope: task, description: 'Delete a task. A person is asked each time.' },
  { name: 'task_set_agent', method: 'board.setAgent', params: ['task', 'agent'], scope: task, description: 'Choose who works a task when it starts.' },
  { name: 'task_archive', method: 'board.archive', params: ['task'], scope: task, description: 'Archive a task. A person is asked each time.' },
  { name: 'task_archive_done', method: 'board.archiveDone', params: ['project'], scope: someProject, description: 'Archive the tasks that are done, in a project or everywhere. A person is asked each time.' },
  { name: 'task_unarchive', method: 'board.unarchive', params: ['task'], scope: task, description: 'Bring back an archived task.' },
  { name: 'task_empty_archive', method: 'board.emptyArchive', params: ['project'], scope: someProject, description: 'Delete the archived tasks, in a project or everywhere. A person is asked each time.' },
  { name: 'task_settle_gone', method: 'board.settleGone', params: ['task', 'how'], scope: task, description: 'Settle a task whose worktree is gone.' },
  { name: 'board_set_auto_tasks', method: 'board.setAutoTasks', params: ['on'], scope: none, description: 'Turn automatic tasks on or off.' },
  { name: 'board_edit', method: 'board.editBoard', params: ['board', 'changes'], scope: board, description: 'Change a board\'s name or repos.' },
  { name: 'board_remove', method: 'board.removeBoard', params: ['board'], scope: board, description: 'Delete a board. A person is asked each time.' },
  { name: 'board_set_prefix', method: 'board.setPrefix', params: ['project', 'prefix'], scope: project, description: 'Set the key prefix of a project\'s tasks.' },
  { name: 'label_create', method: 'board.createLabel', params: ['project', 'label'], scope: project, description: 'Add a label to a project\'s board.' },
  { name: 'label_remove', method: 'board.removeLabel', params: ['project', 'name'], scope: project, description: 'Remove a label from a project\'s board. A person is asked each time.' },
  { name: 'board_set_context', method: 'board.setContext', params: ['project', 'context'], scope: project, description: 'Set what agents read about a project before they write tasks.' },
  { name: 'board_sync_disconnect', method: 'board.syncDisconnect', params: ['project'], scope: project, description: 'Stop syncing a project\'s board with its tracker. A person is asked each time.' },
  { name: 'board_sync_now', method: 'board.syncNow', params: ['project'], scope: someProject, description: 'Sync a board with its tracker now.' },
  { name: 'board_sync_auto', method: 'board.syncAuto', params: ['project', 'on'], scope: project, description: 'Turn automatic sync on or off.' },
  // ---- plans
  { name: 'plan_here', method: 'plans.here', params: ['channel', 'autonomy'], scope: { on: 'channel', arg: 'channel' }, writes: true, description: 'Plan in this chat.' },
  { name: 'plan_discard', method: 'plans.discard', params: ['plan'], scope: plan, description: 'Throw a plan\'s draft away. A person is asked each time.' },
  { name: 'plan_set_autonomy', method: 'plans.setAutonomy', params: ['plan', 'autonomy', 'milestone'], scope: plan, description: 'Set the autonomy of a plan, or of one milestone.' },
  { name: 'plan_set_paused', method: 'plans.setPaused', params: ['plan', 'paused'], scope: { on: 'plan_pause_only', arg: 'plan', paused: 'paused' }, description: 'Pause a plan. Only a person resumes one: paused false is refused.' },
  { name: 'plan_set_parallel', method: 'plans.setParallel', params: ['plan', 'count'], scope: plan, description: 'How many of a plan\'s tasks run at once.' },
  { name: 'plan_set_tests_at', method: 'plans.setTestsAt', params: ['plan', 'when'], scope: plan, description: 'When a plan\'s long test suites run.' },
  { name: 'plan_set_work_agent', method: 'plans.setWorkAgent', params: ['plan', 'agent'], scope: plan, description: 'Who works a plan from here on.' },
  { name: 'plan_tidy_up', method: 'plans.tidyUp', params: ['plan', 'on'], scope: plan, description: 'Turn a plan\'s tidying up on or off.' },
  { name: 'plan_pass', method: 'plans.pass', params: ['plan', 'milestone'], scope: { on: 'plan_not_its_own', arg: 'plan' }, description: 'Pass a milestone, so the next one opens. A person is asked each time. Refused on a plan that this agent changed: a checker stays separate.' },
  { name: 'plan_recheck', method: 'plans.recheck', params: ['plan', 'milestone'], scope: plan, description: 'Ask the plan\'s agent to check a milestone again.' },
  { name: 'plan_fix_review', method: 'plans.fixReview', params: ['plan'], scope: plan, description: 'Send what the review of a plan\'s draft found to the plan\'s agent, to fix.' },
  { name: 'plan_send_back', method: 'plans.sendBack', params: ['plan', 'milestone', 'why'], scope: plan, description: 'Send a milestone back, with what is missing.' },
  { name: 'plan_open_pr', method: 'plans.openPr', params: ['plan'], scope: plan, description: 'Open a plan\'s pull request. A person is asked each time.' },
  { name: 'plan_merge_pr', method: 'plans.mergePr', params: ['plan', 'options'], scope: plan, description: 'Merge a plan\'s pull request. A person is asked each time.' },
  { name: 'plan_merge_local', method: 'plans.mergeLocal', params: ['plan'], scope: plan, description: 'Merge a plan\'s branch into main here. A person is asked each time.' },
  { name: 'plan_bring_in_main', method: 'plans.bringInMain', params: ['plan'], scope: plan, description: 'Merge main into a plan\'s branch.' },
  { name: 'plan_retry_conflicts', method: 'plans.retryConflicts', params: ['plan'], scope: plan, description: 'Ask the plan\'s agent again to fix a conflict.' },
  { name: 'plan_resume_task', method: 'plans.resumeTask', params: ['plan', 'task'], scope: plan, description: 'Wake a started task whose agent stopped without finishing.' },
  { name: 'plan_remove', method: 'plans.remove', params: ['plan'], scope: plan, description: 'Delete a plan. A person is asked each time.' },
  { name: 'plan_set_style', method: 'plans.setStyle', params: ['style'], scope: none, description: 'Set how you like plans cut.' },
  // ---- sentinels
  { name: 'sentinel_duplicate', method: 'sentinel.duplicate', params: ['sentinel'], scope: sentinel, description: 'Copy a sentinel. The copy starts paused.' },
  { name: 'sentinel_run_delete', method: 'sentinel.runDelete', params: ['run', 'what'], scope: none, description: 'Delete one run of a sentinel, or only its chat. A person is asked each time.' },
  { name: 'sentinel_stop_run', method: 'sentinel.stop', params: ['run'], scope: none, description: 'Stop a sentinel\'s run.' },
  { name: 'sentinel_runs', method: 'sentinel.runs', params: ['sentinel'], scope: sentinel, description: 'A sentinel\'s last runs, newest first.' },
  { name: 'sentinel_run_get', method: 'sentinel.runGet', params: ['run'], scope: none, description: 'One run: its steps\' outputs and its report.' },
  { name: 'sentinel_ask', method: 'sentinel.ask', params: ['sentinel', 'words'], scope: sentinel, description: 'Your agent changes a sentinel from your words.' },
  { name: 'sentinel_recipes', method: 'sentinel.recipes', params: [], scope: { on: 'nothing_private' }, description: 'The ready-made sentinels Beluga offers.' },
  { name: 'sentinel_document', method: 'sentinel.document', params: ['sentinel', 'metric', 'column', 'cell'], scope: sentinel, description: 'A document that a sentinel keeps in a column.' },
  { name: 'sentinel_storage_document', method: 'sentinel.storageDocument', params: ['sentinel', 'metric', 'column', 'cell'], scope: sentinel, description: 'A stored object that a sentinel\'s column names.' },
  { name: 'sentinel_data', method: 'sentinel.dataList', params: ['sentinel'], scope: sentinel, description: 'What a sentinel keeps: its metrics and its runs\' files.' },
  { name: 'sentinel_run_file', method: 'sentinel.runFile', params: ['run', 'name'], scope: none, description: 'A run\'s file, with secrets redacted.' },
  { name: 'sentinel_data_export', method: 'sentinel.dataExport', params: ['sentinel', 'what'], scope: sentinel, description: 'Write a metric\'s history or a run\'s files to the Downloads folder.' },
  { name: 'sentinel_run_row', method: 'sentinel.runRow', params: ['sentinel', 'metric', 'column', 'row'], scope: sentinel, description: 'Run the sentinel that an action column names, with this row.' },
  { name: 'sentinel_chat_new', method: 'sentinel.chatNew', params: [], scope: none, description: 'Start a new Sentinel chat.' },
  { name: 'sentinel_chat_open', method: 'sentinel.chatOpen', params: ['chat'], scope: none, description: 'Make one Sentinel chat the open one.' },
  { name: 'sentinel_chat_clear', method: 'sentinel.chatClear', params: ['chat'], scope: none, description: 'Clear a Sentinel chat. A person is asked each time.' },
  { name: 'sentinel_chat_delete', method: 'sentinel.chatDelete', params: ['chat'], scope: none, description: 'Delete a Sentinel chat. A person is asked each time.' },
  // ---- dashboards
  { name: 'dashboard_refresh', method: 'dashboard.refresh', params: ['dashboard'], scope: dashboard, description: 'Run each sentinel a dashboard draws from.' },
  { name: 'dashboard_ask', method: 'dashboard.ask', params: ['dashboard', 'words'], scope: dashboard, description: 'Your agent builds a dashboard from your words.' },
];
