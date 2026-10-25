import assert from "node:assert/strict";
import test from "node:test";
import { buildRecapInput, type Entry } from "../src/recap-context.ts";

const message = (id: string, role: string, content: unknown): Entry => ({
	id, type: "message", message: { role, content },
});
const recap = (id: string, summary: string, throughEntryId?: string): Entry => ({
	id, type: "custom", customType: "recap", data: { summary, ts: 123, throughEntryId },
});
const prompt = (entries: Entry[]) => {
	const result = buildRecapInput(entries);
	assert.ok(result);
	assert.ok(result.prompt.length <= 256_000, `prompt too large: ${result.prompt.length}`);
	return result.prompt;
};

test("first recap preserves the opening request and recent text without duplication", () => {
	const entries = [message("1", "user", "ORIGINAL_GOAL"), message("2", "assistant", "RECENT_REPLY")];
	const result = buildRecapInput(entries)!;
	assert.equal(result.throughEntryId, "2");
	assert.equal(result.prompt.split("ORIGINAL_GOAL").length - 1, 1);
	assert.match(result.prompt, /RECENT_REPLY/);
});

test("only user and assistant text is included", () => {
	const text = prompt([
		message("1", "user", [{ type: "text", text: "QUESTION" }, { type: "image", data: "EXCLUDED_IMAGE" }]),
		message("2", "assistant", [
			{ type: "thinking", thinking: "EXCLUDED_THINKING" },
			{ type: "text", text: "ANSWER" },
			{ type: "toolCall", name: "bash", arguments: { command: "EXCLUDED_COMMAND" } },
		]),
		message("3", "toolResult", "EXCLUDED_OUTPUT"),
		message("4", "system", "EXCLUDED_SYSTEM"),
		{ id: "5", type: "compaction", data: { summary: "EXCLUDED_COMPACTION" } },
	]);
	assert.match(text, /QUESTION/);
	assert.match(text, /ANSWER/);
	assert.doesNotMatch(text, /EXCLUDED_/);
});

test("uses the latest usable recap and only conversation after its saved cutoff", () => {
	const text = prompt([
		message("1", "user", "EXCLUDED_OLD_GOAL"),
		recap("2", "EXCLUDED_OLD_RECAP", "1"),
		message("3", "assistant", "EXCLUDED_ALREADY_COVERED"),
		recap("4", "LATEST_SUMMARY", "3"),
		message("5", "user", "NEW_REQUEST"),
		{ id: "6", type: "custom", customType: "other", data: { summary: "EXCLUDED_OTHER" } },
		{ id: "7", type: "custom", customType: "recap", data: { summary: " " } },
	]);
	assert.match(text, /LATEST_SUMMARY/);
	assert.match(text, /NEW_REQUEST/);
	assert.doesNotMatch(text, /EXCLUDED_/);
});

test("legacy recaps use their entry position", () => {
	const text = prompt([
		message("1", "user", "EXCLUDED_OLD"), recap("2", "LEGACY_SUMMARY"), message("3", "assistant", "NEW_TEXT"),
	]);
	assert.match(text, /LEGACY_SUMMARY/);
	assert.match(text, /NEW_TEXT/);
	assert.doesNotMatch(text, /EXCLUDED_OLD/);
});

test("messages arriving during recap generation remain eligible next time", () => {
	const entries = [message("1", "user", "EXCLUDED_COVERED")];
	const first = buildRecapInput(entries)!;
	entries.push(message("2", "user", "ARRIVED_DURING_GENERATION"));
	entries.push(recap("3", "PRIOR_SUMMARY", first.throughEntryId));
	const text = prompt(entries);
	assert.match(text, /ARRIVED_DURING_GENERATION/);
	assert.doesNotMatch(text, /EXCLUDED_COVERED/);
});

test("missing or invalid cutoffs fall back to original request plus recent history", () => {
	for (const cutoff of ["missing", "4"]) {
		const text = prompt([
			message("1", "user", "ORIGINAL_GOAL"),
			message("2", "assistant", "OLDER_WORK"),
			recap("3", "UNTRUSTED_BOUNDARY", cutoff),
			message("4", "user", "NEW_WORK"),
		]);
		assert.match(text, /ORIGINAL_GOAL/);
		assert.match(text, /OLDER_WORK/);
		assert.match(text, /NEW_WORK/);
		assert.doesNotMatch(text, /UNTRUSTED_BOUNDARY/);
	}
});

