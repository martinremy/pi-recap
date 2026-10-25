# Bounded Recap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound recap input to 256,000 characters using the previous recap plus new text-only conversation.

**Architecture:** Extract pure request-assembly helpers to `src/recap-context.ts`, separate from Pi UI/model integration. The command snapshots the active branch, builds a bounded prompt and cutoff ID, then stores that cutoff alongside the generated summary in both rendering modes.

**Tech Stack:** TypeScript, Pi extension API, Node's built-in test runner; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-bounded-recap-design.md`

## Global Constraints

- Full prompt maximum: 256,000 JavaScript string characters, not tokens.
- Prior-context allocation: up to 16,000 characters.
- Input contains only user/assistant text plus prior recap and framing; no tool calls/results.
- Preserve existing text-only changes, renderer, model/auth selection, reasoning, and cancellation.
- Remain on `space-reduction`; no background or extra summarization calls.

## Review Focus

- Old persisted recap entries have no saved cutoff: use entry position.
- A saved cutoff is absent from the active branch: fall back without silently dropping history.
- New messages arrive during generation: save the snapshot cutoff, not append position.
- A single summary or message exceeds the budget: truncate explicitly and keep full prompt within limit.
- No new text or only tools exist: preserve a usable prior summary without inventing activity, and warn if there is no usable input at all.

### Task 1: Bounded request assembly and command integration

**Files:**
- Create: `src/recap-context.ts`, `test/recap-context.test.ts`.
- Modify: `src/index.ts`, `package.json`, `README.md`.

**Interfaces:**
- Consumes active-branch entries with `id`, `type`, optional `customType`, `data`, and `message` fields.
- Produces `buildRecapInput(entries: Entry[]): { prompt: string; throughEntryId?: string } | null`.
- Produces exported `MAX_PROMPT_CHARS = 256_000` for verification.
- Extends stored recap data with optional `throughEntryId: string` while preserving `summary` and `ts`.

- [x] **Step 1: Write failing request-assembly tests.** Assert a first recap includes the original request and latest reply; repeated recaps include the latest prior summary and only post-cutoff text; legacy recaps use their entry position. Assert tool calls/results, thinking, images and custom entries are excluded. Cover each Review Focus condition, an oversized single message and summary, and `prompt.length <= MAX_PROMPT_CHARS` for large inputs. Tests must fail if full-session assembly is restored.
- [x] **Step 2: Run tests and confirm expected failures.** Use `node --test test/recap-context.test.ts` with a Node version supporting type stripping; record the runtime requirement in development docs.
- [x] **Step 3: Implement pure helpers.** Move existing text extraction and prompt instructions into `src/recap-context.ts`; select the latest usable branch-local recap, resolve its saved cutoff, allocate 16,000 characters to prior context, pack newest conversation into the remaining budget, and explicitly label omissions/truncation. Account for every framing character before filling the budget. Return null only when neither prior summary nor conversation offers usable input.
- [x] **Step 4: Integrate and add command regression checks.** Replace full-history assembly in `src/index.ts` with `buildRecapInput`, pass the assembled prompt unchanged to the model, and append the snapshot's `throughEntryId` in both TUI and non-TUI paths. Verify a message inserted during generation is eligible on the next request; preserve abort/error behavior.
- [x] **Step 5: Update documentation and test command.** Add `npm test` using Node's test runner, document the 256,000-character ceiling, 16,000-character prior-context allocation, incremental behavior, legacy compatibility, omission caveat, and test runtime.
- [x] **Step 6: Verify and review.** Run `npm test`, `git diff --check`, inspect the final diff, and obtain a focused read-only review of budget accounting and cutoff integration. Report any limitations; leave changes uncommitted unless requested.
