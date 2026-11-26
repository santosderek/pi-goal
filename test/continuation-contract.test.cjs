const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");

test("persisting a non-active goal cancels any queued continuation", () => {
	assert.match(
		indexSource,
		/if \(next\?\.status !== "active"\) \{\s*continuationQueued = false;\s*\}/,
	);
});

test("goal continuation is scheduled only at the final settle boundary after successful work", () => {
	assert.match(indexSource, /pi\.on\("agent_before_settle"/);
	assert.match(indexSource, /shouldContinueGoal\(goal\.status, event\.outcome, event\.context\.pendingMessages\.length, event\.continue\)/);
	assert.doesNotMatch(indexSource, /pi\.on\("agent_end"/);
	assert.match(indexSource, /entries: \[\.\.\.event\.entries, goalEventEntry\("continuation", goal\)\]/);
});
