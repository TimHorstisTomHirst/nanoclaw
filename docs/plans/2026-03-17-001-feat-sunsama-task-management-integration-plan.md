---
title: "feat: Add Sunsama task management integration"
type: feat
status: active
date: 2026-03-17
---

# Add Sunsama Task Management Integration

## Enhancement Summary

**Deepened on:** 2026-03-17
**Review agents used:** Security Sentinel, Architecture Strategist, Agent-Native Reviewer, Pattern Recognition Specialist, Code Simplicity Reviewer, sunsama-api Researcher, API Resilience Researcher

### Key Improvements
1. **Eliminated unnecessary CLI layer** — `sunsama-actions.ts` removed; IPC handler calls `sunsama-api` directly (saves ~120 LOC, removes command injection risk)
2. **Expanded MCP tool surface** — Added `uncomplete_task`, `delete_task`; extended `update_task` with `timeEstimate` and `stream` fields; added `streamId` to `create_task`
3. **Security hardened** — `execFile()` for fetcher invocation, host-side input validation, main-only authorization on writes, mount allowlist update documented
4. **Write-result feedback** — Action results written to `data/sunsama/last-write.json` so the agent can confirm success/failure
5. **Staleness-based refresh** — Replaced "refresh on every task message" with "refresh only if data >5 min old" to avoid 15-30s delays on every interaction

### New Considerations Discovered
- The `sunsama-api` package is the sole dependency and could break without warning — schema validation on API responses is recommended
- IPC handler's `data` parameter is becoming a god type; discriminated union refactor should follow
- Sunsama streams (projects/categories) are core to the UX; fetcher must capture stream metadata

---

## Overview

Integrate Sunsama as the authoritative task management system for the assistant agent. The agent will read tasks from periodic fetcher syncs, create and complete tasks via IPC-based write operations, help Tom plan his day, and flag at-risk commitments with stakeholder notifications.

Sunsama replaces `_Inbox/tasks.md` as the single source of truth for tasks. The markdown file remains as a fallback if the Sunsama API becomes unavailable.

## Problem Statement / Motivation

The current task management system is a manually-maintained markdown file (`tasks.md`) with no external sync. Tasks extracted from meetings, Slack, and email are only captured when the agent explicitly processes them. There is no bidirectional sync — if Tom completes a task in his actual task planner (Sunsama), the assistant doesn't know. Tom wants the assistant to be an active participant in task management, not just a passive reader.

## Proposed Solution

### Integration Architecture

Follow the established nanoclaw patterns:

- **Reads**: Periodic `sunsama-fetcher.ts` writes to `data/sunsama/`, mounted read-only into the container
- **Writes**: New MCP tools → IPC files → host IPC handler calls `sunsama-api` directly (no CLI intermediary)
- **Auth**: `SUNSAMA_EMAIL` and `SUNSAMA_PASSWORD` in `.env`, used by both fetcher and IPC handler on the host side only (credentials never enter the container)

### API Client

Sunsama has **no official public API**. The integration uses `sunsama-api` (npm, v0.14.0, last updated Feb 2026) — a community-built TypeScript wrapper around Sunsama's internal GraphQL API by Robert Niimi.

**Risk mitigation**: Design the integration so that if the API breaks, the agent falls back to `tasks.md` and informs Tom. Pin the package version. Keep the Sunsama-specific code isolated so it can be swapped out. Validate API response shapes before processing.

## Technical Approach

### 1. Sunsama Fetcher (`scripts/fetchers/src/sunsama-fetcher.ts`)

Follow the existing fetcher pattern (calendar, email, slack, granola).

**Calls to make on each run:**
- `getTasksByDay(today, 'Europe/London')` — today's planned tasks
- `getTasksBacklog()` — unplanned tasks
- `getStreamsByGroupId()` — available streams (projects/categories)
- Filter today's results for `completedAt !== null` → completed tasks

**Output files:**

```
data/sunsama/
  latest.json          # Combined snapshot (today + backlog + completed + streams)
  days/
    index.json         # Available daily files (via mergeDailyArchive)
    YYYY-MM-DD.json    # Daily archive
  state.json           # Last fetch timestamp (via readState/writeState)
```

