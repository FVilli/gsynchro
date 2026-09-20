#!/usr/bin/env node

import chokidar, { type FSWatcher } from 'chokidar';
import fg from 'fast-glob';
import YAML from 'yaml';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type Side = 'repo' | 'drive';

interface Config {
  destination: string;
  debounce?: number;
  items: string[];
}

interface FileSnapshot {
  hash: string;
  size: number;
  mtimeMs: number;
}

interface StatusEntry {
  commonHash: string | null;
  repo: FileSnapshot | null;
  drive: FileSnapshot | null;
}

interface StatusFile {
  version: 1;
  files: Record<string, StatusEntry>;
}

interface FsEvent {
  side: Side;
  type: string;
  path: string;
  timestamp: number;
}

interface CurrentState {
  repo: Map<string, FileSnapshot>;
  drive: Map<string, FileSnapshot>;
}

type SyncOperation =
  | {
      type: 'copy';
      from: Side;
      to: Side;
      path: string;
      reason: string;
    }
  | {
      type: 'delete';
      side: Side;
      path: string;
      reason: string;
    };

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const DEBUG = process.argv.slice(2).includes('--debug');

const ALLOWED_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
]);

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.gsynchro',
  '.trash',
]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const CONFIG_PATH = path.join(SCRIPT_DIR, 'gsynchro.yml');
const STATUS_PATH = path.join(SCRIPT_DIR, 'gsynchro.status');

const REPO_TRASH = path.join(REPO_ROOT, '.trash');

let config: Config;
let DRIVE_ROOT = '';
let DRIVE_TRASH = '';

let repoWatcher: FSWatcher | undefined;
let driveWatcher: FSWatcher | undefined;

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let reconcileRunning = false;
let reconcilePending = false;

let eventQueue: FsEvent[] = [];

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function debug(message: string, details?: unknown): void {
  if (DEBUG) {
    console.log(`[gsynchro DEBUG ${new Date().toISOString()}] ${message}`, details ?? '');
  }
}

function normalizeRelative(filePath: string): string {
  return filePath
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
}

function sideRoot(side: Side): string {
  return side === 'repo'
    ? REPO_ROOT
    : DRIVE_ROOT;
}

function trashRoot(side: Side): string {
  return side === 'repo'
    ? REPO_TRASH
    : DRIVE_TRASH;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return (
    relative !== '' &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

function isAllowedRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath);

  if (!normalized) {
    return false;
  }

  const segments = normalized.split('/');

  if (
    segments.some((segment) =>
      EXCLUDED_DIRECTORIES.has(segment),
    )
  ) {
    return false;
  }

  const extension = path
    .extname(normalized)
    .toLowerCase();

  return ALLOWED_EXTENSIONS.has(extension);
}

function snapshotsEqual(
  a: FileSnapshot | null | undefined,
  b: FileSnapshot | null | undefined,
): boolean {
  if (!a && !b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  return a.hash === b.hash;
}

function hashEqual(
  snapshot: FileSnapshot | null | undefined,
  hash: string | null,
): boolean {
  if (!snapshot && hash === null) {
    return true;
  }

  if (!snapshot || hash === null) {
    return false;
  }

  return snapshot.hash === hash;
}

function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 10);
}

