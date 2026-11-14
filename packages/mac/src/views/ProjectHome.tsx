import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PullRequest } from "@beluga/core/work-store.js";
import { describePr } from "@beluga/shared/format.js";
import { isPlanOwned } from "@beluga/core/plans/owner.js";
import { activityOf, stateOf } from "@beluga/ui/workspace-models.js";
import type { Project, Workspace } from "@beluga/workspaces/types.js";
import {
  AUTONOMIES,
  AUTONOMY_INFO,
  type Autonomy,
  DEFAULT_AUTONOMY,
  type Plan,
} from "@beluga/core/plans/model.js";
import { EarningsPill } from "../components/EarningsPill.js";
import { Icon } from "../components/Icon.js";
import { ProjectIcon } from "../components/ProjectIcon.js";
import { Select } from "../components/Select.js";
import { Button, Dot, Empty, IconButton, Segmented, Tip, cx } from "../components/ui.js";
import { useActions } from "../lib/actions.js";
import { toast, useApi, useApp, useBeluga } from "../lib/beluga.js";
import { makeAhead } from "../lib/make-ahead.js";
import { useMyAgentName } from "../lib/agent-words.js";
import { RunsOnPicker } from "../chat/RunsOn.js";
import { type WorkToStart, sendToComputer, useStartDeps } from "../machines/start-there.js";
import { ModelPicker, myRuntime } from "../chat/ModelPicker.js";
import { useStartWith } from "../components/agent-options.js";
import { SplitButton } from "../components/SplitButton.js";
import type { AgentRef } from "@beluga/protocol.js";
import { sameDeep } from "../lib/stable.js";
import { getPrefs, usePrefs } from "../lib/prefs.js";
import { sendsToTerminal } from "../lib/convo-mode.js";
import { chordLabel } from "../lib/shortcuts-model.js";
import {
  type OverviewFilter,
  readOverviewPrefs,
} from "./overview/overview-model.js";
import {
  type HomeModel,
  agoText,
  homeModel,
  homeTasks,
  lastActive,
} from "./project/home-model.js";
import { type Issue, STATUS_INFO } from "@beluga/core/board/model.js";
import { StatusIcon } from "../tasks/marks.js";
import { useTaskActions } from "../tasks/use-tasks.js";
import { branchOptions } from "../chat/WorktreeDraft.js";
import { useBoxSuggestions } from "../chat/BoxSuggestions.js";
import { useAttachments } from "../chat/use-attachments.js";
import { MentionHighlighter } from "../chat/MentionHighlighter.js";
import { DictationStrip, MicButton } from "../chat/Dictation.js";
import { useDictationTarget } from "../lib/dictation.js";
import { HomeHistory } from "./history/HomeHistory.js";
import { EarningsSection } from "./project/EarningsSection.js";
import { GitHubRow } from "./project/GitHubRow.js";
import { GitHubMark } from "../components/GitHubMark.js";
import { PullRow, usePullList } from "./project/PullRow.js";
import { RunRow } from "../ci/parts.js";
import { useArrivals, useLateArrival } from "../lib/last-seen.js";
import { useCiActions, useNow, useRuns } from "../ci/use-ci.js";
import { isLive, sortRuns } from "@beluga/core/ci/model.js";
import { IssueRow } from "../issues/parts.js";
import { useIssueActions, useIssueList } from "../issues/use-issues.js";
import { MainSyncBar } from "./project/MainSyncBar.js";
import { EnvPill } from "./project/EnvAsks.js";
import { EnvSection } from "./project/EnvSection.js";
import { Section } from "./project/HomeSection.js";
import { outsideOf } from "../layout/outside-model.js";
import { openSheet } from "../lib/sheets.js";
import { TonePill } from "../plans/marks.js";
import { planStatus, plansOf, titleOf } from "../plans/plans-model.js";
import { usePlanActions, usePlanView, usePlans } from "../plans/use-plans.js";
import c from "../chat/composer.module.css";
import d from "../chat/draft.module.css";
import s from "./project-home.module.css";
import a from "../lib/arrive.module.css";
import { TeamOffers } from "../team/Team.js";

/**
 * A project's home: what you see when you click a project. Its main folder is never worked in,
 * so the big box starts work in a new worktree (or just asks a question about the project, or
 * plans big work with Claude), and below are its plans, worktrees, the questions asked in main,
 * the latest of its tasks and GitHub issues (each with the way to all of them), what was put away,
 * and (with Stripe connected) a folded row of how it's earning.
 */
