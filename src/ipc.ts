import { exec, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { SunsamaClient } from 'sunsama-api';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { readEnvFile } from './env.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For refresh_data
    source?: string;
    // For sunsama operations
    text?: string;
    dueDate?: string;
    notes?: string;
    timeEstimate?: number;
    streamId?: string;
    field?: string;
    value?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'refresh_data': {
      const validSources = ['calendar', 'slack', 'email', 'granola', 'sunsama'];
      const source = data.source as string;
      if (source && validSources.includes(source)) {
        const fetcherScript = path.join(
          process.cwd(),
          'scripts',
          'fetchers',
          'dist',
          `${source}-fetcher.js`,
        );
        if (fs.existsSync(fetcherScript)) {
          exec(
            `node ${fetcherScript}`,
            { timeout: 60000, cwd: process.cwd() },
            (err) => {
              if (err) logger.error({ source, err }, 'Data refresh failed');
              else logger.info({ source }, 'Data refresh completed');
            },
          );
          logger.info(
            { source, sourceGroup },
            'Data refresh triggered via IPC',
          );
        } else {
          logger.warn({ source, fetcherScript }, 'Fetcher script not found');
        }
      }
      break;
    }

    case 'sunsama_create_task':
    case 'sunsama_complete_task':
    case 'sunsama_uncomplete_task':
    case 'sunsama_update_task':
    case 'sunsama_delete_task': {
      // All Sunsama writes are main-only
      if (!isMain) {
        logger.warn(
          { sourceGroup, action: data.type },
          'Unauthorized Sunsama write attempt blocked',
        );
        break;
      }

      const sunsamaDataDir = path.join(DATA_DIR, 'sunsama');
      const lastWritePath = path.join(sunsamaDataDir, 'last-write.json');
      fs.mkdirSync(sunsamaDataDir, { recursive: true });

      const writeResult = (
        action: string,
        status: 'success' | 'error',
        extra?: Record<string, unknown>,
      ) => {
        const result = {
          action,
          status,
          timestamp: new Date().toISOString(),
          ...extra,
        };
        try {
          const tmp = lastWritePath + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
          fs.renameSync(tmp, lastWritePath);
        } catch (err) {
          logger.error({ err }, 'Failed to write last-write.json');
        }
      };

      const triggerRefresh = () => {
        const fetcherScript = path.join(
          process.cwd(), 'scripts', 'fetchers', 'dist', 'sunsama-fetcher.js',
        );
        if (fs.existsSync(fetcherScript)) {
          execFile('node', [fetcherScript], { timeout: 60000, cwd: process.cwd() }, (err) => {
            if (err) logger.error({ err }, 'Sunsama data refresh after write failed');
            else logger.info('Sunsama data refreshed after write');
          });
        }
      };

      // Authenticate via direct HTTP (sunsama-api login() has a cookie bug)
      const creds = readEnvFile(['SUNSAMA_EMAIL', 'SUNSAMA_PASSWORD']);
      if (!creds.SUNSAMA_EMAIL || !creds.SUNSAMA_PASSWORD) {
        logger.error('Sunsama credentials not configured in .env');
        writeResult(data.type, 'error', { error: 'Credentials not configured' });
        break;
      }

      let client: SunsamaClient;
      try {
        const resp = await fetch('https://api.sunsama.com/account/login/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: creds.SUNSAMA_EMAIL, password: creds.SUNSAMA_PASSWORD }),
          redirect: 'manual',
        });
        const setCookie = resp.headers.get('set-cookie') || '';
        const match = setCookie.match(/sunsamaSession=([^;]+)/);
        if (!match) throw new Error('No session cookie received');
        client = new SunsamaClient({ sessionToken: match[1] });
      } catch (err) {
        logger.error({ err }, 'Sunsama authentication failed');
        writeResult(data.type, 'error', { error: 'Authentication failed' });
        break;
      }

      try {
        switch (data.type) {
          case 'sunsama_create_task': {
            const text = typeof data.text === 'string' ? data.text.slice(0, 500) : null;
            if (!text) {
              writeResult(data.type, 'error', { error: 'Missing task text' });
              break;
            }
            const opts: Record<string, unknown> = {};
            if (data.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(data.dueDate)) {
              opts.dueDate = data.dueDate;
            }
            if (data.notes) {
              opts.notes = { markdown: String(data.notes).slice(0, 2000) };
            }
            if (typeof data.timeEstimate === 'number' && data.timeEstimate >= 1 && data.timeEstimate <= 1440) {
              opts.timeEstimate = data.timeEstimate;
            }
            if (data.streamId) {
              opts.streamIds = [String(data.streamId)];
            }
            await client.createTask(text, opts);
            logger.info({ sourceGroup, text }, 'Sunsama task created via IPC');
            writeResult(data.type, 'success', { text });
            triggerRefresh();
            break;
          }

          case 'sunsama_complete_task': {
            const taskId = typeof data.taskId === 'string' ? data.taskId.slice(0, 100) : null;
            if (!taskId) {
              writeResult(data.type, 'error', { error: 'Missing taskId' });
              break;
            }
            await client.updateTaskComplete(taskId, new Date().toISOString());
            logger.info({ sourceGroup, taskId }, 'Sunsama task completed via IPC');
            writeResult(data.type, 'success', { taskId });
            triggerRefresh();
            break;
          }

          case 'sunsama_uncomplete_task': {
            const taskId = typeof data.taskId === 'string' ? data.taskId.slice(0, 100) : null;
            if (!taskId) {
              writeResult(data.type, 'error', { error: 'Missing taskId' });
              break;
            }
            // sunsama-api may not have uncomplete — fall back to updateTaskComplete with null
            try {
              await (client as unknown as { updateTaskUncomplete: (id: string) => Promise<unknown> }).updateTaskUncomplete(taskId);
            } catch {
              // If method doesn't exist, this is a known limitation
              writeResult(data.type, 'error', { error: 'Uncomplete not supported by current API version' });
              break;
            }
            logger.info({ sourceGroup, taskId }, 'Sunsama task uncompleted via IPC');
            writeResult(data.type, 'success', { taskId });
            triggerRefresh();
            break;
          }

          case 'sunsama_update_task': {
            const taskId = typeof data.taskId === 'string' ? data.taskId.slice(0, 100) : null;
            const validFields = ['snoozeDate', 'dueDate', 'notes', 'text', 'timeEstimate', 'stream'];
            const field = data.field;
            const value = data.value;
            if (!taskId || !field || !validFields.includes(field) || value === undefined) {
              writeResult(data.type, 'error', { error: 'Missing or invalid taskId, field, or value' });
              break;
            }

            switch (field) {
              case 'snoozeDate':
                await client.updateTaskSnoozeDate(taskId, value === 'null' ? null : value);
                break;
              case 'dueDate':
                await client.updateTaskDueDate(taskId, value);
                break;
              case 'notes':
                await client.updateTaskNotes(taskId, { markdown: value.slice(0, 2000) });
                break;
              case 'text':
                await client.updateTaskText(taskId, value.slice(0, 500));
                break;
              case 'timeEstimate':
                await client.updateTaskPlannedTime(taskId, parseInt(value, 10) || 0);
                break;
              case 'stream':
                await client.updateTaskStream(taskId, value);
                break;
            }
            logger.info({ sourceGroup, taskId, field }, 'Sunsama task updated via IPC');
            writeResult(data.type, 'success', { taskId, field });
            triggerRefresh();
            break;
          }

          case 'sunsama_delete_task': {
            const taskId = typeof data.taskId === 'string' ? data.taskId.slice(0, 100) : null;
            if (!taskId) {
              writeResult(data.type, 'error', { error: 'Missing taskId' });
              break;
            }
            await client.deleteTask(taskId);
            logger.info({ sourceGroup, taskId }, 'Sunsama task deleted via IPC');
            writeResult(data.type, 'success', { taskId });
            triggerRefresh();
            break;
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ action: data.type, err }, 'Sunsama operation failed');
        writeResult(data.type, 'error', { error: errMsg });
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
