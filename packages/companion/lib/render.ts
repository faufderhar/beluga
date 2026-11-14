/**
 * What the phone draws Claude's views, graphs and inline elements with: the Mac app's own
 * parsers and models, imported from the repo (src/shared, browser-safe; Metro watches it), never
 * copied, so the two screens read a block the same way (BLG-68). Only the drawing is the phone's.
 */
export { type Cell, type Column, type Control, type Row, type Source, type Stat, type View, type ViewFetchResult, type ViewPage, type ViewQuery, columnsFor, pageOf, parseView, sourceKey, viewFenceType } from '../../../src/shared/view-spec';
export { type ControlState, columnChoices, initialState, resolveControls } from '../../../src/shared/view-controls';
export { type Graph, type GraphNode, parseGraph } from '../../../src/shared/graph-spec';
export { TASK_LINK_SCHEME, type TaskKeyPiece, linkTaskKeys, readTaskKeys, splitTaskKeys } from '../../../src/shared/task-refs';
export { codeWorktreeRefs } from '../../../src/shared/worktree-refs';
export { type ChartPlan, planChart } from '../../../src/shared/render/chart-model';
export { SERIES_DARK, SERIES_LIGHT, alignOf, contrast, formatCell, formatNumber, headingOf, inkOn, isNumeric, parseColor, toDate, toHex, toMarkdownTable, toneOf } from '../../../src/shared/render/format';
export { type InlineElement, readInline, relative } from '../../../src/shared/render/inline-model';
export { type ChatRef, chatChipOf, chatLinkOf, chatMentionsAsTitles, codeChatRefs, formatChatRef, parseChatRef } from '../../../src/shared/chat-ref';
export { tableView } from '../../../src/shared/render/md-table';
export { EDGE_VERB, type ElkInput, type ElkOutput, KIND_ICON, KIND_NAME, STATUS_INFO, backEdges, connections, elkGraph, inlineAspect, neighborhood, nodeBoxes, placeLabels, placesOf, roundedPath, routesOf, stepFocus } from '../../../src/shared/render/graph-model';
export { type FileTree, type TreeNode, readFileTree } from '../../../src/shared/render/file-tree';
export { type Json, type JsonDoc, jsonPreview, jsonSize, openDepth, readJson } from '../../../src/shared/render/json-tree';
export { type AnsiName, type Span, type TermLine, type Terminal, TERMINAL_FOLD, readTerminal } from '../../../src/shared/render/terminal';
export { type MathPiece, splitInlineMath } from '../../../src/shared/render/math';
export { type CalendarDay, type CalendarPlan, type GanttBar, type GanttPlan, type HeatPlan, along, barTone, planCalendar, planGantt, planHeatmap, scaleColor, scaleOf } from '../../../src/shared/render/grid-model';
export { stripCode } from '../../../src/companion/strip';