export function ProjectHome({ id }: { id: string }) {
  const project = useApp((st) =>
    st.projects.find((p) => p.id === id && p.root),
  );
  const log = useApp((st) => st.log);
  const conflicts = useApp((st) => st.conflicts);
  const prs = useApp((st) => st.prs);
  const plansState = useApp((st) => st.plans);
  const board = useApp((st) => st.board);
  if (!project)
    return (
      <Empty
        icon="folder"
        title="This project isn’t here anymore"
        detail="It may have been hidden or moved. Pick another one in the sidebar."
      />
    );
  // A plan is one row: its conversation and its tasks' worktrees aren't counted or listed on their own.
  const model = homeModel(
    { log, conflicts, prs },
    {
      ...project,
      workspaces: project.workspaces.filter(
        (w) => !isPlanOwned({ plans: plansState, board }, w.id),
      ),
    },
  );
  return (
    <div className={s.page} aria-label={`${project.name} home`}>
      <div className={s.column}>
        <Header model={model} />
        <TeamOffers projectId={project.id} />
        <HomeComposer project={project} />
        <Lists model={model} />
      </div>
    </div>
  );
}

const OVERVIEW_KEY = "beluga.overview.v1";

/** Open the Overview narrowed to one project and segment (Archived, Ready to Merge…). */
function useOpenOverview(): (
  projectId: string,
  filter: OverviewFilter,
) => void {
  const actions = useActions();
  return (projectId, filter) => {
    try {
      const current = readOverviewPrefs(localStorage.getItem(OVERVIEW_KEY));
      localStorage.setItem(
        OVERVIEW_KEY,
        JSON.stringify({ ...current, filter, project: projectId }),
      );
    } catch {
      // No storage: the Overview opens as you left it.
    }
    actions.run({ type: "view", view: { kind: "overview" } });
  };
}

function Header({ model }: { model: HomeModel }) {
  const { project, main, mainLine, stats } = model;
  const overview = useOpenOverview();
  // The default branch (main or master), even when the main folder has another one checked out.
  const branch = mainLine.branch ?? main?.status?.branch ?? main?.branch;
  return (
    <header className={s.header}>
      <ProjectIcon id={project.id} name={project.name} size={44} />
      <div className={s.heading}>
        <h1 className={s.name}>{project.name}</h1>
        <div className={s.meta}>
          {branch ? (
            <span className={s.branch}>
              <Icon name="branch" size={11} />
              {branch}
            </span>
          ) : null}
          <Tip label="Compared with what was last fetched from the remote">
            <span className={cx(s.sync, s[`tone_${mainLine.tone}`])}>
              <Dot tone={mainLine.tone === "muted" ? "muted" : mainLine.tone} />
              {mainLine.label}
            </span>
          </Tip>
          {mainLine.dirty ? (
            <span className={cx(s.sync, s.tone_warn)}>{mainLine.dirty}</span>
          ) : null}
        </div>
        <MainSyncBar project={project} line={mainLine} />
        <div className={s.stats} role="group" aria-label="At a glance">
          <span className={s.stat}>
            <strong>{stats.active}</strong> active
          </span>
          <button
            type="button"
            className={s.stat}
            disabled={!stats.ready}
            onClick={() => overview(project.id, "ready")}
          >
            <strong>{stats.ready}</strong> ready to merge
          </button>
          <button
            type="button"
            className={s.stat}
            disabled={!stats.archived}
            onClick={() => overview(project.id, "archived")}
          >
            <strong>{stats.archived}</strong> archived
          </button>
          <EarningsPill key={project.id} root={project.root} projectId={project.id} />
          {project.root ? <EnvPill projectId={project.id} root={project.root} /> : null}
          <GitHubRow projectId={project.id} />
        </div>
      </div>
      {/* Its settings (General, Environment, Worktrees), in one sheet (BLG-926). */}
      {project.root ? (
        <IconButton
          icon="gear"
          label="Project Settings…"
          className={s.settingsButton}
          onClick={() => openSheet({ kind: "project_env", projectId: project.id, tab: "general" })}
        />
      ) : null}
    </header>
  );
}

type Mode = "worktree" | "ask" | "plan";

