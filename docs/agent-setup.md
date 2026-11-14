# How Beluga sets up an agent's run

What Beluga adds around an agent's own setup for each run. The instructions come from `runInstructions` in `src/agent/run-instructions.ts`: Claude receives them through `systemPrompt.append` (`--append-system-prompt` in the terminal view), Codex through `developerInstructions`, and OpenCode and Copilot through their instructions file.

## Zsh

Agents write their commands for bash, and run them in zsh on most Macs. There some of them stop: an unquoted glob or URL that matches nothing (`--include=*.ts`, `curl …?a=1`), a pattern zsh can't parse, `[ "$a" == b ]`. Others run differently: `for f in $list` loops once, `${arr[0]}` is empty, `echo` turns the `\n` in a JSON string into a line break.

- **Claude**: Beluga writes `~/.beluga/zsh-compat.sh` and sets `CLAUDE_ENV_FILE` to it, for chat runs (a friend's too) and the terminal view. Claude Code runs the file before every Bash command; a command Beluga keeps running past the turn (`BELUGA_KEEP=1`) runs it too. In zsh it turns on `NO_NOMATCH`, `NO_BAD_PATTERN` and `NO_EQUALS`, so those commands go on with the word as typed, as in bash. In bash it does nothing. If you set `CLAUDE_ENV_FILE` yourself, Beluga leaves it alone. The file is `src/agent/runtime/claude/zsh-compat.ts`.
- Only those three: the options also reach the functions your shell defines (nvm, conda, zoxide), which Claude Code loads ahead of each command. `SH_WORD_SPLIT` and `KSH_ARRAYS` would change how they read their own variables (a loop over `$path` saw one folder instead of all of them), and `BSD_ECHO` how they print (`echo "\e[1m"` showed as text). Those habits are left to the instructions.
- **Every agent**: when its commands run in zsh, the instructions say how to write them: quote globs and URLs, compare with `[[ ]]`, loop over arrays (they count from 1), print text with backslashes with `printf`, and never name a variable `path` or `status`. Claude's say its zsh already takes a glob that matches nothing.
- Which shell that is: for Claude, the one Claude Code picks (`CLAUDE_CODE_SHELL`, then `$SHELL` when either is bash or zsh, else zsh before bash, so a fish user's commands run in zsh). For Codex, your login shell as the system has it (it runs `zsh -lc`); Codex has no file it runs before each command, so it gets the instructions only. OpenCode and Copilot follow your login shell too.
- Nothing on Windows: Claude Code runs its commands in Git Bash there.
