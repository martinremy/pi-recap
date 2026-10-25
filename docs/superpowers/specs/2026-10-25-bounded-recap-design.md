# Bounded incremental recap

## Intent and constraints

Reduce the amount sent to the model while retaining enough continuity for a human returning to a session. Work on `space-reduction`; preserve the existing text-only change, rendering, cancellation, model selection, and authentication behavior. No new runtime dependencies or background model calls.

## Approaches

Considered a bounded recent conversation, previous recap plus recent conversation, and original request plus recent conversation. The user selected previous recap plus recent conversation for continuity, with the original request plus recent conversation as the first-recap fallback. A compaction-summary approach was also considered, but its agent-oriented summaries are less suited to human reorientation.

## Approved behavior

- Limit the complete assembled prompt string to **256,000 characters**, measured as JavaScript string length; this is not a token guarantee.
- Find the latest usable `type: "custom", customType: "recap"` entry on the active branch.
- Include bounded prior-summary context plus subsequent user/assistant text, never tool calls or tool results.
- With no usable prior recap, reserve bounded context for the opening user request and include recent conversation without duplicating that request.
- Save the last source entry ID with each new recap. Use that saved cutoff, not append time, to determine which conversation is new. For legacy recaps without a cutoff, use the recap entry position.
- Preserve newer complete messages when they fit; truncate oversized individual messages explicitly rather than exceeding the budget. State omissions in the prompt so the model does not imply exhaustive coverage.
- New developments supersede old goals; resolved details need not accumulate. Continue the existing soft target of fewer than 25 output lines.

## Builder choices

Reserve up to 16,000 characters for prior-summary/opening-request context; use the remaining budget for recent conversation after prompt framing and omission notes. Mark truncation explicitly. If a saved cutoff cannot be resolved on the current branch, fall back to original-request plus bounded recent history rather than silently skipping unknown content. Use the saved cutoff as generation-time snapshot metadata in both TUI and non-TUI paths.

## Verification

Dependency-free automated tests must cover text-only filtering, first and repeated recaps, latest recap selection, legacy fallback, branch-local lookup, unresolved cutoffs, messages arriving during generation, oversized summaries/messages, omission reporting, and the full-prompt limit. No live model call is required to verify request assembly.