/** The branches a new worktree can start from (the default first). */
function useBranches(
  projectId: string,
): { base: string; branches: readonly string[] } | undefined {
  const api = useApi();
  const [branches, setBranches] = useState<{
    base: string;
    branches: readonly string[];
  }>();
  useEffect(() => {
    let alive = true;
    setBranches(undefined);
    api.workspaces.branches(projectId).then(
      (b) => alive && b && setBranches(b),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [projectId]);
  return branches;
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * "What do you want to do in <project>?": New Worktree (the default: Return makes a worktree
 * from the latest origin, named after the task, and Claude starts there), Just Ask (a
 * questions-only chat in the main folder) or New Plan (the text is the goal: the plan's chat
 * opens and Claude starts planning; with no text, the New Plan sheet).
 */
function HomeComposer({ project }: { project: Project }) {
  const agent = useMyAgentName();
  const api = useApi();
  const actions = useActions();
  const { client } = useBeluga();
  const prefs = usePrefs();
  const [mode, setMode] = useState<Mode>("worktree");
  const [text, setText] = useState("");
  const [base, setBase] = useState<string>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [autonomy, setAutonomy] = useState<Autonomy>(DEFAULT_AUTONOMY);
  const plans = usePlanActions();
  const plansOn = usePlans().enabled;
  const branches = useBranches(project.id);
  const ref = useRef<HTMLTextAreaElement>(null);
  const words = useRef(text);
  words.current = text;
  // Pasted and dropped images wait as thumbnails with an "[image N]" in the words, as in every message box.
  const att = useAttachments({
    channel: `home:${project.id}`,
    box: ref,
    text: () => words.current,
    setText: (next, cursor) => {
      words.current = next;
      setText(next);
      requestAnimationFrame(() =>
        ref.current?.setSelectionRange(cursor, cursor),
      );
    },
  });
  useEffect(() => {
    setText("");
    setName("");
    setBase(undefined);
    setMode("worktree");
    setAutonomy(DEFAULT_AUTONOMY);
    ref.current?.focus();
  }, [project.id]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 60), 10 * 20 + 20)}px`;
  }, [text]);
  const worktree = mode === "worktree";
  const plan = mode === "plan";
  const task = text.trim();
  // A plan with no goal yet opens the sheet, so the button is always ready.
  const ready = worktree
    ? Boolean(task || name.trim() || att.images.length)
    : plan || Boolean(task || att.images.length);
  const chosen = base ?? branches?.base ?? project.base;
  const options = branches?.branches.length
    ? branches.branches
    : chosen
      ? [chosen]
      : [];
  const sendKeys = prefs.sendWith === "enter" ? "↩" : chordLabel('Cmd+Enter');
  // "@src/…" offers the main folder's files (the new worktree starts with the same ones), "/" the commands.
  const mainId = project.workspaces.find((w) => w.kind === "main")?.id;
  const box = useBoxSuggestions({ text, setText, filesOf: mainId });
  // Create Worktree's ▾ (BLG-506): the same worktree, worked by another agent.
  const startWith = useStartWith();
  const startDeps = useStartDeps();

  /** `agent`: who works the new worktree (Start with…); none: your default. */
  const send = async (agent?: AgentRef): Promise<void> => {
    if (task.startsWith("/")) {
      setText("");
      actions.submit(task);
      return;
    }
    if (!ready || busy) {
      if (!ready)
        toast(
          client,
          worktree
            ? "Describe the task, or give the worktree a name"
            : "Type your question first",
          "info",
        );
      return;
    }
    if (plan && !task && !att.images.length) {
      openSheet({ kind: "new_plan", projectId: project.id });
      return;
    }
    // Images go where their "[image N]" is (as links to them); they come back to the box if it fails.
    const { text: typed, images, shown, putBack } = att.take(task);
    let message = typed;
    if (images.length) {
      try {
        message = await api.attachments.expand(
          typed,
          `home:${project.id}`,
          [...(await att.saved(images))],
          [...shown],
        );
      } catch (err) {
        putBack();
        toast(client, `Couldn’t send the images: ${errorText(err)}`, "error");
        return;
      }
    }
    // Runs on one of your computers (BLG-788): the plan, worktree or chat is made there and opens at once.
    const named = name.trim();
    const there: WorkToStart = plan
      ? { kind: "plan", input: { goal: message, autonomy } }
      : worktree
        ? { kind: "worktree", text: message, opts: { ...(base ? { base } : {}), ...(named ? { name: named } : {}), ...(agent ? { agent } : {}) } }
        : { kind: "chat", text: message };
    const sent = sendToComputer(startDeps, project.id, agent?.runtime ?? myRuntime(client.store.getState().prefs), there);
    // Held (the computer Runs on names can't take it now): nothing starts, the words stay.
    if (sent === "held") return putBack();
    if (sent === "sent") {
      setText("");
      setName("");
      return;
    }
    if (plan) {
      // The plan's page and chat open on their own; Claude starts planning from the text.
      setBusy(true);
      const made = await plans.act(() =>
        plans.api.create({ projectId: project.id, goal: message, autonomy }),
      );
      setBusy(false);
      if (made) setText("");
      else putBack();
      return;
    }
    if (worktree) {
      // The worktree is made in the background, its row and "Making…" page there at once (BLG-942): you can go on right away.
      setText("");
      setName("");
      const ahead = makeAhead(client, project.id, named || message || "worktree", { ...(base ? { base } : {}), asked: message });
      void api.workspaces
        .startWorktree(project.id, message, {
          ...(base ? { base } : {}),
          ...(named ? { name: named } : {}),
          ...(agent ? { agent } : {}),
          // Seen as its terminal (Settings › Terminal): the terminal opens on this message (BLG-553).
          ...(message.trim() && sendsToTerminal(client.store.getState(), getPrefs(), "draft", agent?.runtime) ? { terminal: true } : {}),
          ...(ahead ? { id: ahead.id } : {}),
        })
        .catch((err: unknown) => {
          ahead?.drop();
          toast(
            client,
            `Couldn’t create the worktree: ${errorText(err)}`,
            "error",
          );
        });
      return;
    }
    setBusy(true);
    try {
      await api.workspaces.startChat(project.id, message);
      setText("");
      setName("");
    } catch (err) {
      putBack();
      toast(client, `Couldn’t start the chat: ${errorText(err)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  // Speaking instead of typing (Settings › Voice), as in every chat's box.
  useDictationTarget(ref, () => void send(), `new-chat:${project.id}`);
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (box.onKey(e)) return;
    if (att.onRefKey(e)) return;
    if (e.key !== "Enter") return;
    const modKey = e.metaKey || e.ctrlKey;
    const sends = prefs.sendWith === "enter" ? !e.shiftKey && !modKey : modKey;
    if (!sends) return;
    e.preventDefault();
    void send();
  };

  // The send button (Create Worktree, Plan with…, Ask).
  const createButton = (
    <Tip
      label={
        worktree
          ? "Make the branch and folder, then your agent starts on the task"
          : plan
            ? task
              ? "Your agent reads the code and drafts milestones and tasks with you"
              : "Write the goal in the New Plan sheet"
            : "Start a questions-only chat in the main folder"
      }
      keys={sendKeys}
    >
      <button
        type="button"
        className={cx(d.create, ready && d.createReady)}
        aria-disabled={!ready || busy}
        onClick={() => void send()}
      >
        <Icon
          name={worktree ? "branch" : plan ? "flag" : "chat"}
          size={12}
        />
        {worktree ? "Create Worktree" : plan ? `Plan with ${agent}` : "Ask"}
        <span className={d.createKey}>{sendKeys}</span>
      </button>
    </Tip>
  );

  return (
    <section className={s.composer} aria-label="Start something" data-drop-zone>
      {att.dropTarget}
      <div className={s.composerHead}>
        <h2 className={s.prompt}>What do you want to do in {project.name}?</h2>
        <Segmented<Mode>
          label="How to start"
          value={mode}
          onChange={(m) => {
            setMode(m);
            ref.current?.focus();
          }}
          options={[
            {
              value: "worktree",
              label: "New Worktree",
              icon: "branch",
              hint: "Your agent works on its own branch and folder, made from the latest origin",
            },
            {
              value: "ask",
              label: "Just Ask",
              icon: "chat",
              hint: "A question about the project: your agent reads the main folder and changes nothing",
            },
            // Plans run in the Beluga app only.
            ...(plansOn
              ? [
                  {
                    value: "plan" as const,
                    label: "New Plan",
                    icon: "flag" as const,
                    hint: "Big work: your agent cuts it into milestones and tasks; nothing reaches the board until you approve",
                  },
                ]
              : []),
          ]}
        />
      </div>
      <div
        className={cx(s.box, busy && s.busy, att.dropping && c.dropping)}
        {...att.dropProps}
      >
        {box.list}
        {att.images.length || att.files.length ? (
          <div className={s.waiting}>{att.waiting}</div>
        ) : null}
        <DictationStrip box={ref} />
        <div className={c.inputWrap}>
          <MentionHighlighter
            text={text}
            input={ref}
            className={s.input ?? ""}
          />
          <textarea
            ref={ref}
            className={`${s.input} ${c.overHighlight} selectable`}
            aria-label={
              worktree
                ? "Task for the new worktree"
                : plan
                  ? `Goal for a plan in ${project.name}`
                  : `Question about ${project.name}`
            }
            placeholder={
              worktree
                ? "Describe a task: “Add a health check endpoint with a test”"
                : plan
                  ? "What should be built, and what done looks like: “Let customers pay by card, with refunds from the admin”"
                  : `Ask about ${project.name}…`
            }
            value={text}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            onPaste={att.onPaste}
            onKeyDown={onKey}
            spellCheck
          />
        </div>
        <div className={s.bar}>
          {worktree ? (
            <>
              <label className={d.field}>
                <span className={d.fieldLabel}>Based on</span>
                <Tip label="The branch the new one starts from (origin branches are fetched first, so it's the latest)">
                  <Select
                    className={d.select}
                    size="small"
                    mono
                    label="Based on"
                    value={chosen}
                    onChange={setBase}
                    options={branchOptions(options, branches?.base)}
                    searchPlaceholder="Find a branch"
                  />
                </Tip>
              </label>
              <label className={d.field}>
                <span className={d.fieldLabel}>Name</span>
                <input
                  className={`${d.name} ${s.nameInput} selectable`}
                  aria-label="Worktree name"
                  placeholder="from the task"
                  value={name}
                  maxLength={60}
                  spellCheck={false}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && (e.preventDefault(), void send())
                  }
                />
              </label>
            </>
          ) : plan ? (
            <span className={s.note}>
              <Icon name="flag" size={12} />
              Nothing reaches the board until you approve the plan.
            </span>
          ) : (
            <span className={s.note}>
              <Icon name="eye" size={12} />
              Questions only: your agent reads the main folder and won’t change
              anything.
            </span>
          )}
          {/* Where it runs (BLG-786): a worktree, a question or a plan alike. Only with a computer paired. */}
          <RunsOnPicker project={project.id} />
          {/* Model and thinking effort for new conversations (a chat of its own pins effort once it exists). */}
          <ModelPicker channel="draft" />
          <span className={s.flex} />
          {plan ? (
            <label className={d.field}>
              <span className={d.fieldLabel}>Runs</span>
              <Select<Autonomy>
                className={d.select}
                size="small"
                label="How it runs"
                value={autonomy}
                onChange={setAutonomy}
                options={AUTONOMIES.map((a) => ({
                  value: a,
                  label: AUTONOMY_INFO[a].label,
                  description: AUTONOMY_INFO[a].summary,
                }))}
              />
            </label>
          ) : null}
          <MicButton box={ref} />
          {worktree ? (
            // Create Worktree, and its ▾: the same worktree worked by another agent (BLG-506).
            <SplitButton label="Create with another agent" caretClassName={cx(d.create, ready && d.createReady)} items={startWith(undefined, (a) => void send(a))}>
              {createButton}
            </SplitButton>
          ) : (
            createButton
          )}
        </div>
      </div>
    </section>
  );
}

