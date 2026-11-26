const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");
const readme = readFileSync(join(__dirname, "../README.md"), "utf8");

test("create_goal tool carries strong goal-writing contract", () => {
	assert.match(indexSource, /A goal must be a durable, evidence-checkable work contract/);
	for (const phrase of [
		"outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition",
		"Do not infer goals from ordinary coding tasks or one-off prompts",
		"Use this objective shape when possible",
		"verified by <specific evidence>, while preserving <constraints>",
		"Prefer a self-contained objective that survives continuation turns and context compaction",
		"ask a clarifying question if missing success criteria or boundaries materially affect the contract",
	]) {
		assert.match(indexSource, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("create_goal uses upsert semantics for explicitly requested goals", () => {
	assert.match(indexSource, /sets or replaces the current thread goal/);
	assert.match(indexSource, /When called, create_goal replaces any existing goal with the new objective/);
	assert.doesNotMatch(indexSource, /replaceExisting/);
	assert.doesNotMatch(indexSource, /This thread already has a goal/);
});

test("update_goal can complete verified work or pause while blocked on user input", () => {
	assert.match(indexSource, /name: "update_goal"/);
	assert.match(indexSource, /enum: \["complete", "paused"\]/);
	assert.match(indexSource, /Use update_goal with status paused when progress requires a user decision/);
	assert.match(indexSource, /Do not keep repeating the same question in autonomous turns/);
});

test("README documents the model-set goal and completion accounting contracts", () => {
	assert.match(readme, /`create_goal` tool: model can set or replace the current goal only when explicitly requested/);
	assert.match(readme, /The final turn is still accounted even when the model completes or pauses the goal mid-turn/);
	assert.match(readme, /Continuations are requested only at Pi's final settle boundary after a completed run/);
});
