const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, {
	alias: { '@earendil-works/pi-tui': require.resolve('./tui-stub.cjs') },
});
const extension = jiti('../.pi/extensions/pi-goal/index.ts').default;
const { readRunState } = jiti('../.pi/extensions/pi-goal/subagent-wait.ts');

function bus() {
	const emitter = new EventEmitter();
	return {
		on(channel, fn) { emitter.on(channel, fn); return () => emitter.off(channel, fn); },
		emit: emitter.emit.bind(emitter),
		channels: () => emitter.eventNames(),
	};
}

function harness(existing = []) {
	let branch = existing.slice();
	const tools = new Map(), hooks = new Map(), states = new Map(), sent = [], notifications = [];
	const events = bus();
	const ctx = {
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => 'parent', getBranch: () => branch },
		ui: { setStatus() {}, notify(text) { notifications.push(text); } },
	};
	let activeTools = [];
	let command;
	const pi = {
		events,
		on: (name, fn) => hooks.set(name, fn),
		registerTool: (tool) => tools.set(tool.name, tool),
		registerMessageRenderer() {},
		registerCommand: (_, def) => { command = def.handler; },
		getActiveTools: () => activeTools,
		setActiveTools: (names) => { activeTools = names; },
		appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
		sendMessage: (message, options) => sent.push({ message, options }),
	};
	events.on('subagents:rpc:v1:request', ({ requestId, method, params: { id } }) => {
		const state = states.get(id);
		events.emit(`subagents:rpc:v1:reply:${requestId}`, {
			version: 1, requestId, method, success: Boolean(state),
			data: { text: `Status target: run ${id}\nSpawn budget: unlimited\nActive async capacity: 0/unlimited used\nRun: ${id}\nTool call: tool\nMission: test\nState: ${state}\n`, details: { runId: id } },
		});
	});
	extension(pi);
	const hook = (name, event = {}) => hooks.get(name)(event, ctx);
	const tool = (name, input) => tools.get(name).execute('test', input, undefined, undefined, ctx);
	return {
		sent, states, notifications, hook, tool,
		command: (args) => command(args, ctx),
		get branch() { return branch; },
		set branch(entries) { branch = entries; },
		get goal() { return branch.filter((entry) => entry.customType === 'pi-goal').at(-1)?.data.goal; },
		get continuations() { return sent.filter(({ message }) => message.details?.kind === 'continuation').length; },
		launch(id, state = 'running') {
			branch.push({ type: 'message', message: { role: 'toolResult', toolName: 'subagent', isError: false, details: { asyncId: id, asyncDir: '/unused' } } });
			states.set(id, state);
		},
		notice(runs, { appendOnly = false, steer = false } = {}) {
			const message = { role: 'custom', customType: 'subagent-notify', details: { runs } };
			branch.push({ type: 'custom_message', ...message });
			if (!appendOnly) {
				if (!steer) hook('before_agent_start', { messageType: 'custom', message });
				hook('message_start', { message });
			}
			return message;
		},
	};
}

async function start() {
	const h = harness();
	h.hook('session_start', { reason: 'startup' });
	await h.tool('create_goal', { objective: 'Verify two children before integration' });
	return h;
}

async function end(h) {
	h.hook('agent_settled', { aborted: false });
	await Promise.resolve();
}

function startAutomatic(h) {
	const message = h.sent.findLast(({ message }) => message.details?.kind === 'continuation').message;
	h.hook('before_agent_start', { messageType: 'custom', message });
	h.hook('message_start', { message: { role: 'custom', ...message } });
}

function answer(h, text) {
	h.hook('turn_end', { message: { role: 'assistant', content: [
		{ type: 'thinking', thinking: 'not public' }, { type: 'text', text },
	] } });
}