function Lists({ model }: { model: HomeModel }) {
  const overview = useOpenOverview();
  const { project, worktrees, archived } = model;
  // A plan's own conversation is listed under Plans, not as a question.
  const planHomes = new Set(usePlans().plans.map((p) => p.home));
  const asks = model.asks.filter((w) => !planHomes.has(`ws:${w.id}`));
  // What moves the work first (tasks, plans, worktrees, then GitHub's pull requests and issues); the
  // project's environment and history after, as what you look up rather than act on.
  return (
    <div className={s.lists}>
      <HomeTasks projectId={project.id} />
      <HomePlans projectId={project.id} />
      <Section
        title="Worktrees"
        count={worktrees.length}
        action={
          // Worktrees made outside Beluga that can go (any tool's), ticked in one list.
          outsideOf(project).length ? (
            <Button
              size="small"
              variant="quiet"
              icon="archive"
              onClick={() =>
                openSheet({ kind: "clean_up_worktrees", projectId: project.id })
              }
            >
              Clean Up Worktrees…
            </Button>
          ) : null
        }
      >
        {worktrees.length ? (
          worktrees.map((w) => <Row key={w.id} ws={w} />)
        ) : (
          <p className={s.none}>
            No worktrees yet. Describe a task above and your agent starts one from
            the latest origin.
          </p>
        )}
      </Section>
      <HomePulls projectId={project.id} />
      <HomeIssues projectId={project.id} />
      {asks.length ? (
        <Section
          title="Questions"
          count={asks.length}
          hint="Asked in the main folder: your agent only reads there"
        >
          {asks.map((w) => (
            <Row key={w.id} ws={w} ask />
          ))}
        </Section>
      ) : null}
      <HomeActions projectId={project.id} />
      {project.root ? <EnvSection projectId={project.id} root={project.root} /> : null}
      <HomeHistory projectId={project.id} />
      {archived.length ? (
        <Section
          title="Recently Archived"
          count={archived.length}
          action={
            <Button
              size="small"
              variant="quiet"
              onClick={() => overview(project.id, "archived")}
            >
              Show All in Overview
            </Button>
          }
        >
          {archived.slice(0, 3).map((w) => (
            <Row key={w.id} ws={w} />
          ))}
        </Section>
      ) : null}
      {/* Last and folded: a glance, not the page's point. Its own per project (what's new is what arrived while it was shown). */}
      <EarningsSection key={project.id} project={project} />
    </div>
  );
}

