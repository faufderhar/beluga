import type { IconName } from '../components/Icon.js';
import { trayName } from '../lib/os-words.js';
import type { PaneInfo, SettingEntry, SettingsPane } from '../lib/settings-search.js';
// Relative, not @beluga/ui: the root's tests and typecheck read this file too.
import { HIDEABLE_BUTTONS } from '../../../../src/ui/settings-menus.js';
import { EXPERIMENTS, EXPERIMENT_INFO } from '../../../../src/shared/experiments.js';

/** Settings' panes, in sidebar order, with other words people use for them. */
export const PANES: ReadonlyArray<PaneInfo<SettingsPane> & { icon: IconName; keywords?: string }> = [
  { id: 'general', label: 'General', icon: 'gear', keywords: 'profile account' },
  { id: 'appearance', label: 'Appearance', icon: 'eye', keywords: 'look themes colors colours display' },
  { id: 'claude', label: 'Agent', icon: 'spark', keywords: 'claude codex model ai' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', keywords: 'alerts sounds' },
  { id: 'workspaces', label: 'Workspaces', icon: 'branch', keywords: 'worktrees projects git' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', keywords: 'shell console xterm' },
  { id: 'fire', label: 'Fire & Confetti', icon: 'flame', keywords: 'flames effects celebration' },
  { id: 'menubar', label: trayName(), icon: 'laptop', keywords: 'menu bar tray status icon whale' },
  { id: 'environment', label: 'Environment', icon: 'lock', keywords: 'env .env variables secrets api keys' },
  { id: 'people', label: 'People & access', icon: 'people', keywords: 'friends trust network permissions' },
  { id: 'phone', label: 'Phone', icon: 'phone', keywords: 'android iphone mobile companion' },
  { id: 'external', label: 'External agents', icon: 'bot', keywords: 'mcp grokbot claude code codex pairing code token oauth remote' },
  { id: 'computers', label: 'Your Computers', icon: 'server', keywords: 'machines servers mac mini aws cloud ssh remote linux pair' },
  { id: 'voice', label: 'Voice', icon: 'mic', keywords: 'dictation speech microphone talk transcribe' },
  { id: 'keyboard', label: 'Keyboard', icon: 'command', keywords: 'shortcuts keys hotkeys bindings' },
  { id: 'advanced', label: 'Advanced', icon: 'wrench', keywords: 'web access browser agent threads' },
  { id: 'experimental', label: 'Experimental', icon: 'flask', keywords: 'labs beta early preview features try' },
  { id: 'about', label: 'About', icon: 'globe', keywords: 'version logs support' },
];

type Entry = SettingEntry<SettingsPane>;

/** Shown with agent threads on (see SettingsSearch). */
export const THREAD_LIMITS_GROUP = 'Thread limits';

/** The rows of one group of a pane: `[label, detail?, keywords?]`. */
const rows = (pane: SettingsPane, group: string | undefined, list: ReadonlyArray<readonly [string, string?, string?]>): Entry[] =>
  list.map(([label, detail, keywords]) => ({ pane, label, ...(group ? { group } : {}), ...(detail ? { detail } : {}), ...(keywords ? { keywords } : {}) }));

/** A group as a whole (its rows aren't `Row`s, or are made from data). */
const group = (pane: SettingsPane, label: string, detail?: string, keywords?: string): Entry => ({ pane, label, isGroup: true, ...(detail ? { detail } : {}), ...(keywords ? { keywords } : {}) });

/**
 * Every setting the search finds (BLG-740), by pane and in the pane's order. Kept by hand next to
 * the panes; tests/mac-settings-search.test.ts fails when a pane gains a row or group missing
 * here, or loses one listed here. Labels are the panes' own words, so the jump finds the row
 * (Row and Group carry data-setting anchors made from them).
 */
export const SETTINGS: readonly Entry[] = [
  // General
  ...rows('general', undefined, [
    ['Your name', 'What friends see in the room.', 'profile display name'],
    ['Your picture', 'Friends and people in your groups see it.', 'avatar photo profile image'],
    ['Language', 'The language of Beluga’s windows and menus. Beluga reloads to switch.', 'language locale chinese english translation 语言 中文 简体'],
    ["Friends' requests for your agent", "For people you haven't picked a trust level for.", 'default policy trust sharing allow private'],
  ]),
  group('general', 'Updates', 'Update automatically, check for updates.', 'update upgrade version new release'),
  ...rows('general', 'Updates', [
    ['Update automatically', 'Install new versions as they come.', 'auto update upgrade'],
    ['Check for updates', 'At launch and every few hours.', 'update version check now'],
  ]),
  ...rows('general', 'Writing', [
    ['Send with', 'Return or Command-Return sends a message.', 'enter return send message newline new line keyboard'],
    ['Send during a turn', 'Queue waits for the turn to finish. Steer sends to the current turn.', 'queue steer enter return send message running busy interrupt default'],
    ['Show times next to messages', undefined, 'timestamps time clock'],
    ["The agent's steps once it answers", 'Fold them away, or keep them showing.', 'fold steps tools collapse expand show steps'],
  ]),
  ...rows('general', 'Earnings', [['Show earnings in', 'Every total from Stripe and RevenueCat, in the sidebar and the Usage view.', 'currency money stripe revenuecat usd eur dollars']]),

  // Appearance
  ...rows('appearance', undefined, [
    ['Appearance', 'Match the system, light or dark.', 'dark mode light mode night theme system'],
    ['Accent', 'Selection, focus and buttons.', 'color colour highlight tint'],
  ]),
  group('appearance', 'Light theme', 'The window’s colours by day.', 'theme day colors colours palette latte'),
  group('appearance', 'Dark theme', 'The window’s colours at night.', 'theme night colors colours palette oled black'),
  ...rows('appearance', 'Low Power', [['Low Power mode', 'Beluga does less and shows less to save the battery.', 'battery energy save power performance slow']]),
  ...rows('appearance', 'Layout', [
    ['Text size', 'Bigger and smaller text, everywhere.', 'font size zoom bigger smaller scale'],
    ['Density', 'Comfortable or compact.', 'compact comfortable spacing'],
    ['Conversation width', 'Narrow, wide or the full window.', 'chat width narrow wide full'],
    ['Unread in the sidebar', 'Conversations that finished or need you, at the top.', 'unread finished section'],
    ['Sidebar categories', 'Sort chats into Inbox, Working, Later and Settled, in place of Unread and Chats.', 'inbox working later remind snoozed snooze settled settle triage chats'],
    ['Settle when a pull request merges', 'The chat moves to Settled when its pull request merges. Shows when Sidebar categories is on.', 'auto settle merge merged pr automatic'],
    ['Settle idle chats', 'A chat with no activity moves to Settled. Shows when Sidebar categories is on.', 'auto settle idle inactive days automatic'],
    ['Sidebar width', undefined, 'sidebar size'],
    ['Reduce motion', undefined, 'animation motion accessibility'],
    ['Reduce transparency', 'A solid sidebar, with no blur behind the window.', 'blur vibrancy translucent solid accessibility'],
  ]),

  // Agent
  ...rows('claude', undefined, [
    ['Your agent', 'Runs every new conversation and answers when friends write @you.', 'model runtime claude codex default opus sonnet'],
    ['Thinking effort', 'How hard your agent thinks.', 'reasoning think effort max high low'],
    ['Ask before running commands', 'Your own agent. Secrets stay blocked either way.', 'approval permission self approval bash'],
  ]),
  group('claude', 'Models in chat', 'Which models the chat’s model menu offers.', 'open models picker whitelist opus sonnet'),
  group('claude', 'Your agents', 'Each agent Beluga can run, and how to set it up.', 'sign in install login claude code codex'),
  ...rows('claude', 'Your agents', [['Signed in or installed one just now?', 'Check Again looks for your agents now.', 'check again refresh']]),
  group('claude', 'Launch flags', 'Your own flags for claude and codex.', 'args arguments cli flags dangerously skip permissions'),
  ...rows('claude', 'Launch flags', [
    ['Claude Code', 'Your own flags for claude.', 'flags arguments cli'],
    ['Codex', 'Your own flags for codex.', 'flags arguments cli'],
  ]),
  group('claude', 'MCP servers', 'The servers your agent uses.', 'mcp tools servers connectors'),
  ...rows('claude', 'Local models', [['Run on your own models', 'Ollama or another server on your computer.', 'ollama lm studio local llm offline']]),
  ...rows('claude', 'In the chat', [['Sub-agents', 'Every step, one line each, or just a count.', 'subagents task tool agents']]),
  ...rows('claude', 'Context', [
    ['Context meter', 'How full each conversation is, beside the send button.', 'context window tokens usage'],
    ['Auto-compact when the context is nearly full', 'Your agent summarizes and carries on.', 'compact compaction summarize context'],
    ['Compact at', 'How full a conversation gets before it compacts.', 'compact threshold percent context'],
  ]),
  ...rows('claude', 'Usage limits', [
    ['Continue when your usage limit resets', 'Beluga tells your agent to continue once your limit resets.', 'usage limit rate limit reset resume continue automatically auto quota session'],
    ['Skipped this session', 'Nothing continues on its own until the limit resets.', 'usage limit skip session resume continue'],
    ['Chats it’s off in', 'Chats that wait for you to press Continue.', 'usage limit chats off resume continue'],
  ]),
  ...rows('claude', 'Working at once', [['Conversations your agent works in at once', 'Past it, a message waits its turn.', 'parallel concurrency limit queue simultaneous runs']]),
  ...rows('claude', 'Open chats', [['Chats kept at once', 'How many chats Your Mac and Sentinel keep as tabs.', 'chat limit tabs sentinel']]),
  ...rows('claude', THREAD_LIMITS_GROUP, [
    ['Levels of threads', 'How deep a chat’s threads go.', 'thread depth child sub-agent limit'],
    ['Working at once in one chat’s tree', 'Threads working under one chat.', 'thread running tree limit'],
    ['Kept in one chat’s tree', 'Threads under one chat that are not archived.', 'thread archived tree limit'],
    ['Working at once on this computer', 'Threads working in all your chats.', 'thread running mac computer limit'],
  ]),
  ...rows('claude', 'Scratch folder', [
    ['Give your agent a scratch folder', 'Screenshots, logs and notes go to .beluga/scratch/.', 'scratch screenshots logs notes'],
    ['Show the Scratch tab', 'Watch that folder live in the right panel.', 'scratch tab panel'],
  ]),
  ...rows('claude', 'Pull requests and templates', [
    ['Pull request instructions', 'How your agent writes pull requests.', 'pr prompt github'],
    ['Templates', 'Ways to start a task.', 'task templates start'],
  ]),

  // Notifications
  ...rows('notifications', undefined, [
    ['Desktop notifications', 'The bell in the toolbar lists everything either way.', 'alerts banners notify'],
    ['Show on-screen popups when something needs me', 'A card in the corner of the screen, on top of other apps.', 'popup pop-up overlay corner card'],
    ['See the pop-up', 'A pretend request in the corner of the screen.', 'preview popup test'],
    ['Only when Beluga isn’t in front', 'Stay quiet while you’re using Beluga.', 'focus background away'],
  ]),
  ...rows('notifications', 'Sound', [
    ['Sounds', undefined, 'sound chime audio mute'],
    ['Notification sound', undefined, 'sound chime audio tone'],
    ['Volume', undefined, 'sound loud quiet audio'],
    ['Test notification', 'Send one now to see it arrive.', 'try test notification'],
  ]),
  ...rows('notifications', undefined, [['Do Not Disturb', 'Pause desktop notifications for a while.', 'dnd quiet mute silence snooze focus']]),
  group('notifications', 'Tell me when', 'Which events notify you.', 'events notify alerts'),
  ...rows('notifications', 'Tell me when', [
    ['Your agent needs you', 'A question, a plan, or an approval.', 'question approval needs you'],
    ['Your agent finished', 'In a conversation you’re not looking at.', 'done finished complete'],
    ['Your agent finished where I’m looking', 'A long run of yours ending.', 'done finished long run'],
    ['Mentions and messages', 'Someone writes @you.', 'mention dm message'],
    ['People come and go', 'Someone joins, leaves, invites you, or hands work to you.', 'join leave invite'],
    ['Background tasks', 'Background work or a new worktree’s setup finishes.', 'background setup'],
    ['Sentinels', 'A sentinel’s run ends or fails.', 'sentinel watcher'],
    ['Problems', 'Errors, merge conflicts, failed setups.', 'errors failures conflicts'],
    ['Pull requests', 'Opened, checks finished, reviewed.', 'pr github checks review'],
    ['Plans: milestones only', 'A plan tells you when a milestone passes, fails or waits for you.', 'plan milestones'],
  ]),

  // Workspaces
  ...rows('workspaces', undefined, [
    ['Run setup in new worktrees', 'The project’s setup command runs in each new worktree.', 'npm install setup command auto setup'],
    ['Branch prefix', 'What new worktrees’ branches start with.', 'git branch name prefix'],
    ['Keep open pull requests current', 'Your agent pushes its commits to an open pull request when its turn ends.', 'push pr pull request git agent commits'],
    ['Friends may start work here', 'They ask to start a worktree or hand work to you.', 'friend worktrees'],
  ]),
  group('workspaces', 'Hidden projects', 'Projects you hid from the sidebar.', 'hide show unhide project sidebar'),
  group('workspaces', 'Toolbar buttons', 'Which buttons show in the toolbar.', 'toolbar buttons hide show'),
  ...rows(
    'workspaces',
    'Toolbar buttons',
    HIDEABLE_BUTTONS.map(([, label]) => [label, 'A toolbar button.', 'toolbar button hide show'] as const),
  ),

  // Terminal
  ...rows('terminal', 'Shell', [
    ['Shell', 'The shell new terminals run.', 'zsh bash fish shell'],
    ['Path', 'The shell’s own path.', 'shell path binary'],
    ['Login shell', undefined, 'login profile zprofile'],
    ['Extra arguments', undefined, 'shell args arguments flags'],
  ]),
  ...rows('terminal', undefined, [
    ['Font', 'The terminal’s font.', 'terminal font family monospace typeface'],
    ['Size', 'The terminal’s font size.', 'terminal text zoom'],
    ['Line height', undefined, 'terminal spacing line height'],
    ['Cursor', 'Block, bar or underline.', 'terminal cursor caret block bar underline'],
    ['Blinking cursor', undefined, 'terminal cursor blink'],
    ['Scrollback', 'Lines a terminal keeps.', 'terminal history lines buffer'],
    ['Option key as Meta', undefined, 'alt option meta key'],
  ]),
  group('terminal', 'In this window', 'The terminal at the bottom of the window.', 'dock toggle terminal shortcut'),
  group('terminal', 'Colours', 'The terminal’s colour theme.', 'terminal theme colors colours palette'),
  ...rows('terminal', 'Bring your terminal’s look', [
    ['Import from', 'Your terminal app’s font and colours.', 'import iterm ghostty terminal app theme'],
    ['Colours', 'The colours brought in.', 'import colors theme'],
  ]),
  ...rows('terminal', 'Advanced', [
    ['Use Claude Code’s own terminal', 'Conversations as Claude Code’s own screen.', 'terminal view tui claude code'],
    ['Open conversations as', 'A chat or a terminal.', 'chat terminal view default'],
  ]),
  ...rows('terminal', 'Keys in the terminal view', [['The terminal’s keys come first', 'Keys go to the terminal before Beluga.', 'keys shortcuts terminal keyboard']]),

  // Fire & Confetti
  group('fire', 'What’s on', 'Fire around the message box, or none.', 'fire on off enable flames'),
  ...rows('fire', 'What’s on', [['Where', 'Only on Max effort, or always.', 'max effort model']]),
  group('fire', 'Start from', 'Presets for the fire.', 'preset fire style'),
  ...rows('fire', 'When and how', [
    ['When it burns', undefined, 'fire burn when typing working'],
    ['Color the box', 'A rim in the fire’s colours.', 'border rim colour box'],
    ['Style', undefined, 'fire style look'],
  ]),
  group('fire', 'While typing', 'How fast it flares and calms.', 'typing timing speed'),
  group('fire', 'The flames', 'Height, size and speed of the flames.', 'flames height size speed'),
  ...rows('fire', 'Extras', [
    ['Flare when you type fast', 'It burns orange for a moment.', 'temper flare fast typing'],
    ['As you type', 'What flies from the caret.', 'confetti sparks particles caret'],
    ['Deleting pops into pixels', 'What you delete bursts into little pixels.', 'delete pixels burst backspace'],
  ]),
  group('fire', 'Colors', 'The fire’s colours.', 'colours palette fire colors'),

  // Menu bar
  group('menubar', 'Start from', 'Presets for the icon.', 'preset icon'),
  ...rows('menubar', 'The number', [
    ['Counts', 'What the number beside the whale counts.', 'badge count number'],
    ['Reads as', 'It hides at zero.', 'badge number format'],
  ]),
  ...rows('menubar', 'The spout', [
    ['When the whale spouts', undefined, 'whale spout animation'],
    ['Try it', undefined, 'test preview spout'],
  ]),

  // Environment
  ...rows('environment', undefined, [['Variables for', 'Yours, or one project’s workspaces.', 'env variables scope project api keys']]),
  ...rows('environment', 'Worktrees', [['New keys go to the main folder', 'A key a worktree adds to its .env goes to the main folder too.', '.env worktree keys']]),
  ...rows('environment', 'Your agent', [['Read .env files without asking', 'Your agent reads a project’s .env without a request.', 'dotenv secrets read env files']]),
  ...rows('environment', 'Database', [['Postgres for your agent’s views', 'The database your agent’s views read.', 'postgres database sql supabase database url']]),

  // People & access
  ...rows('people', 'Friends', [
    ['Talk with friends directly', 'The Beluga network.', 'network p2p peer friends online'],
    ['Add a friend', undefined, 'friend invite code link qr'],
    ['Who can ask your agent in chats', undefined, 'chats ask agent permission'],
    ['Who sees your usage', undefined, 'usage limits privacy share'],
    ['Say when you’ve seen a message', 'Friends see Seen under their message.', 'seen read receipts delivered privacy'],
  ]),
  group('people', 'What your friends’ agents can do here', 'What each trust level allows.', 'trust capabilities permissions access folders ask me for'),
  group('people', 'Rules for people’s requests', 'Answers you gave once and for all.', 'rules allow always decline'),
  group('people', 'In the room', 'Who’s here and how much you trust them.', 'peers trust room people'),
  group('people', 'Remembered from before', 'People you set a trust level for.', 'forget trust remembered'),
  ...rows('people', 'Remote access', [
    ['How friends reach you', 'The tunnel for the next invite.', 'tunnel tailscale cloudflare ngrok relay remote'],
    ['Take new people', 'Anyone with the link can come in.', 'room open closed join knock'],
    ['Invite link', undefined, 'invite copy link new link'],
  ]),

  // External agents
  ...rows('external', undefined, [
    ['Let other agents connect', 'Turn on the MCP server for agents outside Beluga.', 'mcp server listener on off'],
    ['Pause all agents', 'Refuses every agent and keeps their grants.', 'pause refuse'],
    ['MCP URL', 'The address to give an MCP client.', 'url copy address'],
  ]),
  group('external', 'Connect an agent', 'Make a pairing code: what it may do, and where.', 'pair pairing code connect'),
  ...rows('external', 'Connect an agent', [
    ['For an agent outside this Mac', 'A hosted agent, or one on another computer.', 'remote hosted tailscale public'],
    ['What it may do', 'Its level: ask each time, trusted or full trust.', 'level trust'],
    ['Full trust for this code', 'An explicit choice for a remote agent.', 'remote full warning'],
    ['All projects and chats', 'Or choose what it reaches.', 'projects reach scope'],
    ['Your chats with no project', 'Chats outside any project.', 'chats standalone'],
    ['Direct messages', 'It reads and sends yours.', 'dm messages friends'],
    ['Groups', 'It reads and sends in your groups.', 'groups'],
    ['Pairing code', 'Works once, for 10 minutes.', 'code'],
  ]),
  group('external', 'Connected agents', 'Each agent with a grant: stop or revoke it.', 'revoke stop agents grants'),
  ...rows('external', 'Connected agents', [['Stop all agents', 'Ends their runs now. Their grants stay.', 'stop all']]),
  group('external', 'Activity', 'What agents did, and who decided.', 'audit log activity'),
  ...rows('external', 'Activity', [['Show', 'All, allowed, asked or refused.', 'filter']]),

  // Phone
  group('computers', 'Where new work runs', 'This computer, one of yours, or the least busy.', 'run new work machine best available'),
  ...rows('computers', 'Where new work runs', [['Run New Work On', 'Worktrees, runs, plans and sentinels you start.', 'here best available machine computer']]),
  group('computers', 'You on the network', 'This Mac, or the computer that’s your Always On.', 'always on identity network friends move stand in standing in mac mini server'),
  group('computers', 'Env files sent without asking', 'Projects whose .env files go to your computers.', 'env dotenv secrets ask again always'),
  ...rows('computers', 'Your settings', [['Your settings on every computer', 'They follow you by themselves; a conflict is said here.', 'sync settings conflicts same everywhere secrets keep in sync']]),
  group('computers', 'Your computers', 'Add one over SSH or with a code; rename, icon, Update It, Forget.', 'add ssh link code fingerprint rename icon forget update health'),
  group('phone', 'On the cable', 'A phone plugged into this computer.', 'usb cable adb plugged'),
  group('phone', 'Your phones', 'Paired phones, and Remove.', 'devices paired remove'),
  ...rows('phone', undefined, [
    ['Over Wi‑Fi', 'How your phone reaches this computer.', 'wifi wi-fi network lan'],
    ['From other networks', 'Away from home.', 'relay remote away cellular'],
  ]),
  group('phone', 'Let your agent use your phone', 'Look at the screen, tap, type, install a build.', 'adb control android automation'),
  ...rows('phone', 'Let your agent use your phone', [
    ['How it works', undefined, 'phone agent control'],
    ['Let your agent use this phone', undefined, 'phone agent control allow'],
    ['Wireless debugging', 'Pair the phone for adb over Wi‑Fi.', 'adb wireless debugging developer'],
    ['Beluga Link', 'The phone’s small add-on app.', 'accessibility link app'],
  ]),
  group('phone', 'Pair a phone', 'Show the code to pair a new phone.', 'pair qr code android iphone companion app'),
  ...rows('phone', 'Pair a phone', [['The Beluga app', 'Your phone gets its own key.', 'app download install']]),

  // Voice
  ...rows('voice', 'Writing it down', [
    ['Microphone', 'The microphone you speak into.', 'microphone mic input device airpods headset usb'],
    ['Model', 'The model that writes down what you say.', 'whisper parakeet speech model transcribe'],
    ['Language', 'The language you speak.', 'language english turkish auto'],
  ]),
  ...rows('voice', 'Talk shortcut', [
    ['Shortcut', 'The key you hold to talk.', 'talk push to talk hotkey key'],
    ['From any app', 'The shortcut works wherever you are.', 'global system wide anywhere'],
    ['Send right away', 'Written down, it’s sent.', 'auto send message'],
  ]),

  // Advanced
  ...rows('advanced', 'Web access', [
    ['Open Beluga in a browser', 'Use Beluga from a browser.', 'web browser remote access'],
    ['Reached from', 'This computer, your network, or anywhere.', 'local network tunnel internet'],
    ['Address', 'Where the browser opens Beluga.', 'url address link'],
    ['Let a browser in', 'A link that works once, for 10 minutes.', 'link browser login'],
  ]),
  ...rows('advanced', 'Agent threads', [['Let your agents start threads', 'Child chats, each with its own agent.', 'threads child sub-agent family orchestrate']]),

  // Experimental: one group per experiment, its switch the row (made from shared/experiments.ts).
  ...EXPERIMENTS.flatMap((id) => rows('experimental', EXPERIMENT_INFO[id].title, [[EXPERIMENT_INFO[id].title, EXPERIMENT_INFO[id].summary, `${id} experimental early ${EXPERIMENT_INFO[id].keywords}`]])),

  // About
  ...rows('about', undefined, [
    ['The Beluga app', 'Its version.', 'version build'],
    ['Updates', 'Check Now, and when Beluga last looked.', 'update upgrade version check now'],
    ['Beluga (the part that runs your room)', 'The daemon’s version.', 'daemon version'],
    ['Windows attached', 'Beluga windows connected to the room right now.', 'clients windows'],
    ['Log', '~/.beluga/logs/daemon.log', 'logs console daemon log debug'],
    ['Report a Problem', undefined, 'bug report issue feedback'],
  ]),
  ...rows('about', 'Support Beluga', [['Beluga is free, and a passion project', 'Star it on GitHub.', 'star github support sponsor']]),
];
