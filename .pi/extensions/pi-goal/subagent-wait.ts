import { randomUUID } from "node:crypto";

export const MAX_WAIT_RUNS = 16;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export type RunState = "queued" | "running" | "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected";
type Terminal = Exclude<RunState, "queued" | "running">;
export type RunWait = { sessionId: string; pending: string[]; settled: Record<string, Terminal> };

export function isRunId(value: unknown): value is string {
	return typeof value === "string" && RUN_ID.test(value);
}

export function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function terminal(state: unknown): Terminal | undefined {
	if (state === "completed") return "complete";
	if (state === "complete" || state === "failed" || state === "partial" || state === "paused" || state === "stopped" || state === "rejected") return state;
}

export function applyNotice(wait: RunWait, message: unknown): RunWait {
	const msg = record(message);
	if (msg?.customType !== "subagent-notify") return wait;
	const runs = record(msg.details)?.runs;
	if (!Array.isArray(runs)) return wait;
	return runs.reduce((next: RunWait, item) => {
		const run = record(item);
		const state = terminal(run?.status);
		return state && isRunId(run?.runId) ? settleRun(next, run.runId, state) : next;
	}, wait);
}

export function settleRun(wait: RunWait, id: string, state: RunState): RunWait {
	const outcome = terminal(state);
	if (!outcome || !wait.pending.includes(id)) return wait;
	return { ...wait, pending: wait.pending.filter((item) => item !== id), settled: { ...wait.settled, [id]: outcome } };
}

export function launchedRuns(entries: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		const item = record(entry);
		const msg = record(item?.message);
		if (item?.type !== "message" || msg?.role !== "toolResult" || msg.toolName !== "subagent" || msg.isError) continue;
		const details = record(msg.details);
		if (isRunId(details?.asyncId) && typeof details.asyncDir === "string") ids.add(details.asyncId);
	}
	return ids;
}

type EventBus = { on(channel: string, fn: (value: unknown) => void): () => void; emit(channel: string, value: unknown): void };

// v1 targeted RPC provides an exact structured run ID. Its state currently lives
// in the status header, not in details; don't scan arbitrary child output for it.
export function readRunState(bus: EventBus, id: string, timeoutMs = 1500): Promise<RunState | undefined> {
	return new Promise((resolve) => {
		const requestId = randomUUID();
		const done = (state?: RunState) => {
			clearTimeout(timer);
			unsubscribe();
			resolve(state);
		};
		const unsubscribe = bus.on(`subagents:rpc:v1:reply:${requestId}`, (raw) => {
			const reply = record(raw);
			if (reply?.version !== 1 || reply.requestId !== requestId || reply.method !== "status" || reply.success !== true) return done();
			const data = record(reply.data);
			if (record(data?.details)?.runId !== id || typeof data?.text !== "string") return done();
			const lines = data.text.split("\n", 8);
			let cursor = 0;
			if (lines[cursor]?.startsWith("Status target: ")) cursor++;
			if (lines[cursor]?.startsWith("Spawn budget: ")) cursor++;
			if (lines[cursor]?.startsWith("Active async capacity: ")) cursor++;
			if (lines[cursor++] !== `Run: ${id}`) return done();
			if (lines[cursor]?.startsWith("Tool call: ")) cursor++;
			if (lines[cursor]?.startsWith("Mission: ")) cursor++;
			const state = lines[cursor]?.match(/^State: (\w+)$/)?.[1];
			done(state === "queued" || state === "running" ? state : terminal(state));
		});
		const timer = setTimeout(done, timeoutMs);
		try {
			bus.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: { id } });
		} catch {
			done();
		}
	});
}