/** How many open pull requests Project Home lists before "Show All". */
const HOME_PULLS = 4;

/**
 * The project's open pull requests on GitHub (anyone's, not only your worktrees'), the most
 * recently active first. Nothing when it isn't on GitHub, gh isn't set up, or none are open.
 */
function HomePulls({ projectId }: { projectId: string }) {
  const list = usePullList(projectId);
  const actions = useActions();
  const shown = list?.kind === "github" ? list.pulls.slice(0, HOME_PULLS) : [];
  const late = useLateArrival(projectId, shown.length > 0);
  const isNew = useArrivals(shown.map((p) => p.number));
  if (list?.kind !== "github" || !shown.length) return null;
  const repo = list.repo;
  return (
    <Section
      arrive={late}
      title="Pull Requests"
      count={list.total}
      hint="Open on GitHub"
      action={
        <>
          {/* GitHub's mark in place of its name: the button stays short beside See All. */}
          <Button
            size="small"
            variant="quiet"
            aria-label="See all on GitHub"
            onClick={() => actions.openLink({ kind: "url", url: `${repo.url}/pulls` })}
          >
            <span className={s.onGitHub}>
              See All on <GitHubMark />
            </span>
          </Button>
          <Button
            size="small"
            variant="quiet"
            aria-label="See all pull requests"
            onClick={() => actions.run({ type: "view", view: { kind: "pulls", projectId } })}
          >
            See All
          </Button>
        </>
      }
    >
      {shown.map((pull) => (
        <div key={pull.number} className={isNew(pull.number) ? a.arrive : undefined}>
          <PullRow projectId={projectId} pull={pull} />
        </div>
      ))}
    </Section>
  );
}

