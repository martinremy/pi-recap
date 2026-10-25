import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { buildRecapInput, type Entry } from "../src/recap-context.ts";

// Execute the actual extension without installing Pi or contacting a provider.
// Only the host UI/model APIs are replaced; prompt assembly stays real.
const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
	.replace(/^import[\s\S]*?from\s+["'][^"']+["'];\n/gm, "")
	.replace("export default function", "function register");
const register = runInNewContext(stripTypeScriptTypes(source) + "\nregister", {
	buildRecapInput,
	uuidv7: () => "request-session",
	AbortController,
	BorderedLoader: class {
		signal = new AbortController().signal;
	},
});

async function runCommand(mode: string, stopReason = "stop", content = "GENERATED_SUMMARY") {
	const entries: Entry[] = [{ id: "source", type: "message", message: { role: "user", content: "SOURCE_REQUEST" } }];
	const notices: string[] = [];
	let handler: (_args: string, ctx: unknown) => Promise<void>;
	let request: any;
	register({
		registerEntryRenderer() {},
		registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; },
		appendEntry(customType: string, data: unknown) { entries.push({ id: "saved-recap", type: "custom", customType, data }); },
	});
	const ctx = {
		mode,
		waitForIdle: async () => {},
		thinkingLevel: "off",
		model: { provider: "test", id: "test", reasoning: false },
		sessionManager: { getBranch: () => [...entries] },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, input: unknown) => {
				request = input;
				entries.push({ id: "during", type: "message", message: { role: "user", content: "DURING_GENERATION" } });
				return { stopReason, content: [{ type: "text", text: content }] };
			},
		},
		ui: {
			notify: (text: string) => notices.push(text),
			custom: (factory: (...args: any[]) => unknown) => new Promise((resolve) => factory({}, {}, {}, resolve)),
		},
	};
	await handler!("", ctx);
	return { entries, notices, request };
}

for (const mode of ["tui", "rpc"]) {
	test(`${mode}: saves the input snapshot cutoff, not the generation completion position`, async () => {
		const { entries, request } = await runCommand(mode);
		const saved = entries.find((e) => e.id === "saved-recap")!;
		assert.ok(saved);
		assert.equal((saved.data as any).throughEntryId, "source");
		assert.equal((saved.data as any).summary, "GENERATED_SUMMARY");
		const sent = request.messages[0].content[0].text;
		assert.ok(sent.length <= 256_000);
		assert.match(sent, /SOURCE_REQUEST/);
		assert.doesNotMatch(sent, /DURING_GENERATION/);
		const next = buildRecapInput(entries)!;
		assert.match(next.prompt, /GENERATED_SUMMARY/);
		assert.match(next.prompt, /DURING_GENERATION/);
		assert.doesNotMatch(next.prompt, /SOURCE_REQUEST/);
	});

	for (const [stopReason, content] of [["aborted", "IGNORED"], ["error", "IGNORED"], ["stop", ""]]) {
		test(`${mode}: ${stopReason}/${content || "empty"} does not persist a recap or advance cutoff`, async () => {
			const { entries } = await runCommand(mode, stopReason, content);
			assert.equal(entries.some((e) => e.type === "custom"), false);
		});
	}
}
