import { uuidv7, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	DynamicBorder,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { buildRecapInput, type RecapData } from "./recap-context.ts";

// /recap: on-demand session recap, rendered as a theme-aware card in the transcript.

const ENTRY_TYPE = "recap";

type SessionModel = NonNullable<ExtensionContext["model"]>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Returns "" when the call was aborted or produced no text; throws on failure. */
async function generateSummary(
	ctx: ExtensionContext,
	model: SessionModel,
	prompt: string,
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
					content: [{ type: "text", text: prompt }],
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

			const input = buildRecapInput(ctx.sessionManager.getBranch());
			if (!input) {
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
					const summary = await generateSummary(ctx, model, input.prompt);
					if (summary) {
						pi.appendEntry(ENTRY_TYPE, { summary, ts: Date.now(), throughEntryId: input.throughEntryId } satisfies RecapData);
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
					generateSummary(ctx, model, input.prompt, loader.signal)
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
			pi.appendEntry(ENTRY_TYPE, { summary: result.summary, ts: Date.now(), throughEntryId: input.throughEntryId } satisfies RecapData);
		},
	});
}