/** How many tasks Project Home lists before "Show All". */
const HOME_TASKS = 3;

/**
 * The project's open tasks on its board, the most recently moved first, each opening its page,
 * and the way to the whole board. Nothing when the board has never had a task for this repo.
 */
function HomeTasks({ projectId }: { projectId: string }) {
  const board = useApp((st) => st.board);
  const { open, openList } = useTaskActions();
  const tasks = useMemo(() => homeTasks(board, projectId, HOME_TASKS), [board, projectId]);
  const isNew = useArrivals(tasks.shown.map((i) => i.id));
  if (!tasks.any) return null;
  return (
    <Section
      title="Tasks"
      count={tasks.open}
      hint="Open on the board, the latest moved first"
      action={
        <Button size="small" variant="quiet" onClick={() => openList(projectId)}>
          Show All Tasks
        </Button>
      }
    >
      {tasks.shown.length ? (
        tasks.shown.map((issue) => (
          <div key={issue.id} role="listitem" className={isNew(issue.id) ? a.arrive : undefined}>
            <TaskRow issue={issue} onOpen={() => open(issue)} />
          </div>
        ))
      ) : (
        <p className={s.none}>Nothing open. Finished tasks are on the board.</p>
      )}
    </Section>
  );
}

function TaskRow({ issue, onOpen }: { issue: Issue; onOpen: () => void }) {
  const status = STATUS_INFO[issue.status];
  return (
    <button
      type="button"
      className={s.row}
      onClick={onOpen}
      aria-label={`${issue.key}: ${issue.title}, ${status.label}`}
    >
      <span className={s.rowIcon}>
        <StatusIcon status={issue.status} size={13} />
      </span>
      <span className={s.rowMain}>
        <span className={s.rowTitle}>
          <span className={s.rowName}>{issue.title}</span>
          <span className={s.rowBranch}>{issue.key}</span>
        </span>
      </span>
      <TonePill tone={status.tone} live={issue.status === "in_progress"}>
        {status.label}
      </TonePill>
      <span className={s.rowWhen}>{agoText(issue.updatedAt)}</span>
      <Icon name="chevronRight" size={11} className={s.rowChevron} />
    </button>
  );
}

/** How many GitHub issues Project Home lists before "Show All". */
const HOME_ISSUES = 3;

/**
 * The project's open GitHub issues, the most recently active first, each opening its page (where
 * Claude can investigate it, fix it or write it up as a task). None open: a line saying so, with
 * the way to the closed ones. Nothing when it isn't on GitHub or gh isn't set up (Issues says how).
 */
