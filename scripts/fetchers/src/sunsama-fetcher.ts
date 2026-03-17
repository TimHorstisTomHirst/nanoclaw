/**
 * sunsama-fetcher.ts
 *
 * Fetches Sunsama tasks (today, backlog, completed) and streams,
 * writes a structured JSON snapshot to data/sunsama/latest.json.
 *
 * Stdout  → unused
 * Stderr  → progress / diagnostic logging (captured by launchd)
 */

import path from 'path';
import { SunsamaClient } from 'sunsama-api';
import { readEnv, DATA_DIR } from './shared/config.js';
import { readState, writeState } from './shared/state.js';
import { writeJsonAtomic, mergeDailyArchive } from './shared/writer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SunsamaState {
  last_fetched_at?: string;
}

/** Trimmed task shape written to latest.json */
interface OutputTask {
  _id: string;
  text: string;
  notes: string;
  notesMarkdown: string | null;
  dueDate: string | null;
  completed: boolean;
  completeDate: string | null;
  timeEstimate: number | null;
  streamIds: string[];
  subtasks: Array<{ _id: string; text: string; completed: boolean }>;
  createdAt: string;
  lastModified: string;
}

interface OutputStream {
  _id: string;
  name: string;
}

interface Output {
  fetched_at: string;
  today: OutputTask[];
  backlog: OutputTask[];
  completed_today: OutputTask[];
  streams: OutputStream[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUNSAMA_DIR = path.join(DATA_DIR, 'sunsama');
const STATE_PATH = path.join(SUNSAMA_DIR, 'state.json');
const OUTPUT_PATH = path.join(SUNSAMA_DIR, 'latest.json');
const TIMEZONE = 'Europe/London';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  process.stderr.write('[sunsama-fetcher] ' + args.join(' ') + '\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimTask(raw: Record<string, unknown>): OutputTask {
  const subtasks = Array.isArray(raw.subtasks)
    ? (raw.subtasks as Array<Record<string, unknown>>).map((s) => ({
        _id: String(s._id ?? ''),
        text: String(s.text ?? ''),
        completed: Boolean(s.completed),
      }))
    : [];

  return {
    _id: String(raw._id ?? ''),
    text: String(raw.text ?? ''),
    notes: String(raw.notes ?? ''),
    notesMarkdown: raw.notesMarkdown != null ? String(raw.notesMarkdown) : null,
    dueDate: raw.dueDate != null ? String(raw.dueDate) : null,
    completed: Boolean(raw.completed),
    completeDate: raw.completeDate != null ? String(raw.completeDate) : null,
    timeEstimate: typeof raw.timeEstimate === 'number' ? raw.timeEstimate : null,
    streamIds: Array.isArray(raw.streamIds) ? raw.streamIds.map(String) : [],
    subtasks,
    createdAt: String(raw.createdAt ?? ''),
    lastModified: String(raw.lastModified ?? ''),
  };
}

function todayString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

/**
 * Authenticate with Sunsama via direct HTTP call and return a session token.
 * The sunsama-api library's login() has a bug with cookie capture on 302
 * redirects, so we authenticate manually and pass the token to the client.
 */
async function getSessionToken(email: string, password: string): Promise<string> {
  const resp = await fetch('https://api.sunsama.com/account/login/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',  // Don't follow redirect — we need the Set-Cookie header
  });

  const setCookie = resp.headers.get('set-cookie') || '';
  const match = setCookie.match(/sunsamaSession=([^;]+)/);
  if (!match) {
    throw new Error(`No session cookie received. Status: ${resp.status}`);
  }
  return match[1];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('Starting...');

  // --- Auth ---
  const creds = readEnv(['SUNSAMA_EMAIL', 'SUNSAMA_PASSWORD']);
  if (!creds.SUNSAMA_EMAIL || !creds.SUNSAMA_PASSWORD) {
    log('FATAL: SUNSAMA_EMAIL and SUNSAMA_PASSWORD must be set in .env');
    process.exit(1);
  }

  let sessionToken: string;
  try {
    sessionToken = await getSessionToken(creds.SUNSAMA_EMAIL, creds.SUNSAMA_PASSWORD);
  } catch (err) {
    log('FATAL: Authentication failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const client = new SunsamaClient({ sessionToken });
  log('Authenticated.');

  // --- Read state ---
  const state = readState<SunsamaState>(STATE_PATH);

  // --- Fetch today's tasks ---
  const today = todayString();
  log(`Fetching tasks for ${today}...`);

  let allTodayTasks: Record<string, unknown>[];
  try {
    allTodayTasks = (await client.getTasksByDay(today, TIMEZONE)) as unknown as Record<string, unknown>[];
  } catch (err) {
    log('ERROR fetching today tasks:', err instanceof Error ? err.message : String(err));
    allTodayTasks = [];
  }

  const todayIncomplete = allTodayTasks.filter((t) => !t.completed).map(trimTask);
  const todayCompleted = allTodayTasks.filter((t) => t.completed).map(trimTask);
  log(`Got ${todayIncomplete.length} active, ${todayCompleted.length} completed for today.`);

  // --- Fetch backlog ---
  log('Fetching backlog...');
  let backlogRaw: Record<string, unknown>[];
  try {
    backlogRaw = (await client.getTasksBacklog()) as unknown as Record<string, unknown>[];
  } catch (err) {
    log('ERROR fetching backlog:', err instanceof Error ? err.message : String(err));
    backlogRaw = [];
  }
  const backlog = backlogRaw.map(trimTask);
  log(`Got ${backlog.length} backlog task(s).`);

  // --- Fetch streams ---
  log('Fetching streams...');
  let streams: OutputStream[] = [];
  try {
    const rawStreams = (await (client as unknown as { getStreamsByGroupId: () => Promise<unknown[]> }).getStreamsByGroupId()) as Array<Record<string, unknown>>;
    streams = rawStreams.map((s) => ({
      _id: String(s._id ?? ''),
      name: String(s.name ?? ''),
    }));
  } catch (err) {
    log('WARN: Could not fetch streams:', err instanceof Error ? err.message : String(err));
  }
  log(`Got ${streams.length} stream(s).`);

  // --- Build output ---
  const output: Output = {
    fetched_at: new Date().toISOString(),
    today: todayIncomplete,
    backlog,
    completed_today: todayCompleted,
    streams,
  };

  // --- Write latest snapshot ---
  writeJsonAtomic(OUTPUT_PATH, output);
  log(`Wrote ${OUTPUT_PATH}`);

  // --- Write daily archives ---
  const allTasks = [...todayIncomplete, ...todayCompleted, ...backlog];
  if (allTasks.length > 0) {
    const daysDir = path.join(SUNSAMA_DIR, 'days');
    mergeDailyArchive(
      daysDir,
      allTasks,
      (task) => task.createdAt ? new Date(task.createdAt) : new Date(),
      (task) => task._id,
    );
    log(`Updated daily archives.`);
  }

  // --- Persist state ---
  state.last_fetched_at = new Date().toISOString();
  writeState(STATE_PATH, state);

  log('Done.');
}

main().catch((err) => {
  process.stderr.write('[sunsama-fetcher] FATAL: ' + (err instanceof Error ? err.stack : String(err)) + '\n');
  process.exit(1);
});
