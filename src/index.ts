import { uuidv7, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	DynamicBorder,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

// /recap: on-demand session recap, rendered as a theme-aware card in the transcript.

const ENTRY_TYPE = "recap";

type RecapData = { summary: string; ts: number };

type Entry = { type: string; message?: { role?: string; content?: unknown } };
type Block = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };

type SessionModel = NonNullable<ExtensionContext["model"]>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content
		.filter((p): p is Block => !!p && typeof p === "object")
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string);
}

function toolLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((p): p is Block => !!p && typeof p === "object")
		.filter((b) => b.type === "toolCall" && typeof b.name === "string")
		.map((b) => `Tool ${b.name} called with ${JSON.stringify(b.arguments ?? {})}`);
}

function buildConversation(entries: Entry[]): string {
	const sections: string[] = [];
	for (const e of entries) {
		if (e.type !== "message" || !e.message?.role) continue;
		const role = e.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const lines: string[] = [];
		const t = textParts(e.message.content).join("\n").trim();
		if (t) lines.push(`${role === "user" ? "User" : "Assistant"}: ${t}`);
		if (role === "assistant") lines.push(...toolLines(e.message.content));
		if (lines.length) sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
}

function summaryPrompt(conversation: string): string {
	return [
		"Generate a recap of this workstream to help the developer re-enter the session after time away, written for a human catching up rather than for the agent's own state-tracking. Open with the original goal as stated or inferred, so the developer can re-anchor on what this session was actually for. Summarize the work done so far as a short narrative of what was built or changed and why, not a diff or file list, since the developer needs to reconstruct intent rather than inspect edits the agent already has in hand. Call out the few decisions or tradeoffs made along the way that a returning developer would need to know to avoid re-litigating them or being surprised by them. State plainly what is still unresolved or in-progress — an open question, a choice deferred to the developer, or a part of the task not yet started — since this is the gap the developer's judgment needs to fill, not something the agent can silently resolve. Close with one concrete next action, framed as a recommendation the developer can approve, redirect, or take over, rather than an open-ended list of options. Keep the whole recap under 25 lines, tight enough to read in a few seconds, since its job is re-orientation, not documentation.",
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");
}

/** Returns "" when the call was aborted or produced no text; throws on failure. */
async function generateSummary(
	ctx: ExtensionContext,
	model: SessionModel,
	conversation: string,
	signal?: AbortSignal,
): Promise<string> {
	// Inherit the session's thinking level, mirroring pi's own summarization
	// calls: only pass `reasoning` when the model reasons and the level is on.
	const options: {
		cacheRetention: "none";
		sessionId: string;
		signal?: AbortSignal;
		reasoning?: ThinkingLevel;
	} = {
		cacheRetention: "none",
		sessionId: uuidv7(),
		signal,
	};
	const level = ctx.thinkingLevel as string | undefined;
	if (model.reasoning && level && level !== "off") {
		options.reasoning = level as ThinkingLevel;
	}

	const response = await ctx.modelRegistry.complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: summaryPrompt(conversation) }],
					timestamp: Date.now(),
				},
			],
		},
		options,
	);
	if (response.stopReason === "aborted") return "";
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "model request failed");
	}
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<RecapData>(ENTRY_TYPE, (entry, _opts, theme) => {
		const data = entry.data;
		if (!data?.summary) return undefined;
		const dim = (s: string) => theme.fg("dim", s);
		// Theme-aware bg: same token pi's own summary cards (compaction, branch)
		// use, so the card stands out appropriately in every theme.
		const bg = (s: string) => theme.bg("customMessageBg", s);
		const box = new Box(0, 1, (s) => bg(dim(s)));
		box.addChild(new Text(theme.bold("Recap"), 0, 0));
		box.addChild(new DynamicBorder((s) => dim(s)));
		// No hard line cap: the prompt targets ~25 lines, but a longer recap is
		// rendered in full rather than truncated (the transcript scrolls).
		box.addChild(new Markdown(data.summary, 0, 0, getMarkdownTheme()));
		return box;
	});

	pi.registerCommand("recap", {
		description: "Inject a recap of the conversation so far into the transcript",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const conversation = buildConversation(ctx.sessionManager.getBranch());
			if (!conversation.trim()) {
				ctx.ui.notify("recap: nothing to recap yet", "warning");
				return;
			}
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("recap: no session model available", "warning");
				return;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
				ctx.ui.notify(`recap: no authentication configured for ${model.provider}/${model.id}`, "warning");
				return;
			}

			// ctx.ui.custom() is TUI-only; in other modes fall back to a plain
			// notification while the recap generates.
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Generating recap…", "info");
				try {
					const summary = await generateSummary(ctx, model, conversation);
					if (summary) {
						pi.appendEntry(ENTRY_TYPE, { summary, ts: Date.now() } satisfies RecapData);
					}
				} catch (error: unknown) {
					ctx.ui.notify(`recap: ${errorMessage(error)}`, "warning");
				}
				return;
			}

			const result = await ctx.ui.custom<{ summary: string | null; error?: string }>(
				(tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, "Generating recap…");
					loader.onAbort = () => done({ summary: null });
					generateSummary(ctx, model, conversation, loader.signal)
						.then((summary) => done({ summary: summary || null }))
						.catch((error: unknown) =>
							done(
								loader.signal.aborted
									? { summary: null }
									: { summary: null, error: errorMessage(error) },
							),
						);
					return loader;
				},
			);

			if (result.error) {
				ctx.ui.notify(`recap: ${result.error}`, "warning");
				return;
			}
			if (!result.summary) {
				ctx.ui.notify("recap: cancelled", "info");
				return;
			}
			pi.appendEntry(ENTRY_TYPE, { summary: result.summary, ts: Date.now() } satisfies RecapData);
		},
	});
}