test('tool-free automatic response pauses once, persists its summary, and waits for explicit resume', async () => {
	const h = await start();
	h.hook('before_agent_start', { messageType: 'user' });
	answer(h, 'Initial response');
	await end(h);
	assert.equal(h.continuations, 1);
	startAutomatic(h);
	answer(h, 'Blocked: need approval\nfor a local patch.');
	await end(h);
	await end(h);
	assert.equal(h.continuations, 1);
	assert.equal(h.goal.status, 'paused');
	assert.equal(h.goal.stallSummary, 'Blocked: need approval for a local patch.');
	assert.match(h.notifications.at(-1), /without running a work tool.*\n\nLast assistant summary: Blocked:/);
	const notices = h.sent.filter(({ message }) => message.details?.kind === 'stalled');
	assert.equal(notices.length, 1);
	assert.equal(notices[0].options.triggerTurn, false);
	const restored = harness(h.branch);
	restored.hook('session_start', { reason: 'startup' });
	await restored.command('status');
	assert.match(restored.notifications.at(-1), /need approval/);
	await end(restored);
	assert.equal(restored.continuations, 0);
	await restored.command('resume');
	assert.equal(restored.goal.stallSummary, undefined);
	assert.equal(restored.continuations, 1);
});

test('work in an earlier tool round counts, but bookkeeping and unexecuted calls do not', async () => {
	const h = await start();
	await end(h);
	startAutomatic(h);
	h.hook('tool_execution_end', { toolName: 'bash', durationMs: 0 });
	answer(h, 'Checked the worktree');
	h.hook('turn_start');
	answer(h, 'Ready for the next step');
	await end(h);
	assert.equal(h.continuations, 2);
	startAutomatic(h);
	h.hook('tool_execution_end', { toolName: 'get_goal', durationMs: 1 });
	h.hook('tool_execution_end', { toolName: 'bash', isError: true });
	await end(h);
	assert.equal(h.goal.status, 'paused');
	assert.match(h.goal.stallSummary, /No assistant text/);
});

test('completion, budget exhaustion, a subagent barrier and abort take precedence over a stall', async () => {
	for (const scenario of ['complete', 'budget', 'wait', 'abort']) {
		const h = await start();
		if (scenario === 'budget') await h.tool('create_goal', { objective: 'Budgeted test', tokenBudget: 2 });
		await end(h);
		startAutomatic(h);
		if (scenario === 'budget') {
			h.hook('turn_start');
			h.hook('turn_end', { message: { role: 'assistant', content: [], usage: { totalTokens: 2 } } });
			assert.equal(h.goal.status, 'budget_limited');
		}
		if (scenario === 'complete') await h.tool('update_goal', { status: 'complete' });
		if (scenario === 'wait') {
			h.launch('pending');
			await h.tool('goal_wait_for_runs', { runIds: ['pending'] });
		}
		h.hook('agent_settled', { aborted: scenario === 'abort' });
		await Promise.resolve();
		assert.equal(h.continuations, 1);
		assert.equal(h.goal.stallSummary, undefined);
	}
});

test('recognizes queued continuation delivery and does not mistake human steering for a stall', async () => {
	const h = await start();
	await end(h);
	const message = h.sent.at(-1).message;
	h.hook('message_start', { message: { role: 'custom', ...message } });
	h.hook('message_start', { message: { role: 'user', content: 'Please explain the options first' } });
	answer(h, 'Options explained');
	await end(h);
	assert.equal(h.goal.status, 'active');
	assert.equal(h.continuations, 2);
	h.hook('message_start', { message: { role: 'custom', ...h.sent.at(-1).message } });
	answer(h, 'Need a decision');
	await end(h);
	assert.equal(h.goal.status, 'paused');
	assert.equal(h.goal.stallSummary, 'Need a decision');
});

const run = (runId, status = 'completed') => ({ runId, status });