function HomeIssues({ projectId }: { projectId: string }) {
  const { list } = useIssueList(projectId, "open", "");
  const { openList } = useIssueActions();
  const shown = list?.kind === "github" ? list.issues.slice(0, HOME_ISSUES) : [];
  const late = useLateArrival(projectId, list?.kind === "github");
  const isNew = useArrivals(shown.map((i) => i.number));
  if (list?.kind !== "github") return null;
  return (
    <Section
      arrive={late}
      title="Issues"
      count={list.issues.length}
      hint={list.more ? "The most recently active, from GitHub" : "Open on GitHub"}
      action={
        <Button size="small" variant="quiet" onClick={() => openList(projectId)}>
          Show All Issues
        </Button>
      }
    >
      {shown.length ? (
        shown.map((issue) => (
          <div key={issue.number} role="listitem" className={isNew(issue.number) ? a.arrive : undefined}>
            <IssueRow projectId={projectId} repo={list.repo} issue={issue} compact />
          </div>
        ))
      ) : (
        <p className={s.none}>No open issues on GitHub.</p>
      )}
    </Section>
  );
}

/** How many workflow runs Project Home lists before "Show All". */
const HOME_RUNS = 5;

/**
 * The project's latest GitHub Actions runs, running ones first, kept current while they run (a
 * turning ring and a growing time), each opening its page to watch. Nothing when it isn't on
 * GitHub, gh isn't set up, or nothing has run.
 */
function HomeActions({ projectId }: { projectId: string }) {
  const { list } = useRuns(projectId);
  const { openList } = useCiActions();
  const runs = useMemo(() => (list?.kind === "github" ? sortRuns(list.runs) : []), [list]);
  const running = runs.filter(isLive).length;
  const now = useNow(running > 0);
  const shown = runs.slice(0, HOME_RUNS);
  const late = useLateArrival(projectId, shown.length > 0);
  const isNew = useArrivals(shown.map((r) => r.id));
  if (!runs.length) return null;
  return (
    <Section
      arrive={late}
      title="Actions"
      count={running || runs.length}
      hint={running ? `${running} running · live` : "The latest workflow runs, from GitHub"}
      action={
        <Button size="small" variant="quiet" onClick={() => openList(projectId)}>
          Show All Runs
        </Button>
      }
    >
      {shown.map((run) => (
        <div key={run.id} role="listitem" className={isNew(run.id) ? a.arrive : undefined}>
          <RunRow projectId={projectId} run={run} now={now} compact />
        </div>
      ))}
    </Section>
  );
}

/** How many plans Project Home lists before "Show All". */
const HOME_PLANS = 3;

/** The project's plans (running first), a few rows each opening its plan; none: nothing shown. */
function HomePlans({ projectId }: { projectId: string }) {
  const state = usePlans();
  const { openList } = usePlanActions();
  const plans = plansOf(state, projectId);
  if (!plans.length) return null;
  return (
    <Section
      title="Plans"
      count={plans.length}
      action={
        plans.length > HOME_PLANS ? (
          <Button
            size="small"
            variant="quiet"
            onClick={() => openList(projectId)}
          >
            Show All Plans
          </Button>
        ) : null
      }
    >
      {plans.slice(0, HOME_PLANS).map((p) => (
        <PlanRow key={p.id} plan={p} />
      ))}
    </Section>
  );
}

function PlanRow({ plan }: { plan: Plan }) {
  const view = usePlanView(plan)!;
  const { open } = usePlanActions();
  const status = planStatus(view);
  const title = titleOf(plan);
  return (
    <div role="listitem">
      <button
        type="button"
        className={s.row}
        onClick={() => open(plan.id)}
        aria-label={`${title}: ${status.label}`}
      >
        <span className={s.rowIcon}>
          <Icon name="flag" size={13} />
        </span>
        <span className={s.rowMain}>
          <span className={s.rowTitle}>
            <span className={s.rowName}>{title}</span>
          </span>
          <span className={s.rowLast}>
            {plan.body
              ? `${view.done} of ${view.total} tasks done`
              : `${view.milestones.length} milestones · ${view.total} tasks · draft`}
          </span>
        </span>
        <TonePill tone={status.tone} live={status.tone === "claude"}>
          {status.label}
        </TonePill>
        <span className={s.rowWhen}>{agoText(plan.updatedAt)}</span>
        <Icon name="chevronRight" size={11} className={s.rowChevron} />
      </button>
    </div>
  );
}

const PR_STATE: Record<PullRequest["state"], string> = {
  OPEN: "Open",
  MERGED: "Merged",
  CLOSED: "Closed",
};