test("only recap entries supplied by the active branch can be used", () => {
	const otherBranch = [message("a", "user", "OTHER_GOAL"), recap("b", "OTHER_SUMMARY", "a")];
	prompt(otherBranch);
	const text = prompt([message("c", "user", "ACTIVE_GOAL")]);
	assert.match(text, /ACTIVE_GOAL/);
	assert.doesNotMatch(text, /OTHER_/);
});

test("bounds a large history and retains newest messages and opening goal", () => {
	const entries = [message("goal", "user", "ORIGINAL_GOAL")];
	for (let i = 0; i < 100; i++) entries.push(message(String(i), "assistant", `TURN_${i}: ${"x".repeat(5_000)}`));
	entries.push(message("end", "user", "LATEST_REQUEST"));
	const text = prompt(entries);
	assert.match(text, /ORIGINAL_GOAL/);
	assert.match(text, /LATEST_REQUEST/);
	assert.match(text, /TURN_99/);
	assert.doesNotMatch(text, /TURN_0:/);
	assert.match(text, /omitted/i);
	assert.match(text, /incomplete/i);
});

test("bounds an oversized prior recap and gives recent work space", () => {
	const text = prompt([
		message("1", "user", "EXCLUDED_OLD"),
		recap("2", `PRIOR_GOAL ${"s".repeat(400_000)}`, "1"),
		message("3", "user", "LATEST_WORK"),
	]);
	assert.match(text, /PRIOR_GOAL/);
	assert.match(text, /LATEST_WORK/);
	assert.match(text, /truncated/i);
	assert.ok(text.length < 20_000);
	assert.doesNotMatch(text, /EXCLUDED_OLD/);
});

test("oversized opening request is truncated without duplicating it", () => {
	const text = prompt([
		message("1", "user", `ORIGINAL_GOAL ${"g".repeat(400_000)}`),
		message("2", "assistant", "LATEST_WORK"),
	]);
	assert.match(text, /ORIGINAL_GOAL/);
	assert.match(text, /LATEST_WORK/);
	assert.match(text, /truncated/i);
	assert.ok(text.length < 20_000);
});

test("oversized latest message retains its end and explicitly reports truncation", () => {
	const text = prompt([
		message("1", "user", "ORIGINAL_GOAL"),
		message("2", "assistant", `${"x".repeat(400_000)} LATEST_DECISION`),
	]);
	assert.match(text, /ORIGINAL_GOAL/);
	assert.match(text, /LATEST_DECISION/);
	assert.match(text, /truncated/i);
	assert.ok(text.length > 250_000);
});

test("omitted history is not resent after the new recap saves its cutoff", () => {
	const entries = [message("1", "user", "ORIGINAL_GOAL"), message("2", "assistant", "x".repeat(400_000))];
	const input = buildRecapInput(entries)!;
	entries.push(recap("3", "COMPACT_SUMMARY", input.throughEntryId), message("4", "user", "NEW_WORK"));
	const text = prompt(entries);
	assert.match(text, /COMPACT_SUMMARY/);
	assert.match(text, /NEW_WORK/);
	assert.doesNotMatch(text, /ORIGINAL_GOAL|x{100}/);
});

test("full prompt stays bounded around allocation boundaries, including Unicode", () => {
	for (const priorSize of [0, 15_999, 16_000, 16_001, 256_000]) {
		for (const messageSize of [0, 1, 237_000, 239_000, 240_000, 254_000, 256_000, 300_000]) {
			for (const character of ["x", "🌍"]) {
				const entries = [message("1", "user", "ORIGINAL_GOAL")];
				if (priorSize) entries.push(recap("2", "s".repeat(priorSize), "1"));
				entries.push(message("3", "assistant", character.repeat(messageSize) + "LATEST_END"));
				assert.match(prompt(entries), /LATEST_END/);
			}
		}
	}
});

test("no new text still permits a prior-summary recap", () => {
	const text = prompt([message("1", "user", "OLD"), recap("2", "PRIOR_SUMMARY", "1")]);
	assert.match(text, /PRIOR_SUMMARY/);
	assert.match(text, /no new/i);
});

test("empty, whitespace and tool-only conversations have no usable input", () => {
	for (const entries of [[], [message("1", "user", "  ")], [message("1", "assistant", [{ type: "toolCall", name: "bash" }])]]) {
		assert.equal(buildRecapInput(entries), null);
	}
});