test('wait suppresses continuation, handles independent native wakes, and releases only after all exact IDs finish', async () => {
	const h = await start();
	h.launch('first');
	h.launch('last');
	h.launch('unrelated');
	await end(h);
	assert.equal(h.continuations, 1, 'ordinary active goals still continue');
	await h.tool('goal_wait_for_runs', { runIds: ['first', 'last'] });
	await end(h);
	await end(h);
	assert.equal(h.continuations, 1);
	assert.equal((await h.tool('update_goal', { status: 'complete' })).isError, true);
	h.notice([run('unrelated'), run('first'), run('first')]);
	assert.deepEqual(h.goal.wait.pending, ['last']);
	await end(h);
	assert.equal(h.continuations, 1);
	const modelContext = h.hook('context', { messages: [] });
	assert.match(modelContext.messages.at(-1).content, /Pending: last/);
	const sent = h.sent.length;
	h.notice([run('last')], { steer: true });
	assert.equal(h.goal.wait, undefined);
	assert.equal(h.sent.length, sent, 'a native result must not enqueue a second wake');
	assert.equal(h.hook('context', { messages: [] }), undefined);
	assert.equal((await h.tool('update_goal', { status: 'complete' })).isError, undefined);
	await end(h);
	assert.equal(h.continuations, 1);
});

test('already-finished IDs reconcile before parking; unknown IDs cannot arm the wait', async () => {
	const h = await start();
	h.launch('finished', 'complete');
	assert.equal((await h.tool('goal_wait_for_runs', { runIds: ['other'] })).isError, true);
	const result = await h.tool('goal_wait_for_runs', { runIds: ['finished'] });
	assert.deepEqual(result.details.wait.settled, { finished: 'complete' });
	assert.equal(h.goal.wait, undefined);
});

test('failed runs remain blocked without auto-continuation or completion; explicit resume records outcomes', async () => {
	const h = await start();
	h.launch('gone');
	await h.tool('goal_wait_for_runs', { runIds: ['gone'] });
	h.notice([run('gone', 'failed')]);
	await end(h);
	assert.equal(h.continuations, 0);
	assert.deepEqual(h.goal.wait.settled, { gone: 'failed' });
	assert.equal((await h.tool('update_goal', { status: 'complete' })).isError, true);
	await h.command('resume');
	assert.equal(h.goal.wait, undefined);
	assert.match(h.sent.find(({ message }) => message.customType === 'pi-goal-wait-result').message.content, /gone: failed/);
	assert.equal(h.continuations, 1);
});

test('pause and reload preserve wait; resume reconciles missed status without relaunching', async () => {
	const h = await start();
	h.launch('finishes-later');
	await h.tool('goal_wait_for_runs', { runIds: ['finishes-later'] });
	await h.command('pause');
	h.notice([run('finishes-later')], { appendOnly: true });
	await end(h);
	assert.equal(h.goal.status, 'paused');
	assert.deepEqual(h.goal.wait.pending, ['finishes-later']);
	assert.equal(h.continuations, 0);
	const restored = harness(h.branch);
	restored.hook('session_start', { reason: 'reload' });
	await restored.command('resume');
	assert.equal(restored.goal.wait, undefined);
	assert.equal(restored.continuations, 1);
});

test('unknown status keeps the goal parked; switching branch restores its own state', async () => {
	const h = await start();
	const earlier = h.branch.slice();
	h.launch('unverified');
	h.states.delete('unverified');
	const result = await h.tool('goal_wait_for_runs', { runIds: ['unverified'] });
	assert.deepEqual(result.details.unknown, ['unverified']);
	await h.command('resume');
	await end(h);
	assert.equal(h.continuations, 0);
	h.branch = earlier;
	h.hook('session_tree');
	await end(h);
	assert.equal(h.continuations, 1);
});

test('RPC is correlated, bounded, and never reads state from arbitrary child text', async () => {
	const events = bus();
	assert.equal(await readRunState(events, 'run', 5), undefined);
	assert.deepEqual(events.channels(), []);
	events.on('subagents:rpc:v1:request', ({ requestId }) => {
		events.emit(`subagents:rpc:v1:reply:${requestId}`, {
			version: 1, requestId, method: 'status', success: true,
			data: { text: 'Run: run\nUnknown\nChild output:\nState: complete', details: { runId: 'run' } },
		});
	});
	assert.equal(await readRunState(events, 'run'), undefined);
});