/** A worktree's PR on its row: #n, its state, and a mark for its checks (✓ ✗ or running). A button: it opens the PR sheet. */
function PrChip({ pr, onOpen }: { pr: PullRequest; onOpen?: () => void }) {
  const open = pr.state === "OPEN";
  const tone =
    pr.state === "MERGED"
      ? "merged"
      : !open
        ? "closed"
        : pr.checks === "failing" || pr.conflicts
          ? "failing"
          : pr.checks;
  const Tag = onOpen ? "button" : "span";
  return (
    <Tag
      {...(onOpen
        ? {
            type: "button" as const,
            onClick: onOpen,
            "aria-label": `${describePr(pr)}: show its checks and merge`,
          }
        : {})}
      className={cx(s.rowPr, s[`pr_${tone}`])}
      data-pr-chip={pr.number}
      data-pr-state={pr.state}
      data-pr-checks={pr.checks}
      title={
        onOpen
          ? `${describePr(pr)}: click for its checks and to merge`
          : describePr(pr)
      }
    >
      <Icon name={pr.state === "MERGED" ? "merge" : "pr"} size={11} />
      <span>#{pr.number}</span>
      <span className={s.rowPrState}>
        {pr.draft && open ? "Draft" : PR_STATE[pr.state]}
      </span>
      {open && pr.checks !== "none" ? (
        <span className={s.rowPrChecks} aria-label={`checks ${pr.checks}`}>
          {pr.checks === "pending" ? (
            <span className={s.rowPrRunning} />
          ) : (
            <Icon name={pr.checks === "passing" ? "check" : "x"} size={10} />
          )}
        </span>
      ) : null}
    </Tag>
  );
}

/** One worktree or question: its state, name, last line and when; a click opens it (its PR: the PR sheet). */
function Row({ ws, ask }: { ws: Workspace; ask?: boolean }) {
  const actions = useActions();
  // What the row shows, worked out when the shared state changes (the "when" too, as before):
  // drawn again only when some of it reads differently.
  const { st, last, pr, when } = useApp(
    (full) => ({
      st: stateOf(full, ws, 0),
      last: activityOf(full.log, `ws:${ws.id}`).last,
      pr: ws.kind === "worktree" && !ask ? full.prs[ws.id] : undefined,
      when: agoText(lastActive(full, ws)),
    }),
    (a, b) => sameDeep(a, b, 2),
  );
  const title = ws.kind === "main" ? "Main folder conversation" : ws.name;
  const open = (): void =>
    actions.run(
      ws.archived
        ? { type: "archived_menu", id: ws.id }
        : { type: "open_ws", id: ws.id },
    );
  // The PR chip is its own button (a button can't hold another): it opens the PR sheet, right here.
  const chip = pr ? (
    <PrChip
      pr={pr}
      {...(ws.archived
        ? {}
        : {
            onOpen: () => actions.run({ type: "ws", id: ws.id, action: "pr" }),
          })}
    />
  ) : null;
  const label = `${title}: ${st.label}${pr ? `, ${describePr(pr)}` : ""}`;
  const parts = (
    <>
      <span className={s.rowIcon}>
        {ask ? (
          <Icon name="chat" size={13} />
        ) : (
          <Dot
            tone={st.tone === "claude" ? "claude" : st.tone}
            live={st.tone === "claude"}
          />
        )}
      </span>
      <span className={s.rowMain}>
        <span className={s.rowTitle}>
          <span className={s.rowName}>{title}</span>
          {ws.branch && !ask ? (
            <span className={s.rowBranch}>{ws.branch}</span>
          ) : null}
        </span>
        {last ? <span className={s.rowLast}>{last}</span> : null}
      </span>
    </>
  );
  const tail = (
    <>
      <span className={cx(s.rowState, s[`tone_${st.tone}`])}>
        {ask ? "" : st.label}
      </span>
      <span className={s.rowWhen}>{when}</span>
      <Icon name="chevronRight" size={11} className={s.rowChevron} />
    </>
  );
  if (!pr) {
    return (
      <div role="listitem">
        <button
          type="button"
          className={cx(s.row, ws.archived && s.rowArchived)}
          onClick={open}
          aria-label={label}
        >
          {parts}
          {tail}
        </button>
      </div>
    );
  }
  // With a PR the chip sits beside the open button; a click anywhere else on the row (or Return on the button) bubbles up and opens it.
  const click = (e: React.MouseEvent): void => {
    if (!(e.target as Element).closest("button[data-pr-chip]")) open();
  };
  return (
    <div
      role="listitem"
      className={cx(s.row, s.rowSplit, ws.archived && s.rowArchived)}
      onClick={click}
    >
      <button type="button" className={s.rowOpen} aria-label={label}>
        {parts}
      </button>
      {chip}
      {tail}
    </div>
  );
}