function formatTimestamp(date = new Date()): string {
  const pad = (value: number) =>
    String(value).padStart(2, '0');

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

async function loadConfig(): Promise<Config> {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const parsed = YAML.parse(raw) as Partial<Config>;

  if (
    typeof parsed.destination !== 'string' ||
    !parsed.destination.trim()
  ) {
    throw new Error(
      'gsynchro.yml: "destination" is required',
    );
  }

  if (
    !Array.isArray(parsed.items) ||
    parsed.items.length === 0 ||
    parsed.items.some(
      (item) => typeof item !== 'string',
    )
  ) {
    throw new Error(
      'gsynchro.yml: "items" must be a non-empty string array',
    );
  }

  if (
    parsed.debounce !== undefined &&
    (
      typeof parsed.debounce !== 'number' ||
      parsed.debounce < 0
    )
  ) {
    throw new Error(
      'gsynchro.yml: "debounce" must be >= 0',
    );
  }

  return {
    destination: path.resolve(parsed.destination),
    debounce: parsed.debounce ?? 3,
    items: parsed.items.map(normalizeRelative),
  };
}

async function validateRoots(): Promise<void> {
  if (DRIVE_ROOT === REPO_ROOT) {
    throw new Error(
      'Destination cannot be the repository root',
    );
  }

  if (
    isPathInside(REPO_ROOT, DRIVE_ROOT) ||
    isPathInside(DRIVE_ROOT, REPO_ROOT)
  ) {
    throw new Error(
      'Repository and destination cannot contain each other',
    );
  }

  await access(REPO_ROOT);

  /*
   * Deliberately do NOT create DRIVE_ROOT here.
   *
   * If Google Drive is unmounted, silently recreating the mount-point
   * as a normal local directory would be dangerous.
   */
  await access(DRIVE_ROOT);

  const repoStat = await stat(REPO_ROOT);
  const driveStat = await stat(DRIVE_ROOT);

  if (!repoStat.isDirectory()) {
    throw new Error(
      `Repository root is not a directory: ${REPO_ROOT}`,
    );
  }

  if (!driveStat.isDirectory()) {
    throw new Error(
      `Destination is not a directory: ${DRIVE_ROOT}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Persistent status                                                          */
/* -------------------------------------------------------------------------- */

async function loadStatus(): Promise<StatusFile> {
  try {
    const raw = await readFile(STATUS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as StatusFile;

    if (
      parsed.version !== 1 ||
      !parsed.files ||
      typeof parsed.files !== 'object'
    ) {
      throw new Error(
        'Unsupported or invalid gsynchro.status',
      );
    }

    return parsed;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return {
        version: 1,
        files: {},
      };
    }

    throw error;
  }
}

async function saveStatus(
  statusFile: StatusFile,
): Promise<void> {
  const tmpPath = `${STATUS_PATH}.tmp`;

  await writeFile(
    tmpPath,
    `${JSON.stringify(statusFile, null, 2)}\n`,
    'utf8',
  );

  await rename(tmpPath, STATUS_PATH);
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* -------------------------------------------------------------------------- */

async function hashFile(
  absolutePath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);

    stream.on('error', reject);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(`sha256:${hash.digest('hex')}`);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Scanning                                                                   */
/* -------------------------------------------------------------------------- */

async function scanSide(
  side: Side,
): Promise<Map<string, FileSnapshot>> {
  const root = sideRoot(side);

  /*
   * fast-glob does the configured path filtering.
   * The fixed safety rules below are applied independently.
   */
  const candidates = await fg(config.items, {
    cwd: root,
    onlyFiles: true,
    unique: true,
    dot: true,
    followSymbolicLinks: false,

    ignore: [
      '**/.git/**',
      '**/node_modules/**',
      '**/.gsynchro/**',
      '**/.trash/**',
    ],
  });

  const result = new Map<string, FileSnapshot>();

  for (const candidate of candidates) {
    const relativePath = normalizeRelative(candidate);

    if (!isAllowedRelativePath(relativePath)) {
      continue;
    }

    const absolutePath = path.join(
      root,
      relativePath,
    );

    let info;

    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        'ENOENT'
      ) {
        continue;
      }

      throw error;
    }

    if (
      !info.isFile() ||
      info.isSymbolicLink()
    ) {
      continue;
    }

    /*
     * Files outside the safety scope are invisible to the sync engine.
     * They are therefore not interpreted as deletions.
     */
    if (info.size > MAX_FILE_SIZE) {
      console.warn(
        `SKIP  ${side.toUpperCase()} ${relativePath} ` +
        `(${(info.size / 1024 / 1024).toFixed(2)} MiB > 10 MiB)`,
      );
      continue;
    }

    result.set(relativePath, {
      hash: await hashFile(absolutePath),
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }

  return result;
}

async function scanCurrentState(): Promise<CurrentState> {
  /*
   * Validate both roots BEFORE interpreting any absence as a delete.
   */
  await validateRoots();

  const [repo, drive] = await Promise.all([
    scanSide('repo'),
    scanSide('drive'),
  ]);

  return {
    repo,
    drive,
  };
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                             */
/* -------------------------------------------------------------------------- */

function buildSyncPlan(
  previousStatus: StatusFile,
  current: CurrentState,
): SyncOperation[] {
  const operations: SyncOperation[] = [];

  const allPaths = new Set<string>([
    ...Object.keys(previousStatus.files),
    ...current.repo.keys(),
    ...current.drive.keys(),
  ]);

  for (const relativePath of allPaths) {
    const previous =
      previousStatus.files[relativePath];

    const repo =
      current.repo.get(relativePath) ?? null;

    const drive =
      current.drive.get(relativePath) ?? null;

    /*
     * Already equal (including both absent).
     */
    if (snapshotsEqual(repo, drive)) {
      continue;
    }

    /*
     * No previous state:
     *
     * - only repo   -> repo wins/copy to Drive
     * - only Drive  -> import into repo
     * - both differ -> repo wins
     */
    if (!previous) {
      if (repo && !drive) {
        operations.push({
          type: 'copy',
          from: 'repo',
          to: 'drive',
          path: relativePath,
          reason: 'new on repository',
        });

        continue;
      }

      if (!repo && drive) {
        operations.push({
          type: 'copy',
          from: 'drive',
          to: 'repo',
          path: relativePath,
          reason: 'new on Drive',
        });

        continue;
      }

      if (repo && drive) {
        operations.push({
          type: 'copy',
          from: 'repo',
          to: 'drive',
          path: relativePath,
          reason: 'initial conflict, repository wins',
        });
      }

      continue;
    }

    const previousHash =
      previous.commonHash;

    const repoUnchanged =
      hashEqual(repo, previousHash);

    const driveUnchanged =
      hashEqual(drive, previousHash);

    const repoChanged = !repoUnchanged;
    const driveChanged = !driveUnchanged;

    /*
     * Only Drive changed.
     */
    if (
      !repoChanged &&
      driveChanged
    ) {
      if (drive) {
        operations.push({
          type: 'copy',
          from: 'drive',
          to: 'repo',
          path: relativePath,
          reason: 'changed on Drive',
        });
      } else {
        operations.push({
          type: 'delete',
          side: 'repo',
          path: relativePath,
          reason: 'deleted on Drive',
        });
      }

      continue;
    }

    /*
     * Only repository changed.
     */
    if (
      repoChanged &&
      !driveChanged
    ) {
      if (repo) {
        operations.push({
          type: 'copy',
          from: 'repo',
          to: 'drive',
          path: relativePath,
          reason: 'changed on repository',
        });
      } else {
        operations.push({
          type: 'delete',
          side: 'drive',
          path: relativePath,
          reason: 'deleted on repository',
        });
      }

      continue;
    }

    /*
     * Both sides changed.
     *
     * Repository always wins.
     */
    if (repoChanged && driveChanged) {
      if (repo) {
        operations.push({
          type: 'copy',
          from: 'repo',
          to: 'drive',
          path: relativePath,
          reason: 'conflict, repository wins',
        });
      } else if (drive) {
        operations.push({
          type: 'delete',
          side: 'drive',
          path: relativePath,
          reason:
            'delete/modify conflict, repository deletion wins',
        });
      }
    }
  }

  return operations;
}

/* -------------------------------------------------------------------------- */
/* Filesystem operations                                                      */
/* -------------------------------------------------------------------------- */

async function copyBetweenSides(
  from: Side,
  to: Side,
  relativePath: string,
): Promise<void> {
  const source = path.join(
    sideRoot(from),
    relativePath,
  );

  const destination = path.join(
    sideRoot(to),
    relativePath,
  );

  /*
   * Re-check the source immediately before copying.
   */
  const sourceInfo = await lstat(source);

  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink()
  ) {
    throw new Error(
      `Source is no longer a regular file: ${relativePath}`,
    );
  }

  if (sourceInfo.size > MAX_FILE_SIZE) {
    throw new Error(
      `Source became larger than 10 MiB: ${relativePath}`,
    );
  }

  await mkdir(
    path.dirname(destination),
    { recursive: true },
  );

  /*
   * Copy to temporary file first, then atomically replace destination.
   */
  const temporary =
    `${destination}.gsynchro-tmp-${process.pid}`;

  await copyFile(source, temporary);
  await rename(temporary, destination);
}

async function moveToTrash(
  side: Side,
  relativePath: string,
): Promise<void> {
  const source = path.join(
    sideRoot(side),
    relativePath,
  );

  try {
    await access(source);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code ===
      'ENOENT'
    ) {
      return;
    }

    throw error;
  }

  const snapshotHash = await hashFile(source);

  const originalName = path.basename(relativePath);
  const extension = path.extname(originalName);
  const basename = path.basename(
    originalName,
    extension,
  );

  const trash = trashRoot(side);

  await mkdir(trash, {
    recursive: true,
  });

  const trashName =
    `${formatTimestamp()}-${basename}-${shortHash(snapshotHash)}${extension}`;

  const destination = path.join(
    trash,
    trashName,
  );

  try {
    /*
     * rename() is cheap and atomic when source and trash are
     * on the same filesystem, which they normally are here.
     */
    await rename(source, destination);
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException).code;

    /*
     * Fallback for unusual filesystem/mount boundaries.
     */
    if (code !== 'EXDEV') {
      throw error;
    }

    await copyFile(source, destination);

    /*
     * Cannot use rm() if we want the deletion semantics here
     * without importing another function, so rename fallback
     * across devices is not expected in normal usage.
     */
    throw new Error(
      `Cross-device trash move is not supported for ${relativePath}`,
    );
  }
}

async function executePlan(
  operations: SyncOperation[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.type === 'copy') {
      if (
        operation.reason.includes('conflict')
      ) {
        console.warn(
          `CONFLICT ${operation.path} - repository wins`,
        );
      }

      console.log(
        `SYNC  ${operation.from.padEnd(5)} -> ${operation.to.padEnd(5)} ` +
        `${operation.path} (${operation.reason})`,
      );

      await copyBetweenSides(
        operation.from,
        operation.to,
        operation.path,
      );

      continue;
    }

    console.log(
      `TRASH ${operation.side.padEnd(5)}    ${operation.path} ` +
      `(${operation.reason})`,
    );

    await moveToTrash(
      operation.side,
      operation.path,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Status generation                                                          */
/* -------------------------------------------------------------------------- */

function buildStatusFromState(
  state: CurrentState,
): StatusFile {
  const files: Record<string, StatusEntry> = {};

  const allPaths = new Set<string>([
    ...state.repo.keys(),
    ...state.drive.keys(),
  ]);

  for (const relativePath of allPaths) {
    const repo =
      state.repo.get(relativePath) ?? null;

    const drive =
      state.drive.get(relativePath) ?? null;

    /*
     * After a successful reconciliation these should normally match.
     *
     * If they do not, commonHash remains null rather than pretending
     * that a common state exists.
     */
    const commonHash =
      repo &&
      drive &&
      repo.hash === drive.hash
        ? repo.hash
        : null;

    files[relativePath] = {
      commonHash,
      repo,
      drive,
    };
  }

  return {
    version: 1,
    files,
  };
}

/* -------------------------------------------------------------------------- */
/* Main reconciliation                                                        */
/* -------------------------------------------------------------------------- */

async function reconcile(): Promise<void> {
  if (reconcileRunning) {
    debug('RECONCILE deferred: reconciliation already running');
    reconcilePending = true;
    return;
  }

  reconcileRunning = true;

  const events = eventQueue;
  eventQueue = [];

  try {
    console.log('');
    console.log(
      `[gsynchro] reconcile ${new Date().toLocaleTimeString()}`,
    );

    if (events.length > 0) {
      for (const event of events) {
        console.log(
          `EVENT ${event.side.toUpperCase().padEnd(5)} ` +
          `${event.type.padEnd(9)} ${event.path}`,
        );
      }
    }

    const previousStatus =
      await loadStatus();

    /*
     * If this scan fails, no filesystem operation and no status write occur.
     */
    const before =
      await scanCurrentState();

    const plan = buildSyncPlan(
      previousStatus,
      before,
    );

    debug('RECONCILE scan result', {
      repoFiles: before.repo.size,
      driveFiles: before.drive.size,
      operations: plan,
    });

    if (plan.length === 0) {
      /*
       * Even without actions, refreshing the status is useful on first run.
       */
      await saveStatus(
        buildStatusFromState(before),
      );

      console.log(
        '[gsynchro] already synchronized',
      );

      return;
    }

    await executePlan(plan);

    /*
     * Verification scan.
     *
     * Do not trust the intended result: observe the filesystems again.
     */
    const after =
      await scanCurrentState();

    const verificationPlan =
      buildSyncPlan(
        buildStatusFromState(after),
        after,
      );

    if (verificationPlan.length !== 0) {
      throw new Error(
        'Synchronization verification failed',
      );
    }

    /*
     * Status is saved only after all filesystem operations succeeded
     * and both roots could be scanned again.
     */
    await saveStatus(
      buildStatusFromState(after),
    );

    console.log(
      `[gsynchro] sync completed (${plan.length} operation${
        plan.length === 1 ? '' : 's'
      })`,
    );
  } catch (error) {
    console.error(
      '[gsynchro] reconciliation failed:',
      error instanceof Error
        ? error.message
        : error,
    );
  } finally {
    reconcileRunning = false;

    if (reconcilePending) {
      reconcilePending = false;
      scheduleReconcile();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Watchers                                                                   */
/* -------------------------------------------------------------------------- */

function queueEvent(
  side: Side,
  type: string,
  filePath: string,
): void {
  const relativePath =
    normalizeRelative(filePath);

  /*
   * The watchers may observe directories too.
   * Fixed exclusions are applied immediately.
   */
  const segments = relativePath.split('/');

  if (
    segments.some((segment) =>
      EXCLUDED_DIRECTORIES.has(segment),
    )
  ) {
    debug(`QUEUE ${side.toUpperCase()} ignored: ${type} ${relativePath}`);
    return;
  }

  eventQueue.push({
    side,
    type,
    path: relativePath,
    timestamp: Date.now(),
  });

  debug(`QUEUE ${side.toUpperCase()} ${type} ${relativePath}`, { pendingEvents: eventQueue.length });
  scheduleReconcile();
}

function scheduleReconcile(): void {
  debug(`DEBOUNCE ${debounceTimer ? 'reset' : 'scheduled'}`, { seconds: config.debounce ?? 3 });
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    debug('DEBOUNCE elapsed', { reconcileRunning });

    if (reconcileRunning) {
      reconcilePending = true;
      return;
    }

    void reconcile();
  }, (config.debounce ?? 3) * 1000);
}

function createWatcher(
  side: Side,
): FSWatcher {
  const root = sideRoot(side);
  debug(`WATCH ${side.toUpperCase()} starting`, {
    root,
    usePolling: side === 'drive',
    interval: 1000,
    ignoreInitial: true,
    items: config.items,
  });

  const watcher = chokidar.watch(
    '.',
    {
      cwd: root,

      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: side === 'drive',
      interval: 1000,

      /*
       * Useful especially with editors that write through
       * temporary files and with cloud-drive clients.
       */
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },

      // Chokidar 5 accepts paths, not globs. fast-glob applies config.items
      // during reconciliation; prune excluded directories here.
      ignored: (filePath, info) => {
        const relativePath = path.relative(root, path.resolve(root, filePath));
        const ignored = normalizeRelative(relativePath).split('/').some(
          (segment) => EXCLUDED_DIRECTORIES.has(segment),
        ) || (info?.isFile() === true && !isAllowedRelativePath(relativePath));
        if (ignored) {
          debug(`FILTER ${side.toUpperCase()} ignored: ${relativePath}`);
        }
        return ignored;
      },
    },
  );

  watcher.on(
    'all',
    (
      eventName,
      filePath,
    ) => {
      debug(`EVENT ${side.toUpperCase()} ${eventName} ${String(filePath)}`);
      switch (eventName) {
        case 'add':
        case 'change':
        case 'unlink':
        case 'addDir':
        case 'unlinkDir':
          queueEvent(
            side,
            eventName,
            String(filePath),
          );
          break;
      }
    },
  );

  if (DEBUG) {
    watcher.on('raw', (eventName, filePath, details) => {
      debug(`RAW ${side.toUpperCase()} ${eventName} ${String(filePath)}`, details);
    });

    watcher.on('ready', () => {
      debug(`READY ${side.toUpperCase()} initial scan complete; watched entries`, watcher.getWatched());
    });
  }

  watcher.on('error', (error) => {
    console.error(
      `[gsynchro] ${side} watcher error:`,
      error,
    );
  });

  return watcher;
}

/* -------------------------------------------------------------------------- */
/* Shutdown                                                                   */
/* -------------------------------------------------------------------------- */

async function shutdown(
  signal: string,
): Promise<void> {
  console.log(
    `\n[gsynchro] ${signal}, shutting down`,
  );

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  await Promise.all([
    repoWatcher?.close(),
    driveWatcher?.close(),
  ]);

  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  config = await loadConfig();

  DRIVE_ROOT = path.resolve(
    config.destination,
  );

  DRIVE_TRASH = path.join(
    DRIVE_ROOT,
    '.trash',
  );

  await validateRoots();

  console.log('[gsynchro]');
  console.log(`  repo:        ${REPO_ROOT}`);
  console.log(`  drive:       ${DRIVE_ROOT}`);
  console.log(`  debounce:    ${config.debounce}s`);
  console.log(`  max size:    10 MiB`);
  console.log(`  extensions:  .md .txt .json`);
  console.log(`  conflicts:   repository wins`);
  debug('Debug enabled; RAW events precede normalized EVENT and QUEUE logs');

  /*
   * First reconciliation happens before watchers start.
   */
  await reconcile();

  repoWatcher =
    createWatcher('repo');

  driveWatcher =
    createWatcher('drive');

  console.log('[gsynchro] watching both sides');

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

void main().catch((error) => {
  console.error(
    '[gsynchro] fatal:',
    error instanceof Error
      ? error.message
      : error,
  );

  process.exit(1);
});