**`latest.json` schema:**

Note: Sunsama uses `_id` (MongoDB ObjectID, 24 hex chars) for task IDs, and `streamIds` (array). The `getTasksByDay` API returns all tasks (completed + incomplete); filtering is done client-side.

```json
{
  "fetched_at": "2026-03-17T08:00:00.000Z",
  "today": [
    {
      "_id": "65f1a2b3c4d5e6f7a8b9c0d1",
      "text": "Review proposal for Blackstone",
      "notes": "For Colin — committed to delivering by Friday",
      "notesMarkdown": "For Colin — committed to delivering by Friday",
      "dueDate": "2026-03-21",
      "completed": false,
      "completeDate": null,
      "timeEstimate": 60,
      "streamIds": ["65f1a2b3c4d5e6f7a8b9c0d2"],
      "subtasks": [
        { "_id": "sub-1", "text": "Read brief", "completed": false }
      ],
      "createdAt": "2026-03-15T10:00:00.000Z",
      "lastModified": "2026-03-17T08:00:00.000Z"
    }
  ],
  "backlog": [],
  "completed_today": [],
  "streams": [
    { "_id": "65f1a2b3c4d5e6f7a8b9c0d2", "name": "Fifth Dimension" },
    { "_id": "65f1a2b3c4d5e6f7a8b9c0d3", "name": "Personal" }
  ]
}
```

