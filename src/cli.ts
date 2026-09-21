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
import { createInterface, type Interface } from 'node:readline/promises';

type Side = 'repo' | 'drive';

interface Config {
  destination: string;
  debounce?: number;
  items: string[];
  extensions: string[];
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
const SETUP = process.argv.slice(2).includes('--setup');
const DEFAULT_ITEMS = ['*.md', 'docs/**/*.md'];
const PREVIEW_SAMPLE_SIZE = 15;
const PREVIEW_WARN_FILE_COUNT = 20;
const PREVIEW_WARN_TOTAL_BYTES = 2 * 1024 * 1024;

const DEFAULT_EXTENSIONS = [
  '.md',
  '.txt',
  '.json',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.pdf',
];

const EXTENSION_PATTERN = /^\.[a-z0-9]+$/;

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.gsynchro',
  '.trash',
]);

const REPO_ROOT = process.cwd();
const CONFIG_DIR = path.join(REPO_ROOT, '.gsynchro');
const CONFIG_PATH = path.join(CONFIG_DIR, 'gsynchro.yml');
const STATUS_PATH = path.join(CONFIG_DIR, 'gsynchro.status');

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

function normalizeExtension(rawExtension: string): string {
  const trimmed = rawExtension.trim().toLowerCase();

  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function isValidExtension(extension: string): boolean {
  return EXTENSION_PATTERN.test(extension);
}

function isAllowedRelativePath(
  relativePath: string,
  extensions: ReadonlySet<string>,
): boolean {
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

  return extensions.has(extension);
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
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

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
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

  if (
    parsed.extensions !== undefined &&
    (
      !Array.isArray(parsed.extensions) ||
      parsed.extensions.length === 0 ||
      parsed.extensions.some(
        (item) => typeof item !== 'string' || !item.trim(),
      )
    )
  ) {
    throw new Error(
      'gsynchro.yml: "extensions" must be a non-empty string array',
    );
  }

  const extensions = (
    parsed.extensions ?? DEFAULT_EXTENSIONS
  ).map(normalizeExtension);

  const invalidExtension = extensions.find(
    (extension) => !isValidExtension(extension),
  );

  if (invalidExtension) {
    throw new Error(
      `gsynchro.yml: invalid "extensions" entry "${invalidExtension}" ` +
      '(expected a dot followed by letters/digits, e.g. ".md")',
    );
  }

  return {
    destination: path.resolve(parsed.destination),
    debounce: parsed.debounce ?? 3,
    items: parsed.items.map(normalizeRelative),
    extensions,
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
/* Setup wizard                                                               */
/* -------------------------------------------------------------------------- */

type DestinationCheck =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

async function validateDestinationCandidate(
  rawValue: string,
): Promise<DestinationCheck> {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return { ok: false, error: 'Destination path cannot be empty.' };
  }

  const resolved = path.resolve(trimmed);

  if (resolved === REPO_ROOT) {
    return {
      ok: false,
      error: 'Destination cannot be the repository root.',
    };
  }

  if (
    isPathInside(REPO_ROOT, resolved) ||
    isPathInside(resolved, REPO_ROOT)
  ) {
    return {
      ok: false,
      error: 'Repository and destination cannot contain each other.',
    };
  }

  try {
    const info = await stat(resolved);

    if (!info.isDirectory()) {
      return { ok: false, error: `Not a directory: ${resolved}` };
    }
  } catch {
    return {
      ok: false,
      error:
        `Directory does not exist or is not accessible: ${resolved}\n` +
        '  gsynchro does not create the destination automatically — ' +
        'create or mount it first.',
    };
  }

  return { ok: true, resolved };
}

async function promptYesNo(
  rl: Interface,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const suffix = defaultYes ? 'Y/n' : 'y/N';
  const answer = (
    await rl.question(`${question} [${suffix}] `)
  ).trim().toLowerCase();

  if (!answer) {
    return defaultYes;
  }

  return answer === 'y' || answer === 'yes';
}

function sumSize(files: CandidateFile[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

function printPreviewSample(files: CandidateFile[]): void {
  const sample = files.slice(0, PREVIEW_SAMPLE_SIZE);

  for (const file of sample) {
    console.log(`    ${file.relativePath} (${formatSize(file.size)})`);
  }

  if (files.length > sample.length) {
    console.log(`    ... and ${files.length - sample.length} more`);
  }
}

/**
 * Scans both roots with the candidate glob patterns using the exact same
 * matching rules as the live sync engine, and reports what a first sync
 * would bring into the repository, before anything is written or copied.
 *
 * Returns whether the user wants to proceed with these patterns.
 */
async function previewSelection(
  destination: string,
  items: string[],
  extensions: string[],
  rl: Interface,
): Promise<boolean> {
  console.log('\n  Scanning matched files (preview only, nothing is copied)...');

  const extensionSet = new Set(extensions);

  const [repoResult, driveResult] = await Promise.all([
    collectCandidates(REPO_ROOT, items, extensionSet),
    collectCandidates(destination, items, extensionSet),
  ]);

  const repoFiles = repoResult.files;
  const driveFiles = driveResult.files;

  const repoPaths = new Set(
    repoFiles.map((file) => file.relativePath),
  );
  const driveOnly = driveFiles.filter(
    (file) => !repoPaths.has(file.relativePath),
  );
  const driveOnlySize = sumSize(driveOnly);

  console.log(
    `  repository:  ${repoFiles.length} file(s) matched (${formatSize(sumSize(repoFiles))})`,
  );
  console.log(
    `  destination: ${driveFiles.length} file(s) matched (${formatSize(sumSize(driveFiles))})`,
  );

  if (
    repoResult.oversized.length > 0 ||
    driveResult.oversized.length > 0
  ) {
    console.log(
      `  (${repoResult.oversized.length + driveResult.oversized.length} matching file(s) skipped: larger than 10 MiB)`,
    );
  }

  if (driveOnly.length === 0) {
    console.log(
      '  Nothing new on the destination side — a first sync would not add files to the repository.',
    );

    return promptYesNo(rl, '\nUse these patterns?', true);
  }

  console.log(
    `\n  ${driveOnly.length} file(s) exist only on the destination, not in the repository ` +
    `(${formatSize(driveOnlySize)}). Unless they are already tracked in gsynchro's sync status, ` +
    'a first sync would copy them into the repository:',
  );

  printPreviewSample(driveOnly);

  const looksLikeALot =
    driveOnly.length > PREVIEW_WARN_FILE_COUNT ||
    driveOnlySize > PREVIEW_WARN_TOTAL_BYTES;

  if (looksLikeALot) {
    console.log(
      '\n  That looks like a lot to bring into the repository — double-check the destination and patterns.',
    );
  }

  return promptYesNo(rl, '\nUse these patterns?', !looksLikeALot);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderConfigYaml(cfg: {
  destination: string;
  items: string[];
  extensions: string[];
  debounce: number;
}): string {
  const itemsYaml = cfg.items
    .map((item) => `  - ${yamlString(item)}`)
    .join('\n');

  const extensionsYaml = cfg.extensions
    .map((extension) => `  - ${yamlString(extension)}`)
    .join('\n');

  return (
    '# Existing local directory or mount point for the other side of the sync.\n' +
    `destination: ${yamlString(cfg.destination)}\n` +
    '\n' +
    '# Seconds of inactivity before reconciling filesystem changes.\n' +
    `debounce: ${cfg.debounce}\n` +
    '\n' +
    '# File extensions eligible for synchronization (case-insensitive).\n' +
    'extensions:\n' +
    `${extensionsYaml}\n` +
    '\n' +
    '# Glob patterns relative to the project root. Combine with "extensions"\n' +
    '# above, e.g. "docs/**/*.*" to pick up every eligible extension under docs/.\n' +
    'items:\n' +
    `${itemsYaml}\n`
  );
}

/**
 * Interactively creates or overwrites `.gsynchro/gsynchro.yml`.
 *
 * Returns whether the caller should continue on into the normal watch
 * flow (true), or stop here so the user can review the file first (false).
 */
async function runSetup(): Promise<boolean> {
  const configAlreadyExists = await pathExists(CONFIG_PATH);

  let existing: Config | undefined;

  if (configAlreadyExists) {
    try {
      existing = await loadConfig();
    } catch {
      existing = undefined;
    }
  }

  console.log('[gsynchro] setup');
  console.log(`  repo: ${REPO_ROOT}`);

  if (configAlreadyExists) {
    console.log(
      `  Existing configuration found at ${CONFIG_PATH}; current values are offered as defaults.`,
    );
  } else {
    console.log(
      `  No configuration found at ${CONFIG_PATH}; let's create one.`,
    );
  }

  console.log('');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    let destination: string | undefined;

    while (destination === undefined) {
      const defaultDestination = existing?.destination ?? '';
      const answer = await rl.question(
        `Destination directory${defaultDestination ? ` [${defaultDestination}]` : ''}: `,
      );
      const candidate = answer.trim() || defaultDestination;
      const result = await validateDestinationCandidate(candidate);

      if (result.ok) {
        destination = result.resolved;
      } else {
        console.log(`  ${result.error}`);
      }
    }

    let extensions: string[] | undefined;

    while (extensions === undefined) {
      const defaultExtensions =
        existing?.extensions.join(', ') ?? DEFAULT_EXTENSIONS.join(', ');
      const answer = await rl.question(
        `File extensions to sync, comma-separated [${defaultExtensions}]: `,
      );
      const raw = answer.trim() || defaultExtensions;
      const parsed = raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map(normalizeExtension);

      if (parsed.length === 0) {
        console.log('  At least one file extension is required.');
        continue;
      }

      const invalid = parsed.find(
        (extension) => !isValidExtension(extension),
      );

      if (invalid) {
        console.log(
          `  Invalid extension "${invalid}" — expected a dot followed by letters/digits, e.g. ".md".`,
        );
        continue;
      }

      extensions = [...new Set(parsed)];
    }

    let items: string[] | undefined;

    while (items === undefined) {
      const defaultItems =
        existing?.items.join(', ') ?? DEFAULT_ITEMS.join(', ');
      const answer = await rl.question(
        `Glob patterns to sync, comma-separated [${defaultItems}]: `,
      );
      const raw = answer.trim() || defaultItems;
      const parsed = raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      if (parsed.length === 0) {
        console.log('  At least one glob pattern is required.');
        continue;
      }

      if (await previewSelection(destination, parsed, extensions, rl)) {
        items = parsed;
      }
    }

    let debounce: number | undefined;

    while (debounce === undefined) {
      const defaultDebounce = existing?.debounce ?? 3;
      const answer = await rl.question(
        `Debounce seconds [${defaultDebounce}]: `,
      );
      const raw = answer.trim() || String(defaultDebounce);
      const parsed = Number(raw);

      if (Number.isFinite(parsed) && parsed >= 0) {
        debounce = parsed;
      } else {
        console.log('  Enter a number >= 0.');
      }
    }

    console.log('\nConfiguration to write:');
    console.log(`  destination: ${destination}`);
    console.log(`  extensions:  ${extensions.join(', ')}`);
    console.log(`  items:       ${items.join(', ')}`);
    console.log(`  debounce:    ${debounce}s`);
    console.log('');

    const confirmed = await promptYesNo(
      rl,
      `Write ${path.relative(REPO_ROOT, CONFIG_PATH)}?`,
      true,
    );

    if (!confirmed) {
      console.log('[gsynchro] setup cancelled, nothing was written');
      return false;
    }

    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(
      CONFIG_PATH,
      renderConfigYaml({ destination, items, extensions, debounce }),
      'utf8',
    );

    console.log(`[gsynchro] wrote ${CONFIG_PATH}`);

    return await promptYesNo(rl, 'Start gsynchro now?', true);
  } finally {
    rl.close();
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
  await mkdir(CONFIG_DIR, { recursive: true });
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

interface CandidateFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

interface CollectResult {
  files: CandidateFile[];
  oversized: Array<{ relativePath: string; size: number }>;
}

/*
 * Shared by the live scanner and the setup wizard's preview, so both
 * apply exactly the same matching and safety rules.
 */
async function collectCandidates(
  root: string,
  items: string[],
  extensions: ReadonlySet<string>,
): Promise<CollectResult> {
  /*
   * fast-glob does the configured path filtering.
   * The fixed safety rules below are applied independently.
   */
  const candidates = await fg(items, {
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

  const files: CandidateFile[] = [];
  const oversized: Array<{ relativePath: string; size: number }> = [];

  for (const candidate of candidates) {
    const relativePath = normalizeRelative(candidate);

    if (!isAllowedRelativePath(relativePath, extensions)) {
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
      oversized.push({ relativePath, size: info.size });
      continue;
    }

    files.push({
      relativePath,
      absolutePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }

  return { files, oversized };
}

async function scanSide(
  side: Side,
): Promise<Map<string, FileSnapshot>> {
  const root = sideRoot(side);
  const { files, oversized } = await collectCandidates(
    root,
    config.items,
    new Set(config.extensions),
  );

  for (const item of oversized) {
    console.warn(
      `SKIP  ${side.toUpperCase()} ${item.relativePath} ` +
      `(${(item.size / 1024 / 1024).toFixed(2)} MiB > 10 MiB)`,
    );
  }

  const result = new Map<string, FileSnapshot>();

  for (const file of files) {
    result.set(file.relativePath, {
      hash: await hashFile(file.absolutePath),
      size: file.size,
      mtimeMs: file.mtimeMs,
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
  const extensionSet = new Set(config.extensions);
  debug(`WATCH ${side.toUpperCase()} starting`, {
    root,
    usePolling: side === 'drive',
    interval: 1000,
    ignoreInitial: true,
    items: config.items,
    extensions: config.extensions,
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
        ) || (info?.isFile() === true && !isAllowedRelativePath(relativePath, extensionSet));
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
  if (SETUP || !(await pathExists(CONFIG_PATH))) {
    const shouldContinue = await runSetup();

    if (!shouldContinue) {
      return;
    }
  }

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
  console.log(`  extensions:  ${config.extensions.join(' ')}`);
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