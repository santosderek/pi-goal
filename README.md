# pi-goal

![pi-goal](docs/assets/pi-goal-poster.png)

Persistent autonomous goals for [pi](https://github.com/badlogic/pi-mono).

`pi-goal` adds a `/goal` command and goal tools so Pi can keep working toward a long-running, thread-scoped objective until the goal is complete, paused, cleared, or token-budget-limited.

## Install

```bash
pi install npm:pi-goal
```

Or from git:

```bash
pi install git:github.com/Michaelliv/pi-goal
```

## Usage

```text
/goal improve benchmark coverage until the suite has strong evidence
/goal --tokens 50k finish the migration and verify tests
/goal
/goal status
/goal pause
/goal resume
/goal clear
/goal statusbar off
```

When a goal is active, the extension shows compact visible lifecycle markers like `Goal active` and `Goal continuing`; expand them with `ctrl+o` to inspect the objective and usage. The full continuation instructions ride along as the content of that custom message, so the model always has the objective and audit guidance in the transcript while the renderer keeps the visible UI compact.

The same Pi agent keeps running normal turns in the same session context until it calls `update_goal({ status: "complete" })`, the user pauses/clears it, or the token budget is reached. Reloading Pi pauses an active goal instead of silently resuming it; use `/goal resume` to continue.

If an automatic continuation settles without executing a work tool, the goal pauses for human input instead of starting another turn. The notice and `/goal status` show a short excerpt of the last assistant response, or a fallback when no response text is available. Goal-management calls such as `get_goal` do not count as work. Review the blocker, then use `/goal resume` to try again or `/goal clear` to stop. This guard applies to automatic continuations, not the initial user turn or a native subagent wake.

## What it adds

- `pi-goal-writer` skill: draft and review strong `/goal` objectives with evidence-based success criteria
- `/goal [--tokens 50k] <objective>`: set or replace a goal
- `/goal` or `/goal status`: show the current goal
- `/goal pause`: stop autonomous continuation without deleting the goal
- `/goal resume`: reactivate a paused goal
- `/goal clear`: remove the goal
- `/goal statusbar on|off`: show or hide the footer status line
- `create_goal` tool: model can set or replace the current goal only when explicitly requested
- `get_goal` tool: read current goal state
- `update_goal` tool: model can only mark the goal `complete`; a pending or blocked subagent wait prevents completion
- `goal_wait_for_runs({ runIds })`: suspend goal-generated turns while waiting on exact native async subagent runs
- `get_goal` and `update_goal` are only exposed to the model while a goal is `active`; paused, cleared, complete, and budget-limited goals hide them so unrelated sessions are not tempted to call them
- footer status: `Pursuing goal`, `Goal paused`, `Goal achieved`, or `Goal unmet`

## Flow

```text
/goal <objective>
  -> persist goal in the current Pi session
  -> show compact Goal marker and footer status
  -> deliver continuation instructions as the marker's message content
  -> trigger an agent turn
  -> account time/tokens on turn_end
  -> after agent_settled, pause with a summary if an automatic cycle ran no work tool
  -> otherwise queue another continuation while active and not waiting
  -> stop when update_goal marks complete, user pauses/clears, or budget is hit
```

## Waiting on async subagents

This fork targets Pi 1.6 and the structured notification / v1 status RPC available in `pi-subagents` 0.90. No subagent dependency is needed to run ordinary goals.

Ask the parent to do independent work first, then call `goal_wait_for_runs` with the exact async IDs from its successful `subagent` launch receipts on this session branch. The tool performs a bounded status check and returns; it does **not** block a tool call until the children finish. The persisted barrier suppresses Goal's own continuation turns, not Pi's user messages, supervisor requests, or native completion wakes. A partial batch can wake the parent, but does not release the barrier. A completed batch releases it without sending a second wake. Verify the results before taking dependent actions.

Failed, stopped, paused, partial or rejected results do not count as success. The barrier blocks automatic goal continuation when a required result is unsuccessful. `/goal status` shows pending IDs and observed outcomes. `/goal resume` reconciles the saved IDs: it keeps waiting on live or unverified runs, and lets the operator continue after all runs are terminal (including unsuccessful outcomes). `/goal pause`, `/reload`, and `/goal clear` do not cancel children. Neither waiting nor resuming launches or retries them. If a run's evidence is lost and the wait cannot be reconciled, use `/goal clear` to discard the goal, or explicitly replace it.

## Completion behavior

The model is instructed to audit completion against real evidence before calling `update_goal`. The `update_goal` tool deliberately accepts only `status: "complete"`; pausing, resuming, clearing, and budget limiting are controlled by the user or extension runtime. The final turn is still accounted even when the model completes the goal mid-turn.

## State

Goal state is stored as Pi custom session entries with `customType: "pi-goal"`. It follows the active session branch, survives reloads, and does not require an external database.

## License

MIT
