import type { MethodRow } from './method-tool.js';
import { GATED_ROWS } from './gated.js';
import { PEOPLE_ROWS } from './people.js';
import { PROJECT_ROWS } from './projects.js';
import { STATE_ROWS } from './state-rows.js';
import { WORK_ROWS } from './work.js';

export { type MethodRow, methodArgs, methodTools } from './method-tool.js';

/** Each tool that is one API method, by area. */
export const ALL_METHOD_ROWS: readonly MethodRow[] = [...WORK_ROWS, ...PROJECT_ROWS, ...STATE_ROWS, ...PEOPLE_ROWS, ...GATED_ROWS];