**Implementation details:**
- Use `log()` helper with `[sunsama-fetcher]` prefix (matching slack/granola pattern)
- Use `writeJsonAtomic()` from `shared/writer.ts` for `latest.json`
- Use `mergeDailyArchive()` from `shared/writer.ts` for `days/` directory
- Use `readState()`/`writeState()` from `shared/state.ts` for `state.json` (tracks `last_fetched_at`)
- Use stack-preserving `main().catch()` pattern (matching slack/granola)
- Re-authenticate with email/password on every run via `readEnv(['SUNSAMA_EMAIL', 'SUNSAMA_PASSWORD'])`
- Validate API response shape before writing using Zod `safeParse` with `.passthrough()` (new fields from Sunsama won't break validation, but removed/changed fields will be detected)
- Filter completed tasks client-side: `allTasks.filter(t => t.completed)` — the API returns all tasks for a day

**Auth and error handling:**
The `sunsama-api` package throws typed errors:
- `SunsamaAuthError` — login failures, expired sessions (catch and re-login)
- `SunsamaApiError` — has `.status`, `.isRateLimitError()`, `.isServerError()` helpers
- `SunsamaNetworkError` / `SunsamaTimeoutError` — connectivity issues
- `SunsamaValidationError` — invalid inputs (has `.field` property)

No automatic token refresh exists. On `SunsamaAuthError`, re-authenticate once and retry. On rate limit (429), back off and retry after 60 seconds.

**Schedule:** Every 15 minutes via launchd (matching existing fetchers).

**Dependencies:** Add `sunsama-api` to both `scripts/fetchers/package.json` and root `package.json`. Add `"fetch:sunsama": "node dist/sunsama-fetcher.js"` to fetcher scripts.

### 2. IPC Handler — Direct API Calls (Host Side — `src/ipc.ts`)

**Simplified architecture:** The IPC handler imports `sunsama-api` directly and calls the API from within the host process. No CLI intermediary script. This eliminates command injection risk, removes process-spawning overhead, and reduces the number of files.

Each IPC handler case:
1. Validates inputs (type checks, length limits, format validation)
2. Creates and authenticates a `SunsamaClient` instance
3. Calls the appropriate API method
4. Writes result to `data/sunsama/last-write.json` (success/failure)
5. Triggers the fetcher via `execFile()` (not `exec()`) to refresh data

**New IPC cases:**

```typescript
case 'sunsama_create_task': {
  // Validate: text required (string, max 500 chars), dueDate optional (YYYY-MM-DD), etc.
  // Auth: must be main group only
  // Call: client.createTask(text, { dueDate, notes, timeEstimate, streamIds })
  // Write result: data/sunsama/last-write.json
  // Refresh: execFile('node', [fetcherScript], ...)
}

case 'sunsama_complete_task': {
  // Validate: taskId required (alphanumeric pattern)
  // Call: client.updateTaskComplete(taskId, new Date().toISOString())
}

case 'sunsama_uncomplete_task': {
  // Validate: taskId required
  // Call: client.updateTaskUncomplete(taskId)
}

case 'sunsama_update_task': {
  // Validate: taskId required, field must be in allowlist, value format matches field type
  // Call: appropriate client method based on field
}

case 'sunsama_delete_task': {
  // Validate: taskId required
  // Call: client.deleteTask(taskId)
}
```

**Security requirements:**
- All Sunsama write IPC types gated to `isMain` only
- Host re-validates all inputs independent of container-side Zod schemas
- String lengths capped: text (500), notes (2000), taskId (100)
- Date formats validated: `/^\d{4}-\d{2}-\d{2}$/`
- `field` enum re-validated against allowlist on host
- `timeEstimate` bounded: `1 <= n <= 1440`
- Fetcher invoked via `execFile()` (no shell interpretation), not `exec()`

Add `'sunsama'` to the `validSources` array in the `refresh_data` case.

**Resilience patterns for IPC handler:**
- On `SunsamaAuthError`: re-authenticate once and retry the operation. If auth fails twice, log error and write failure to `last-write.json`.
- On `SunsamaApiError` with `.isRateLimitError()`: log warning, do not retry, write failure.
- On `SunsamaNetworkError`: log error, write failure. Do not retry (the next manual or scheduled operation will try again).
- Validate all API responses with Zod `safeParse` before writing results. Log schema drift events as errors.
- Pin `sunsama-api` to exact version in `package.json` (e.g., `"0.14.0"` not `"^0.14.0"`). Review every update manually.

**API method reference for each IPC case:**

```typescript
// Create: client.createTask(text, { dueDate, notes: { markdown }, timeEstimate, streamIds })
// Complete: client.updateTaskComplete(taskId, new Date().toISOString())
// Uncomplete: NOT in sunsama-api yet — may need direct GraphQL call
// Update snooze: client.updateTaskSnoozeDate(taskId, date) or (taskId, null) for backlog
// Update due: client.updateTaskDueDate(taskId, date)
// Update notes: client.updateTaskNotes(taskId, { markdown: '...' })
// Update text: client.updateTaskText(taskId, text)
// Update time: client.updateTaskPlannedTime(taskId, minutes)
// Update stream: client.updateTaskStream(taskId, streamId)
// Delete: client.deleteTask(taskId)
// Streams: client.getStreamsByGroupId()
```

Mutation responses return `{ success: boolean, updatedTask: Task | null }`. Check `success` before writing to `last-write.json`.

### 3. Write-Result Feedback (`data/sunsama/last-write.json`)

After each write operation, the IPC handler writes a result file:

```json
{
  "action": "sunsama_create_task",
  "status": "success",
  "taskId": "task-abc123",
  "timestamp": "2026-03-17T10:30:00.000Z"
}
```

Or on failure:
```json
{
  "action": "sunsama_create_task",
  "status": "error",
  "error": "Authentication failed",
  "timestamp": "2026-03-17T10:30:00.000Z"
}
```

The agent can read this file after a write to confirm success rather than blindly assuming it worked.

### 4. MCP Tools (Container Side — `ipc-mcp-stdio.ts`)

Add five MCP tools following the existing pattern. All include `groupFolder` and `timestamp` in IPC payloads.

**`sunsama_create_task`**
- Params: `text` (string), `dueDate` (string, optional), `notes` (string, optional), `timeEstimate` (number, optional, minutes), `streamId` (string, optional)
- Writes IPC file with type `sunsama_create_task`
- Response: "Task creation requested. Check last-write.json after 15 seconds to confirm."

**`sunsama_complete_task`**
- Params: `taskId` (string)
- Writes IPC file with type `sunsama_complete_task`
- Response: "Task completion requested."

**`sunsama_uncomplete_task`**
- Params: `taskId` (string)
- Writes IPC file with type `sunsama_uncomplete_task`
- Response: "Task uncomplete requested."

**`sunsama_update_task`**
- Params: `taskId` (string), `field` (enum: `snoozeDate`, `dueDate`, `notes`, `text`, `timeEstimate`, `stream`), `value` (string)
- Writes IPC file with type `sunsama_update_task`
- Response: "Task update requested."

**`sunsama_delete_task`**
- Params: `taskId` (string)
- Writes IPC file with type `sunsama_delete_task`
- Response: "Task deletion requested."

Also add `'sunsama'` to the `refresh_data` source enum.

### 5. Container Access

**Mount:** Add `data/sunsama/` to the assistant group's `additionalMounts`:
```json
{"hostPath": "~/agents/nanoclaw-repo/data/sunsama", "containerPath": "sunsama", "readonly": true}
```

Update via `sqlite3 store/messages.db` (same as other mounts were added).

**Mount allowlist:** Add `~/agents/nanoclaw-repo/data/sunsama` to `~/.config/nanoclaw/mount-allowlist.json` as a read-only allowed root. Without this, the mount will be silently rejected by `validateAdditionalMounts()`.

**Env vars:** No Sunsama credentials in the container. All writes go through IPC → host.

### 6. Launchd Plist (`~/Library/LaunchAgents/com.tom.fetcher-sunsama.plist`)

Follow existing fetcher plist pattern exactly. Created manually (not checked into repo), matching the other fetcher plists. Key settings:
- `StartInterval`: 900 (15 minutes)
- Node binary: absolute path from fnm
- Working directory: nanoclaw-repo root
- Log paths: `logs/fetcher-sunsama.log` and `logs/fetcher-sunsama.error.log`
- `HOME` env var set

### 7. Assistant CLAUDE.md Updates

#### Replace Task Management section with `### Sunsama`

Follow the existing data section heading convention (`### Calendar`, `### Slack`, etc.). Cover:

- **Data files**: `/workspace/extra/sunsama/latest.json` — paths and field descriptions
- **Streams**: explain stream names/IDs from the `streams` array
- **Reading tasks**: how to parse `today`, `backlog`, `completed_today` arrays
- **Creating tasks**: use `mcp__nanoclaw__sunsama_create_task`. Include guidance on extracting text, due date, time estimate, and stream from natural language. Use `streams` array to resolve stream names to IDs.
- **Completing tasks**: use `mcp__nanoclaw__sunsama_complete_task` with `taskId`. Task matching: match description against `text` fields, ask for disambiguation if multiple match, report "no matching task" if none match.
- **Uncompleting tasks**: use `mcp__nanoclaw__sunsama_uncomplete_task` for "actually that's not done yet"
- **Updating tasks**: use `mcp__nanoclaw__sunsama_update_task` for rescheduling (`snoozeDate`), due dates, notes, time estimates, stream changes. For move-to-backlog, use `field: snoozeDate, value: "null"`.
- **Deleting tasks**: use `mcp__nanoclaw__sunsama_delete_task` for "forget that task"
- **Post-write confirmation**: after any write, wait 15 seconds, then read `/workspace/extra/sunsama/last-write.json` to check success. Then read `latest.json` for updated task list.
- **Fallback**: if `fetched_at` in `latest.json` is older than 1 hour, warn Tom about staleness. If file missing/corrupt, fall back to `_Inbox/tasks.md`.

#### Staleness-Based Refresh (replaces proactive refresh)

Instead of refreshing on every task-related message (which adds 15-30s delay):

> Before responding to task-related queries, check `fetched_at` in `latest.json`. If it is older than 5 minutes, call `mcp__nanoclaw__refresh_data(source: 'sunsama')`, wait 15 seconds, then read the updated data. If data is fresh (< 5 minutes), read it directly without refreshing. Always refresh on explicit request ("refresh my tasks").

This avoids unnecessary delays while ensuring data freshness when it matters.

#### Update Data Refresh section

Add `sunsama` to the available sources list.

#### Update Morning Digest format

Replace "TOP PRIORITIES TODAY" sourcing from tasks.md with Sunsama data. Format:

```
*TOP PRIORITIES TODAY (N)*
1. Task text [due: date] [for: stakeholder]
2. Task text; time estimate Xm
3. Task text

*COMMITMENTS AT RISK*
• "Task text" due date; stakeholder may need an update
```

Priorities: (1) overdue, (2) due today, (3) due this week. Within each group, preserve Sunsama ordering.

#### Update End of Day Review

The EOD review reads `latest.json` for completed tasks and remaining items. Suggests what to plan for tomorrow based on backlog and approaching deadlines.

#### Update Ad-hoc Query Handling

Add examples:
- "What are my tasks today?" → read `latest.json` `today` array
- "Add task: call Simon by Thursday" → create in Sunsama
- "Done with the proposal" → find and complete in Sunsama
- "Actually that's not done" → uncomplete the task
- "Delete that task" → delete from Sunsama
- "Plan my day" → show today's tasks, suggest prioritisation
- "Move X to Thursday" → update snooze date
- "That'll take 90 minutes" → update time estimate
- "Put that under Personal" → update stream
- "What's overdue?" → filter tasks past due date
- "Refresh my tasks" → trigger sunsama fetcher

### 8. Credentials in `.env`

Add to `.env`:
```
SUNSAMA_EMAIL=tom@example.com
SUNSAMA_PASSWORD=...
```

Ensure this password is unique and not reused for other services.

## System-Wide Impact

- **Interaction graph**: Agent writes IPC file → host reads IPC → host authenticates with Sunsama → host calls API → host writes `last-write.json` → host triggers fetcher via `execFile()` → fetcher writes to `data/sunsama/` → agent reads data files
- **Error propagation**: API auth failure → IPC handler logs error, writes failure to `last-write.json`. Fetcher auth failure → fetcher exits non-zero, `latest.json` stays stale. Agent detects staleness via `fetched_at` timestamp and can read `last-write.json` for write failures.
- **State lifecycle risks**: A failed write is logged and recorded in `last-write.json`. The agent's data is eventually consistent (15 min max staleness from scheduled fetcher, but writes trigger immediate refresh). A write that succeeds at Sunsama but fails to refresh locally means temporary inconsistency until the next scheduled fetcher run.
- **API surface parity**: The `refresh_data` IPC type gains a new valid source. Five new IPC types and five new MCP tools added. All gated to main group only.

## Acceptance Criteria

- [ ] `sunsama-fetcher.ts` syncs today's tasks, backlog, completed items, and streams to `data/sunsama/latest.json`
- [ ] Fetcher uses `mergeDailyArchive`, `readState`/`writeState`, and `writeJsonAtomic` shared modules
- [ ] Fetcher runs every 15 minutes via launchd and writes fresh data
- [ ] Agent can create a task in Sunsama via `sunsama_create_task` MCP tool (with optional stream)
- [ ] Agent can mark a task complete via `sunsama_complete_task` MCP tool
- [ ] Agent can uncomplete a task via `sunsama_uncomplete_task` MCP tool
- [ ] Agent can reschedule, update due date, notes, text, time estimate, and stream via `sunsama_update_task`
- [ ] Agent can delete a task via `sunsama_delete_task` MCP tool
- [ ] After each write, `last-write.json` records success/failure
- [ ] After each write, fetcher runs automatically to refresh data
- [ ] Morning digest includes Sunsama tasks in TOP PRIORITIES section
- [ ] Agent uses staleness-based refresh (>5 min old → refresh before responding)
- [ ] Agent warns Tom when Sunsama data is stale (>1 hour old)
- [ ] Agent falls back to `tasks.md` when `latest.json` is missing or corrupt
- [ ] All Sunsama write IPC types gated to `isMain` only
- [ ] Host-side input validation on all IPC fields (type, length, format)
- [ ] Fetcher invoked via `execFile()`, not `exec()`
- [ ] `npm run build` passes with no TypeScript errors
- [ ] Sunsama credentials stay on the host (never in container env)
- [ ] Mount allowlist updated to include `data/sunsama`

## Success Metrics

- Tom uses the assistant for daily task planning instead of opening Sunsama directly
- Tasks created via WhatsApp appear in Sunsama within 30 seconds
- Morning digest accurately reflects today's Sunsama tasks
- Commitment warnings help Tom proactively communicate delays

## Dependencies & Risks

**Dependencies:**
- `sunsama-api` npm package (v0.14.0) — community-maintained, reverse-engineered
- Sunsama account with email/password auth (no SSO)
- Mount allowlist must cover `~/agents/nanoclaw-repo/data/sunsama`

**Risks:**

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sunsama changes internal API, breaking `sunsama-api` | Medium | High | Pin version, validate response shapes, fallback to tasks.md, monitor package updates |
| Single maintainer abandons `sunsama-api` | Low | High | Fork the package, the GraphQL queries are documented in source |
| Session auth expires mid-operation | Medium | Low | Re-authenticate per operation, clear error logging |
| Rate limiting on undocumented API | Low | Medium | Conservative 15-min sync interval, no parallel calls |
| ToS violation using reverse-engineered API | Low | Medium | Monitor Sunsama's stance, consider reaching out to them |
| Supply-chain attack on `sunsama-api` | Low | High | Pin version, use `npm audit`, ensure Sunsama password is unique |

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `scripts/fetchers/src/sunsama-fetcher.ts` | Create | Periodic fetcher following existing pattern |
| `scripts/fetchers/package.json` | Modify | Add `sunsama-api` dependency + `fetch:sunsama` script |
| `package.json` | Modify | Add `sunsama-api` dependency (for IPC handler) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Modify | Add 5 MCP tools + sunsama to refresh_data enum |
| `src/ipc.ts` | Modify | Add 5 IPC handler cases + sunsama to validSources + input validation |
| `groups/assistant/CLAUDE.md` | Modify | Replace task management, update digest, add Sunsama data docs |
| `~/Library/LaunchAgents/com.tom.fetcher-sunsama.plist` | Create | Launchd plist for 15-min fetcher (manual, not in repo) |
| `~/.config/nanoclaw/mount-allowlist.json` | Modify | Add `data/sunsama` as read-only allowed root |
| `.env` | Modify | Add `SUNSAMA_EMAIL`, `SUNSAMA_PASSWORD` |

## Migration Plan

One-time migration of existing `_Inbox/tasks.md` tasks to Sunsama:

1. Read current `tasks.md` active items
2. For each task, create in Sunsama with: text from task description, due date from `[due:]` field, notes containing `[source:]` and `[committed:]` metadata
3. Verify all tasks appear in Sunsama
4. Update assistant CLAUDE.md to use Sunsama as primary source
5. Keep `tasks.md` as read-only fallback (stop writing to it)

This can be done manually or as an agent-assisted process after the integration is live.

## v1 Prioritisation Heuristic

Starting framework (to be refined with Tom over time):

1. **Overdue** — past due date, always surface first
2. **Due today** — hard deadlines landing today
3. **Due this week** — approaching deadlines
4. **Planned today (no deadline)** — tasks Tom chose to work on today
5. **Backlog** — only surface if Tom asks

Within each group, preserve Sunsama's ordering.

## Follow-up Work (Post-v1)

- Refactor `processTaskIpc` data parameter to a discriminated union type
- Add subtask operations (`add_subtask`, `complete_subtask`) if Tom uses them
- Add `tomorrow` tasks to fetcher output if EOD planning needs it
- Consider auth token caching (like `google-tokens.json`) to reduce API calls
- Consider renaming `scripts/fetchers/` to `scripts/integrations/` once write operations are established pattern

## Sources & References

- [sunsama-api on npm](https://www.npmjs.com/package/sunsama-api) — community API wrapper (v0.14.0)
- [sunsama-api on GitHub](https://github.com/robertn702/sunsama-api) — source, docs, examples
- [Sunsama API roadmap request](https://roadmap.sunsama.com/improvements/p/sunsama-api) — 862 votes, no official commitment
- Existing fetcher pattern: `scripts/fetchers/src/calendar-fetcher.ts`
- Existing IPC pattern: `src/ipc.ts` (`refresh_data` case)
- Existing MCP tools: `container/agent-runner/src/ipc-mcp-stdio.ts`
- Existing mount security: `src/mount-security.ts`
- Assistant CLAUDE.md: `groups/assistant/CLAUDE.md`
