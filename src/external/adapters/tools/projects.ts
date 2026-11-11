import type { MethodRow, Scope } from './method-tool.js';

/** Adding, showing and removing projects. A folder that is not a project yet has nothing for a grant to check, so these ask below full. */

const project: Scope = { on: 'project', arg: 'project' };
const none: Scope = { on: 'none' };

export const PROJECT_ROWS: readonly MethodRow[] = [
  { name: 'project_init_git', method: 'projects.initGit', params: ['path'], scope: none, description: 'Start a git repository in a folder.' },
  { name: 'project_add', method: 'projects.add', params: ['path'], scope: none, description: 'Add a git repository on this Mac as a project.' },
  { name: 'project_add_folder', method: 'projects.addFolder', params: ['path'], scope: none, description: 'Add a folder of repositories: each one in it becomes a project.' },
  { name: 'project_create', method: 'projects.create', params: ['name', 'parent'], scope: none, description: 'Start a new project: a folder, git and a first commit.' },
  { name: 'project_set_icon', method: 'projects.setIcon', params: ['project', 'image'], scope: project, description: 'Set a project\'s icon from an image file, or go back to the default.' },
  { name: 'workspace_add_project', method: 'workspaces.addProject', params: ['path'], scope: none, description: 'Add a project to the sidebar by its folder.' },
  { name: 'workspace_add_folder', method: 'workspaces.addFolder', params: ['path'], scope: none, description: 'Add a folder to the ones Beluga looks in for projects.' },
  { name: 'project_show', method: 'workspaces.showProject', params: ['path'], scope: none, description: 'Show a hidden project again, by its folder.' },
  { name: 'project_hide', method: 'workspaces.hideProject', params: ['project'], scope: project, description: 'Hide a project from the sidebar.' },
  { name: 'project_remove', method: 'workspaces.removeProject', params: ['project', 'options'], scope: project, description: 'Delete a project from Beluga. trash also moves its folder to the Trash. A person is asked each time.' },
];
