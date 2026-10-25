# pi-recap

On-demand session recaps for [Pi](https://pi.dev). Type `/recap` and get a theme-aware card injected into your transcript summarizing the workstream so far — the goal, what's been done and why, key decisions, what's unresolved, and one concrete next action. Built for re-entering a session after time away.

Inspired by [nicknisi's recap extension](https://github.com/nicknisi/pi-extensions/tree/main/packages/recap), minus the idle timer: recaps only happen when you ask.

## Install

Clone the repo, then point `pi install` at the checkout:

```sh
git clone https://github.com/martinremy/pi-recap.git
pi install /path/to/pi-recap
```

This installs globally (into `~/.pi/agent/settings.json`). Add `-l` to install into the current project instead. Uninstall with `pi remove pi-recap`.

If you're reading this on GitHub and don't need a local checkout, `pi install git:github.com/martinremy/pi-recap` works too.

## Usage

```
/recap
```

That's it — no arguments, no configuration. While the recap generates you'll see a spinner; press <kbd>Esc</kbd> to cancel (this aborts the underlying model request, not just the UI).

The result appears as a card in the transcript and is persisted in the session file, so it survives reloads and shows up in `pi --resume` sessions too.

## Behavior notes

- Uses your **current session model** and inherits its thinking/reasoning level (skipped entirely when reasoning is off or the model doesn't support it).
- Input is **the latest recap on the current branch plus subsequent user/assistant text**. Tool calls, tool results, thinking blocks, and images are excluded. For the first recap, input is the opening user request plus recent conversation.
- The **entire prompt is capped at 256,000 characters** (JavaScript string length, not tokens). Up to 16,000 characters are reserved for the prior recap or opening request; the remaining space goes to the newest conversation. Older messages are omitted when necessary; oversized prior context is truncated from the end, and an oversized latest message keeps its ending. The model is told when input is incomplete, so a recap may not cover omitted work.
- Each recap saves its source cutoff, so messages arriving during generation remain eligible for the next recap. Older saved recaps without cutoff metadata use their position in the branch; an unresolvable cutoff falls back to opening request plus recent history.
- Recap length is a soft target of ~25 lines, set by the prompt — longer recaps render in full rather than being truncated.
- Requires a non-empty conversation and configured auth for the session model; otherwise you get a warning and nothing else happens.
- In non-interactive modes (`-p`, RPC) there's no spinner, just a notification while it works.

## Development

The extension entry point is [`src/index.ts`](src/index.ts), with pure input-assembly helpers in [`src/recap-context.ts`](src/recap-context.ts). Pi loads it directly via jiti — no build step. After editing, restart Pi or start a new session to pick up changes.

Run `npm test` with Node.js 22.18+ (or 24+) for built-in TypeScript stripping. Tests use Node's test runner and do not require Pi dependencies or a live model provider.
