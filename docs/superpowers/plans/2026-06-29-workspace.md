# Workspace Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Workspace that coordinates multiple repositories under a single `codegraph-workspace.yaml`, enables multi-repo MCP search via automatic fanout, and exposes `codegraph workspace` CLI subcommands.

**Architecture:** A new `src/workspace/` module (config reader, SQLite registry, manager class) sits above the existing per-project `CodeGraph` instances. `ToolHandler` gets an optional `WorkspaceManager` injection; when present and `projectPath` is absent, tool calls fan out across all registered repos. `MCPEngine.doInitialize` detects a workspace config at startup and wires the manager in.

**Tech Stack:** TypeScript, `node:sqlite` (via existing `createDatabase` in `src/db/sqlite-adapter.ts`), `commander` (existing CLI), `vitest` (existing test framework).

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/workspace/config.ts` | Read/write `codegraph-workspace.yaml`; `findNearestWorkspaceRoot` walk-up |
| Create | `src/workspace/registry.ts` | SQLite-backed repo registry (`workspace.db`); CRUD operations |
| Create | `src/workspace/manager.ts` | `WorkspaceManager`: init/open/findNearest, addRepo, removeRepo, indexAll, status, doctor, openAllCodeGraphs |
| Modify | `src/bin/codegraph.ts` | Add `workspace` subcommand group (init/add/remove/index/list/status/doctor) |
| Modify | `src/mcp/tools.ts` | Add optional `workspace` field; `setWorkspace()`; fanout in `execute()` and new `executeWorkspaceFanout()` |
| Modify | `src/mcp/engine.ts` | Call `WorkspaceManager.findNearest()` in `doInitialize()` and wire via `toolHandler.setWorkspace()` |
| Create | `__tests__/workspace.test.ts` | Unit + integration tests for all new code |

---

## Task 1: `src/workspace/config.ts` — YAML config read/write

**Files:**
- Create: `src/workspace/config.ts`
- Test: `__tests__/workspace.test.ts`

- [ ] **Step 1: Write failing tests for config**

Create `__tests__/workspace.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-test-'));
}
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ---- config ----------------------------------------------------------------
import {
  readWorkspaceConfig,
  writeWorkspaceConfig,
  findNearestWorkspaceRoot,
  WORKSPACE_CONFIG_FILENAME,
} from '../src/workspace/config';

describe('workspace config', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanupTempDir(tmpDir); });

  it('returns null when no config file exists', () => {
    expect(readWorkspaceConfig(tmpDir)).toBeNull();
  });

  it('round-trips a config with multiple repos', () => {
    const config = {
      name: 'myworkspace',
      repositories: [
        { name: 'frontend', path: './repos/frontend' },
        { name: 'backend', path: './repos/backend' },
      ],
    };
    writeWorkspaceConfig(tmpDir, config);
    expect(readWorkspaceConfig(tmpDir)).toEqual(config);
  });

  it('round-trips an empty repositories list', () => {
    writeWorkspaceConfig(tmpDir, { name: 'empty', repositories: [] });
    expect(readWorkspaceConfig(tmpDir)).toEqual({ name: 'empty', repositories: [] });
  });

  it('findNearestWorkspaceRoot finds config from a subdirectory', () => {
    const sub = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(sub, { recursive: true });
    writeWorkspaceConfig(tmpDir, { name: 'test', repositories: [] });
    expect(findNearestWorkspaceRoot(sub)).toBe(tmpDir);
  });

  it('findNearestWorkspaceRoot returns null when no config exists', () => {
    expect(findNearestWorkspaceRoot(tmpDir)).toBeNull();
  });

  it('writes the expected YAML filename', () => {
    writeWorkspaceConfig(tmpDir, { name: 'x', repositories: [] });
    expect(fs.existsSync(path.join(tmpDir, WORKSPACE_CONFIG_FILENAME))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run __tests__/workspace.test.ts
```

Expected: `Cannot find module '../src/workspace/config'`

- [ ] **Step 3: Implement `src/workspace/config.ts`**

Create `src/workspace/config.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

export const WORKSPACE_CONFIG_FILENAME = 'codegraph-workspace.yaml';

export interface WorkspaceRepoEntry {
  name: string;
  path: string;
}

export interface WorkspaceConfig {
  name: string;
  repositories: WorkspaceRepoEntry[];
}

export function readWorkspaceConfig(workspaceRoot: string): WorkspaceConfig | null {
  const filePath = path.join(workspaceRoot, WORKSPACE_CONFIG_FILENAME);
  try {
    return parseWorkspaceYaml(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeWorkspaceConfig(workspaceRoot: string, config: WorkspaceConfig): void {
  fs.writeFileSync(
    path.join(workspaceRoot, WORKSPACE_CONFIG_FILENAME),
    serializeWorkspaceYaml(config),
    'utf-8'
  );
}

export function findNearestWorkspaceRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;
  while (current !== root) {
    if (fs.existsSync(path.join(current, WORKSPACE_CONFIG_FILENAME))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (fs.existsSync(path.join(current, WORKSPACE_CONFIG_FILENAME))) return current;
  return null;
}

function stripQuotes(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, '');
}

function parseWorkspaceYaml(content: string): WorkspaceConfig {
  const lines = content.split(/\r?\n/);
  let name = '';
  const repositories: WorkspaceRepoEntry[] = [];
  let inRepositories = false;
  let currentRepo: Partial<WorkspaceRepoEntry> | null = null;

  const finalize = (): void => {
    if (currentRepo?.name && currentRepo?.path) {
      repositories.push({ name: currentRepo.name, path: currentRepo.path });
    }
    currentRepo = null;
  };

  for (const line of lines) {
    if (!line.trim()) continue;

    const topName = line.match(/^name\s*:\s*(.+)$/);
    if (topName) { name = stripQuotes(topName[1]!); continue; }

    if (/^repositories\s*:/.test(line)) { inRepositories = true; continue; }

    if (!inRepositories) continue;

    if (!/^\s/.test(line)) { finalize(); inRepositories = false; continue; }

    // New list item: "  - key: value"
    const newItem = line.match(/^\s+-\s+(\w+)\s*:\s*(.+)$/);
    if (newItem) {
      finalize();
      currentRepo = {};
      (currentRepo as Record<string, string>)[newItem[1]!] = stripQuotes(newItem[2]!);
      continue;
    }

    // Blank list item: "  -"
    if (/^\s+-\s*$/.test(line)) { finalize(); currentRepo = {}; continue; }

    // Continuation key: "    key: value"
    const cont = line.match(/^\s+(\w+)\s*:\s*(.+)$/);
    if (cont && currentRepo) {
      (currentRepo as Record<string, string>)[cont[1]!] = stripQuotes(cont[2]!);
    }
  }
  finalize();
  return { name, repositories };
}

function serializeWorkspaceYaml(config: WorkspaceConfig): string {
  const lines: string[] = [`name: ${config.name}`, '', 'repositories:'];
  for (const repo of config.repositories) {
    lines.push(`  - name: ${repo.name}`);
    lines.push(`    path: ${repo.path}`);
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run __tests__/workspace.test.ts
```

Expected: all `workspace config` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/workspace/config.ts __tests__/workspace.test.ts
git commit -m "feat(workspace): add config read/write for codegraph-workspace.yaml"
```

---

## Task 2: `src/workspace/registry.ts` — SQLite repo registry

**Files:**
- Create: `src/workspace/registry.ts`
- Modify: `__tests__/workspace.test.ts`

- [ ] **Step 1: Add failing registry tests to `__tests__/workspace.test.ts`**

Append after the config describe block:

```typescript
// ---- registry --------------------------------------------------------------
import { WorkspaceRegistry, WORKSPACE_DB_FILENAME } from '../src/workspace/registry';

describe('WorkspaceRegistry', () => {
  let tmpDir: string;
  let dbPath: string;
  let registry: WorkspaceRegistry;

  beforeEach(() => {
    tmpDir = createTempDir();
    dbPath = path.join(tmpDir, WORKSPACE_DB_FILENAME);
    registry = WorkspaceRegistry.initialize(dbPath);
  });
  afterEach(() => {
    registry.close();
    cleanupTempDir(tmpDir);
  });

  it('creates the database file on initialize', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('starts with no repos', () => {
    expect(registry.listRepos()).toEqual([]);
  });

  it('addRepo inserts a row', () => {
    registry.addRepo({ name: 'frontend', path: '/ws/frontend', status: 'pending',
      last_indexed_at: null, branch: null, commit_sha: null, remote_url: null, primary_language: null });
    const repos = registry.listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe('frontend');
    expect(repos[0]!.path).toBe('/ws/frontend');
    expect(repos[0]!.status).toBe('pending');
  });

  it('addRepo is a no-op when path already exists', () => {
    registry.addRepo({ name: 'frontend', path: '/ws/frontend', status: 'pending',
      last_indexed_at: null, branch: null, commit_sha: null, remote_url: null, primary_language: null });
    registry.addRepo({ name: 'frontend-dup', path: '/ws/frontend', status: 'pending',
      last_indexed_at: null, branch: null, commit_sha: null, remote_url: null, primary_language: null });
    expect(registry.listRepos()).toHaveLength(1);
  });

  it('removeRepo deletes the row', () => {
    registry.addRepo({ name: 'frontend', path: '/ws/frontend', status: 'pending',
      last_indexed_at: null, branch: null, commit_sha: null, remote_url: null, primary_language: null });
    registry.removeRepo('frontend');
    expect(registry.listRepos()).toHaveLength(0);
  });

  it('updateRepo changes fields', () => {
    registry.addRepo({ name: 'backend', path: '/ws/backend', status: 'pending',
      last_indexed_at: null, branch: null, commit_sha: null, remote_url: null, primary_language: null });
    registry.updateRepo('backend', { status: 'indexed', last_indexed_at: 12345, branch: 'main' });
    const repo = registry.listRepos()[0]!;
    expect(repo.status).toBe('indexed');
    expect(repo.last_indexed_at).toBe(12345);
    expect(repo.branch).toBe('main');
  });

  it('findByPath returns the row when found', () => {
    registry.addRepo({ name: 'shared', path: '/ws/shared', status: 'pending',
      last_indexed_at: null, branch: null, commit_sha: null, remote_url: null, primary_language: null });
    expect(registry.findByPath('/ws/shared')?.name).toBe('shared');
  });

  it('findByPath returns null when not found', () => {
    expect(registry.findByPath('/nope')).toBeNull();
  });

  it('metadata get/set round-trips', () => {
    registry.setMetadata('name', 'myworkspace');
    expect(registry.getMetadata('name')).toBe('myworkspace');
  });

  it('open reconnects to an existing database', () => {
    registry.addRepo({ name: 'svc', path: '/ws/svc', status: 'pending',
      last_indexed_at: null, branch: null, commit_sha: null, remote_url: null, primary_language: null });
    registry.close();
    const reopened = WorkspaceRegistry.open(dbPath);
    expect(reopened.listRepos()).toHaveLength(1);
    reopened.close();
  });
});
```

- [ ] **Step 2: Run tests — verify registry tests fail**

```bash
npx vitest run __tests__/workspace.test.ts
```

Expected: config tests still pass; registry tests fail with `Cannot find module '../src/workspace/registry'`.

- [ ] **Step 3: Implement `src/workspace/registry.ts`**

Create `src/workspace/registry.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createDatabase, SqliteDatabase } from '../db/sqlite-adapter';

export const WORKSPACE_DB_FILENAME = 'workspace.db';

export interface RepoRecord {
  id: string;
  name: string;
  path: string;
  status: 'indexed' | 'pending' | 'error';
  last_indexed_at: number | null;
  branch: string | null;
  commit_sha: string | null;
  remote_url: string | null;
  primary_language: string | null;
  added_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  last_indexed_at INTEGER,
  branch TEXT,
  commit_sha TEXT,
  remote_url TEXT,
  primary_language TEXT,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function configureDb(db: SqliteDatabase): void {
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
}

export class WorkspaceRegistry {
  private constructor(private db: SqliteDatabase) {}

  static initialize(dbPath: string): WorkspaceRegistry {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const { db } = createDatabase(dbPath);
    configureDb(db);
    db.exec(SCHEMA);
    return new WorkspaceRegistry(db);
  }

  static open(dbPath: string): WorkspaceRegistry {
    const { db } = createDatabase(dbPath);
    configureDb(db);
    return new WorkspaceRegistry(db);
  }

  addRepo(record: Omit<RepoRecord, 'id' | 'added_at'>): void {
    if (this.db.prepare('SELECT id FROM repos WHERE path = ?').get(record.path)) return;
    this.db.prepare(
      'INSERT INTO repos (id,name,path,status,last_indexed_at,branch,commit_sha,remote_url,primary_language,added_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(randomUUID(), record.name, record.path, record.status,
      record.last_indexed_at ?? null, record.branch ?? null, record.commit_sha ?? null,
      record.remote_url ?? null, record.primary_language ?? null, Date.now());
  }

  removeRepo(name: string): void {
    this.db.prepare('DELETE FROM repos WHERE name = ?').run(name);
  }

  listRepos(): RepoRecord[] {
    return this.db.prepare('SELECT * FROM repos ORDER BY added_at ASC').all() as RepoRecord[];
  }

  updateRepo(name: string, updates: Partial<Omit<RepoRecord, 'id' | 'name' | 'added_at'>>): void {
    const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const vals = [...entries.map(([, v]) => v), name];
    this.db.prepare(`UPDATE repos SET ${sets} WHERE name = ?`).run(...vals);
  }

  findByPath(absPath: string): RepoRecord | null {
    return (this.db.prepare('SELECT * FROM repos WHERE path = ?').get(absPath) as RepoRecord) ?? null;
  }

  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM workspace_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO workspace_metadata (key,value,updated_at) VALUES (?,?,?)').run(key, value, Date.now());
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run __tests__/workspace.test.ts
```

Expected: all config and registry tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/workspace/registry.ts __tests__/workspace.test.ts
git commit -m "feat(workspace): add SQLite-backed WorkspaceRegistry"
```

---

## Task 3: `src/workspace/manager.ts` — WorkspaceManager

**Files:**
- Create: `src/workspace/manager.ts`
- Modify: `__tests__/workspace.test.ts`

- [ ] **Step 1: Add failing manager tests to `__tests__/workspace.test.ts`**

Append after the registry describe block:

```typescript
// ---- manager ---------------------------------------------------------------
import { WorkspaceManager } from '../src/workspace/manager';
import { CodeGraph } from '../src';

describe('WorkspaceManager', () => {
  let tmpDir: string;
  let wsDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsDir);
  });
  afterEach(() => { cleanupTempDir(tmpDir); });

  it('init creates codegraph-workspace.yaml and workspace.db', () => {
    const manager = WorkspaceManager.init(wsDir, 'testws');
    manager.close();
    expect(fs.existsSync(path.join(wsDir, 'codegraph-workspace.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, '.codegraph', 'workspace.db'))).toBe(true);
  });

  it('init throws if workspace already exists', () => {
    WorkspaceManager.init(wsDir, 'testws').close();
    expect(() => WorkspaceManager.init(wsDir, 'testws')).toThrow('already initialized');
  });

  it('open reads an existing workspace', () => {
    WorkspaceManager.init(wsDir, 'testws').close();
    const manager = WorkspaceManager.open(wsDir);
    expect(manager.getWorkspaceRoot()).toBe(wsDir);
    manager.close();
  });

  it('findNearest locates workspace from a subdirectory', () => {
    WorkspaceManager.init(wsDir, 'testws').close();
    const sub = path.join(wsDir, 'deep', 'subdir');
    fs.mkdirSync(sub, { recursive: true });
    const found = WorkspaceManager.findNearest(sub);
    expect(found?.getWorkspaceRoot()).toBe(wsDir);
    found?.close();
  });

  it('findNearest returns null when no workspace found', () => {
    expect(WorkspaceManager.findNearest(tmpDir)).toBeNull();
  });

  it('addRepo auto-inits an uninitialised repo and registers it', async () => {
    const manager = WorkspaceManager.init(wsDir, 'testws');
    const repoDir = path.join(tmpDir, 'myrepo');
    fs.mkdirSync(repoDir);
    // Write a minimal source file so indexAll has something to index
    fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export function hello() {}');

    await manager.addRepo(repoDir, 'myrepo');
    expect(CodeGraph.isInitialized(repoDir)).toBe(true);

    const repos = manager.listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe('myrepo');
    expect(repos[0]!.status).toBe('pending');
    manager.close();
  });

  it('addRepo is idempotent for duplicate paths', async () => {
    const manager = WorkspaceManager.init(wsDir, 'testws');
    const repoDir = path.join(tmpDir, 'dup');
    fs.mkdirSync(repoDir);
    fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export const x = 1;');
    await manager.addRepo(repoDir, 'dup');
    await manager.addRepo(repoDir, 'dup');
    expect(manager.listRepos()).toHaveLength(1);
    manager.close();
  });

  it('addRepo skips codegraph init when repo is already initialised', async () => {
    const manager = WorkspaceManager.init(wsDir, 'testws');
    const repoDir = path.join(tmpDir, 'existing');
    fs.mkdirSync(repoDir);
    fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export const y = 2;');
    // Pre-initialise manually
    CodeGraph.initSync(repoDir).close();
    // Should not throw (would throw if it tried to init twice)
    await manager.addRepo(repoDir, 'existing');
    expect(manager.listRepos()).toHaveLength(1);
    manager.close();
  });

  it('removeRepo deletes from registry and YAML; leaves .codegraph/ on disk', async () => {
    const manager = WorkspaceManager.init(wsDir, 'testws');
    const repoDir = path.join(tmpDir, 'todelete');
    fs.mkdirSync(repoDir);
    fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export const z = 3;');
    await manager.addRepo(repoDir, 'todelete');
    manager.removeRepo('todelete');
    expect(manager.listRepos()).toHaveLength(0);
    // .codegraph/ must still exist
    expect(fs.existsSync(path.join(repoDir, '.codegraph'))).toBe(true);
    manager.close();
  });

  it('getStatus returns correct counts', async () => {
    const manager = WorkspaceManager.init(wsDir, 'testws');
    const repoDir = path.join(tmpDir, 'statusrepo');
    fs.mkdirSync(repoDir);
    fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export const a = 1;');
    await manager.addRepo(repoDir, 'statusrepo');
    const status = manager.getStatus();
    expect(status.total).toBe(1);
    expect(status.pending).toBe(1);
    expect(status.indexed).toBe(0);
    manager.close();
  });
});
```

- [ ] **Step 2: Run tests — verify manager tests fail**

```bash
npx vitest run __tests__/workspace.test.ts
```

Expected: config + registry tests pass; manager tests fail with `Cannot find module '../src/workspace/manager'`.

- [ ] **Step 3: Implement `src/workspace/manager.ts`**

Create `src/workspace/manager.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceRegistry, RepoRecord, WORKSPACE_DB_FILENAME } from './registry';
import {
  WorkspaceConfig,
  readWorkspaceConfig,
  writeWorkspaceConfig,
  findNearestWorkspaceRoot,
  WORKSPACE_CONFIG_FILENAME,
} from './config';
import { isInitialized } from '../directory';
import type CodeGraph from '../index';
import type { IndexOptions, IndexResult } from '../extraction';
import type { ExtractionError } from '../types';

export interface WorkspaceStatus {
  total: number;
  indexed: number;
  pending: number;
  errored: number;
}

export interface DoctorResult {
  name: string;
  path: string;
  issues: string[];
}

const loadCodeGraph = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;

export class WorkspaceManager {
  private openedGraphs: Map<string, CodeGraph> = new Map();

  private constructor(
    private workspaceRoot: string,
    private registry: WorkspaceRegistry
  ) {}

  static init(workspaceRoot: string, name: string): WorkspaceManager {
    const resolved = path.resolve(workspaceRoot);
    if (fs.existsSync(path.join(resolved, WORKSPACE_CONFIG_FILENAME))) {
      throw new Error(`Workspace already initialized in ${resolved}`);
    }
    const cgDir = path.join(resolved, '.codegraph');
    fs.mkdirSync(cgDir, { recursive: true });
    const registry = WorkspaceRegistry.initialize(path.join(cgDir, WORKSPACE_DB_FILENAME));
    registry.setMetadata('name', name);
    registry.setMetadata('created_at', String(Date.now()));
    registry.setMetadata('schema_version', '1');
    writeWorkspaceConfig(resolved, { name, repositories: [] });
    return new WorkspaceManager(resolved, registry);
  }

  static open(workspaceRoot: string): WorkspaceManager {
    const resolved = path.resolve(workspaceRoot);
    const dbPath = path.join(resolved, '.codegraph', WORKSPACE_DB_FILENAME);
    if (!fs.existsSync(dbPath)) {
      throw new Error(`No workspace found at ${resolved} (missing .codegraph/workspace.db)`);
    }
    return new WorkspaceManager(resolved, WorkspaceRegistry.open(dbPath));
  }

  static findNearest(startPath: string): WorkspaceManager | null {
    const wsRoot = findNearestWorkspaceRoot(startPath);
    if (!wsRoot) return null;
    try { return WorkspaceManager.open(wsRoot); } catch { return null; }
  }

  async addRepo(repoPath: string, name?: string): Promise<void> {
    const absPath = path.resolve(this.workspaceRoot, repoPath);
    if (this.registry.findByPath(absPath)) return;

    const repoName = name ?? path.basename(absPath);

    if (!isInitialized(absPath)) {
      await loadCodeGraph().init(absPath, { index: false });
    }

    this.registry.addRepo({
      name: repoName,
      path: absPath,
      status: 'pending',
      last_indexed_at: null,
      branch: null,
      commit_sha: null,
      remote_url: null,
      primary_language: null,
    });

    const config = readWorkspaceConfig(this.workspaceRoot) ?? { name: '', repositories: [] };
    const relPath = './' + path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');
    if (!config.repositories.find(r => r.name === repoName)) {
      config.repositories.push({ name: repoName, path: relPath });
      writeWorkspaceConfig(this.workspaceRoot, config);
    }
  }

  removeRepo(name: string): void {
    this.registry.removeRepo(name);
    const config = readWorkspaceConfig(this.workspaceRoot);
    if (config) {
      config.repositories = config.repositories.filter(r => r.name !== name);
      writeWorkspaceConfig(this.workspaceRoot, config);
    }
  }

  listRepos(): RepoRecord[] {
    return this.registry.listRepos();
  }

  async indexAll(options?: IndexOptions): Promise<IndexResult[]> {
    const repos = this.registry.listRepos();
    const results: IndexResult[] = [];
    for (const repo of repos) {
      const start = Date.now();
      try {
        const cg = loadCodeGraph().openSync(repo.path);
        const result = await cg.indexAll(options);
        cg.close();
        results.push(result);
        const gitInfo = readGitInfo(repo.path);
        this.registry.updateRepo(repo.name, {
          status: 'indexed',
          last_indexed_at: Date.now(),
          branch: gitInfo.branch,
          commit_sha: gitInfo.sha,
        });
      } catch (err) {
        this.registry.updateRepo(repo.name, { status: 'error' });
        const errors: ExtractionError[] = [{
          message: err instanceof Error ? err.message : String(err),
          severity: 'error',
        }];
        results.push({
          success: false,
          filesIndexed: 0,
          filesSkipped: 0,
          filesErrored: 1,
          nodesCreated: 0,
          edgesCreated: 0,
          errors,
          durationMs: Date.now() - start,
        });
      }
    }
    return results;
  }

  getStatus(): WorkspaceStatus {
    const repos = this.registry.listRepos();
    return {
      total: repos.length,
      indexed: repos.filter(r => r.status === 'indexed').length,
      pending: repos.filter(r => r.status === 'pending').length,
      errored: repos.filter(r => r.status === 'error').length,
    };
  }

  doctor(): DoctorResult[] {
    return this.registry.listRepos().map(repo => {
      const issues: string[] = [];
      if (!fs.existsSync(repo.path)) {
        issues.push(`path does not exist: ${repo.path}`);
      } else if (!isInitialized(repo.path)) {
        issues.push('.codegraph/ missing — run: codegraph workspace index');
      } else if (repo.status !== 'indexed') {
        issues.push(`status is '${repo.status}' — run: codegraph workspace index`);
      }
      return { name: repo.name, path: repo.path, issues };
    });
  }

  openAllCodeGraphs(): CodeGraph[] {
    const graphs: CodeGraph[] = [];
    for (const repo of this.registry.listRepos()) {
      if (repo.status !== 'indexed') continue;
      if (!isInitialized(repo.path)) continue;
      try {
        if (!this.openedGraphs.has(repo.path)) {
          this.openedGraphs.set(repo.path, loadCodeGraph().openSync(repo.path));
        }
        graphs.push(this.openedGraphs.get(repo.path)!);
      } catch { /* skip unavailable repos */ }
    }
    return graphs;
  }

  getRepoName(absPath: string): string {
    return this.registry.findByPath(absPath)?.name ?? path.basename(absPath);
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  close(): void {
    for (const cg of this.openedGraphs.values()) {
      try { cg.close(); } catch { /* ignore */ }
    }
    this.openedGraphs.clear();
    this.registry.close();
  }
}

function readGitInfo(repoPath: string): { branch: string | null; sha: string | null } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    const opts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: ['ignore', 'pipe', 'ignore'] as const };
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    const sha = execSync('git rev-parse --short HEAD', opts).trim();
    return { branch: branch || null, sha: sha || null };
  } catch {
    return { branch: null, sha: null };
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run __tests__/workspace.test.ts
```

Expected: all workspace config, registry, and manager tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/workspace/manager.ts __tests__/workspace.test.ts
git commit -m "feat(workspace): add WorkspaceManager with init/add/remove/status/doctor"
```

---

## Task 4: CLI workspace commands

**Files:**
- Modify: `src/bin/codegraph.ts`

- [ ] **Step 1: Add the workspace subcommand group at the end of `src/bin/codegraph.ts`**

Insert the following block immediately before the `program.parse()` call at line 2204 of `src/bin/codegraph.ts`:

```typescript
// =============================================================================
// codegraph workspace <subcommand>
// =============================================================================

const workspaceCmd = program
  .command('workspace')
  .description('Manage a multi-repository CodeGraph workspace');

workspaceCmd
  .command('init [path]')
  .description('Create a new workspace in the given directory (default: cwd)')
  .option('--name <name>', 'Workspace name (default: directory basename)')
  .action(async (pathArg: string | undefined, options: { name?: string }) => {
    const { WorkspaceManager } = await import('../workspace/manager');
    const clack = await importESM('@clack/prompts');
    const wsPath = path.resolve(pathArg ?? process.cwd());
    const name = options.name ?? path.basename(wsPath);
    clack.intro('Initializing workspace');
    try {
      WorkspaceManager.init(wsPath, name).close();
      clack.log.success(`Workspace "${name}" initialized in ${wsPath}`);
      clack.outro('Run `codegraph workspace add <path>` to add repositories');
    } catch (err) {
      clack.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

workspaceCmd
  .command('add <repoPath>')
  .description('Add a repository to the workspace (runs codegraph init if needed)')
  .option('--name <name>', 'Logical name for the repository (default: directory basename)')
  .action(async (repoPath: string, options: { name?: string }) => {
    const { WorkspaceManager } = await import('../workspace/manager');
    const clack = await importESM('@clack/prompts');
    const manager = WorkspaceManager.findNearest(process.cwd());
    if (!manager) {
      clack.log.error('No workspace found. Run `codegraph workspace init` first.');
      process.exit(1);
    }
    clack.intro('Adding repository');
    try {
      await manager.addRepo(repoPath, options.name);
      const repos = manager.listRepos();
      const added = repos[repos.length - 1]!;
      clack.log.success(`Added "${added.name}" (${added.path})`);
      clack.outro('Run `codegraph workspace index` to index it');
    } catch (err) {
      clack.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      manager.close();
    }
  });

workspaceCmd
  .command('remove <name>')
  .description('Remove a repository from the workspace registry (leaves .codegraph/ on disk)')
  .action(async (name: string) => {
    const { WorkspaceManager } = await import('../workspace/manager');
    const clack = await importESM('@clack/prompts');
    const manager = WorkspaceManager.findNearest(process.cwd());
    if (!manager) {
      clack.log.error('No workspace found. Run `codegraph workspace init` first.');
      process.exit(1);
    }
    try {
      manager.removeRepo(name);
      clack.log.success(`Removed "${name}" from workspace`);
    } catch (err) {
      clack.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      manager.close();
    }
  });

workspaceCmd
  .command('index')
  .description('Index all repositories in the workspace')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (options: { verbose?: boolean }) => {
    const { WorkspaceManager } = await import('../workspace/manager');
    const clack = await importESM('@clack/prompts');
    const manager = WorkspaceManager.findNearest(process.cwd());
    if (!manager) {
      clack.log.error('No workspace found. Run `codegraph workspace init` first.');
      process.exit(1);
    }
    clack.intro('Indexing workspace');
    try {
      const results = await manager.indexAll(options.verbose ? { onProgress: createVerboseProgress() } : undefined);
      const repos = manager.listRepos();
      for (let i = 0; i < repos.length; i++) {
        const repo = repos[i]!;
        const result = results[i];
        if (result?.success) {
          clack.log.success(`${repo.name}: ${result.filesIndexed} files indexed`);
        } else {
          clack.log.error(`${repo.name}: failed — ${result?.errors[0]?.message ?? 'unknown error'}`);
        }
      }
      clack.outro('Done');
    } catch (err) {
      clack.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      manager.close();
    }
  });

workspaceCmd
  .command('list')
  .description('List all repositories in the workspace')
  .action(async () => {
    const { WorkspaceManager } = await import('../workspace/manager');
    const manager = WorkspaceManager.findNearest(process.cwd());
    if (!manager) {
      console.error('No workspace found.');
      process.exit(1);
    }
    const repos = manager.listRepos();
    if (repos.length === 0) {
      console.log('No repositories registered. Run `codegraph workspace add <path>`.');
    } else {
      for (const repo of repos) {
        const ts = repo.last_indexed_at ? new Date(repo.last_indexed_at).toISOString() : 'never';
        const branch = repo.branch ? ` [${repo.branch}]` : '';
        const sha = repo.commit_sha ? ` @${repo.commit_sha}` : '';
        console.log(`  ${repo.status === 'indexed' ? '✓' : '○'} ${repo.name}  ${repo.path}${branch}${sha}  (last indexed: ${ts})`);
      }
    }
    manager.close();
  });

workspaceCmd
  .command('status')
  .description('Show workspace health summary')
  .action(async () => {
    const { WorkspaceManager } = await import('../workspace/manager');
    const manager = WorkspaceManager.findNearest(process.cwd());
    if (!manager) {
      console.error('No workspace found.');
      process.exit(1);
    }
    const s = manager.getStatus();
    console.log(`Workspace: ${manager.getWorkspaceRoot()}`);
    console.log(`Repos: ${s.indexed} indexed / ${s.total} total${s.errored ? `  (${s.errored} errored)` : ''}`);
    manager.close();
  });

workspaceCmd
  .command('doctor')
  .description('Check workspace health — missing paths, un-indexed repos, stale indexes')
  .action(async () => {
    const { WorkspaceManager } = await import('../workspace/manager');
    const clack = await importESM('@clack/prompts');
    const manager = WorkspaceManager.findNearest(process.cwd());
    if (!manager) {
      clack.log.error('No workspace found.');
      process.exit(1);
    }
    const results = manager.doctor();
    let hasIssues = false;
    for (const r of results) {
      if (r.issues.length === 0) {
        clack.log.success(`${r.name}: OK`);
      } else {
        hasIssues = true;
        for (const issue of r.issues) clack.log.error(`${r.name}: ${issue}`);
      }
    }
    if (!hasIssues) clack.outro('All repositories are healthy');
    manager.close();
  });
```

- [ ] **Step 2: Build to verify TypeScript compiles**

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds with no errors.

- [ ] **Step 3: Smoke-test the CLI commands**

```bash
# in a scratch directory
TMPWS=$(mktemp -d)
node dist/bin/codegraph.js workspace init "$TMPWS" --name smoke
node dist/bin/codegraph.js workspace status  # should print "No workspace found" since cwd isn't under TMPWS
cd "$TMPWS" && node $(pwd)/../dist/bin/codegraph.js workspace status
```

Expected: `workspace init` prints "Workspace ... initialized"; `status` from inside prints `Repos: 0 indexed / 0 total`.

- [ ] **Step 4: Commit**

```bash
git add src/bin/codegraph.ts
git commit -m "feat(workspace): add workspace CLI subcommands (init/add/remove/index/list/status/doctor)"
```

---

## Task 5: ToolHandler workspace fanout

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `__tests__/workspace.test.ts`

- [ ] **Step 1: Add regression + fanout tests to `__tests__/workspace.test.ts`**

Append after the manager describe block:

```typescript
// ---- ToolHandler workspace fanout ------------------------------------------
import { ToolHandler } from '../src/mcp/tools';

describe('ToolHandler workspace fanout', () => {
  let tmpDir: string;
  let wsDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    wsDir = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsDir);
  });
  afterEach(() => { cleanupTempDir(tmpDir); });

  it('behaves identically to today when constructed without WorkspaceManager', async () => {
    // A ToolHandler with no workspace and no default project returns the
    // "not indexed" guidance text (not isError) on codegraph_explore.
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_explore', { query: 'hello' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/not initialized|No CodeGraph project/i);
  });

  it('fanout searches all indexed repos and attributes results', async () => {
    // Build a workspace with two repos, each containing a unique symbol.
    const repoA = path.join(wsDir, 'repoA');
    const repoB = path.join(wsDir, 'repoB');
    fs.mkdirSync(repoA);
    fs.mkdirSync(repoB);
    fs.writeFileSync(path.join(repoA, 'index.ts'), 'export function uniqueAlpha() {}');
    fs.writeFileSync(path.join(repoB, 'index.ts'), 'export function uniqueBeta() {}');

    const manager = WorkspaceManager.init(wsDir, 'fanouttest');
    await manager.addRepo(repoA, 'repoA');
    await manager.addRepo(repoB, 'repoB');
    await manager.indexAll();

    const handler = new ToolHandler(null, manager);
    const result = await handler.execute('codegraph_explore', { query: 'uniqueAlpha uniqueBeta' });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    // Both repo names should appear as section headers
    expect(text).toContain('[repoA]');
    expect(text).toContain('[repoB]');

    manager.close();
  });

  it('projectPath overrides workspace fanout and queries single repo', async () => {
    const repoA = path.join(wsDir, 'solo');
    fs.mkdirSync(repoA);
    fs.writeFileSync(path.join(repoA, 'index.ts'), 'export function soloFn() {}');

    const manager = WorkspaceManager.init(wsDir, 'singletest');
    await manager.addRepo(repoA, 'solo');
    await manager.indexAll();

    const handler = new ToolHandler(null, manager);
    // projectPath bypasses fanout — single-project path runs as normal
    const result = await handler.execute('codegraph_explore', { query: 'soloFn', projectPath: repoA });
    expect(result.isError).toBeFalsy();
    // No workspace headers in single-project mode
    expect(result.content[0]!.text).not.toContain('[solo]');

    manager.close();
  });

  it('codegraph_files returns guidance when workspace active and no projectPath', async () => {
    const manager = WorkspaceManager.init(wsDir, 'filestest');
    const handler = new ToolHandler(null, manager);
    const result = await handler.execute('codegraph_files', {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/projectPath/i);
    manager.close();
  });
});
```

- [ ] **Step 2: Run tests — verify fanout tests fail**

```bash
npx vitest run __tests__/workspace.test.ts -t "ToolHandler workspace fanout"
```

Expected: `ToolHandler` constructor doesn't accept `workspace` arg → TypeScript/runtime error.

- [ ] **Step 3: Modify `src/mcp/tools.ts` — add workspace field, constructor change, setWorkspace, fanout**

Locate line 804 (`constructor(private cg: CodeGraph | null) {}`) and replace with:

```typescript
private workspace: WorkspaceManager | null = null;

constructor(private cg: CodeGraph | null, workspace?: WorkspaceManager) {
  if (workspace) this.workspace = workspace;
}

setWorkspace(workspace: WorkspaceManager): void {
  this.workspace = workspace;
}
```

Add the import at the top of `src/mcp/tools.ts` (after the existing imports):

```typescript
import type { WorkspaceManager } from '../workspace/manager';
```

In `execute()`, locate the `codegraph_status` check at line 1362:
```typescript
if (toolName === 'codegraph_status') {
  return await this.handleStatus(args);
}
```

Replace it with:

```typescript
// Workspace fanout: when attached and no projectPath is given, route to all repos.
if (this.workspace && !args.projectPath) {
  if (toolName === 'codegraph_files') {
    return this.textResult(
      'codegraph_files requires a specific project. ' +
      'Pass projectPath to target a repository in this workspace, ' +
      'e.g. projectPath: "/absolute/path/to/repo".'
    );
  }
  if (toolName === 'codegraph_status') {
    return await this.handleWorkspaceStatus();
  }
  return await this.executeWorkspaceFanout(toolName, args);
}

if (toolName === 'codegraph_status') {
  return await this.handleStatus(args);
}
```

Add the two new private methods anywhere in the class (e.g. just before `textResult`):

```typescript
private async handleWorkspaceStatus(): Promise<ToolResult> {
  const repos = this.workspace!.listRepos();
  if (repos.length === 0) {
    return this.textResult('Workspace has no registered repositories. Run `codegraph workspace add <path>`.');
  }
  const lines: string[] = ['## Workspace Status\n'];
  for (const repo of repos) {
    const ts = repo.last_indexed_at ? new Date(repo.last_indexed_at).toISOString() : 'never';
    const branch = repo.branch ? ` [${repo.branch}]` : '';
    lines.push(`**${repo.name}** — ${repo.status}${branch}, last indexed: ${ts}`);
    lines.push(`  path: ${repo.path}`);
  }
  return this.textResult(lines.join('\n'));
}

private async executeWorkspaceFanout(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const graphs = this.workspace!.openAllCodeGraphs();
  if (graphs.length === 0) {
    return this.textResult(
      'No indexed repositories in this workspace. Run `codegraph workspace index` to index them.'
    );
  }
  const parts: string[] = [];
  for (const cg of graphs) {
    const repoRoot = cg.getProjectRoot();
    const repoName = this.workspace!.getRepoName(repoRoot);
    const repoArgs = { ...args, projectPath: repoRoot };
    try {
      const result = await this.executeReadTool(toolName, repoArgs);
      if (!result.isError) {
        parts.push(`## [${repoName}]\n\n${result.content.map(c => c.text).join('\n')}`);
      }
    } catch { /* skip repos that fail */ }
  }
  if (parts.length === 0) {
    return this.textResult('No results found across the workspace.');
  }
  return this.textResult(parts.join('\n\n---\n\n'));
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run __tests__/workspace.test.ts
```

Expected: all workspace tests pass including the fanout tests.

- [ ] **Step 5: Run full test suite — verify no regressions**

```bash
npm test 2>&1 | tail -30
```

Expected: existing tests all pass; no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts __tests__/workspace.test.ts
git commit -m "feat(workspace): add ToolHandler workspace fanout via WorkspaceManager injection"
```

---

## Task 6: MCPEngine workspace detection

**Files:**
- Modify: `src/mcp/engine.ts`

- [ ] **Step 1: Add workspace detection in `doInitialize()` in `src/mcp/engine.ts`**

Add the import at the top of the file (after existing imports):

```typescript
import type { WorkspaceManager } from '../workspace/manager';
```

Add a lazy-loader for WorkspaceManager (alongside the existing `loadCodeGraph`):

```typescript
const loadWorkspaceManager = (): typeof import('../workspace/manager').WorkspaceManager =>
  (require('../workspace/manager') as typeof import('../workspace/manager')).WorkspaceManager;
```

At the end of `doInitialize()`, just before the closing `}`, add:

```typescript
// Detect workspace config at or above searchFrom and wire it into the handler.
// Workspace root may be ABOVE the per-project .codegraph/ root, so search from
// the original searchFrom, not from resolvedRoot.
try {
  const workspace = loadWorkspaceManager().findNearest(searchFrom);
  if (workspace) {
    this.toolHandler.setWorkspace(workspace);
    process.stderr.write(
      `[CodeGraph MCP] Workspace detected at ${workspace.getWorkspaceRoot()} — ` +
      `multi-repo fanout enabled (${workspace.listRepos().length} repo(s) registered)\n`
    );
  }
} catch { /* workspace detection is best-effort; never break the server */ }
```

- [ ] **Step 2: Build to verify no TypeScript errors**

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 3: Run full test suite**

```bash
npm test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/engine.ts
git commit -m "feat(workspace): wire WorkspaceManager into MCPEngine on workspace detection"
```

---

## Task 7: Integration test + CHANGELOG entry

**Files:**
- Modify: `__tests__/workspace.test.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add end-to-end integration test**

Append to `__tests__/workspace.test.ts`:

```typescript
// ---- end-to-end integration ------------------------------------------------
describe('workspace end-to-end', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanupTempDir(tmpDir); });

  it('symbol defined only in shared/ is found via workspace fanout', async () => {
    const wsDir = path.join(tmpDir, 'workspace');
    const frontend = path.join(wsDir, 'frontend');
    const backend = path.join(wsDir, 'backend');
    const shared = path.join(wsDir, 'shared');
    for (const d of [wsDir, frontend, backend, shared]) fs.mkdirSync(d, { recursive: true });

    fs.writeFileSync(path.join(frontend, 'app.ts'), 'export function renderApp() {}');
    fs.writeFileSync(path.join(backend, 'server.ts'), 'export function startServer() {}');
    fs.writeFileSync(path.join(shared, 'user.ts'), 'export interface WorkspaceTestUniqueUser { id: string; name: string; }');

    const manager = WorkspaceManager.init(wsDir, 'e2e');
    await manager.addRepo(frontend, 'frontend');
    await manager.addRepo(backend, 'backend');
    await manager.addRepo(shared, 'shared');
    await manager.indexAll();

    const handler = new ToolHandler(null, manager);

    // codegraph_search fanout: should find WorkspaceTestUniqueUser in shared
    const searchResult = await handler.execute('codegraph_search', { query: 'WorkspaceTestUniqueUser' });
    expect(searchResult.isError).toBeFalsy();
    expect(searchResult.content[0]!.text).toMatch(/WorkspaceTestUniqueUser/);

    // codegraph_explore fanout: returns blocks for all repos
    const exploreResult = await handler.execute('codegraph_explore', { query: 'WorkspaceTestUniqueUser' });
    expect(exploreResult.isError).toBeFalsy();
    const exploreText = exploreResult.content[0]!.text;
    expect(exploreText).toContain('[shared]');

    // projectPath override: querying frontend directly should NOT find the shared symbol
    const frontendResult = await handler.execute('codegraph_search', {
      query: 'WorkspaceTestUniqueUser',
      projectPath: frontend,
    });
    expect(frontendResult.content[0]!.text).not.toMatch(/WorkspaceTestUniqueUser.*shared/);

    manager.close();
  });
});
```

- [ ] **Step 2: Run only the integration test**

```bash
npx vitest run __tests__/workspace.test.ts -t "workspace end-to-end"
```

Expected: passes.

- [ ] **Step 3: Run the full test suite one final time**

```bash
npm test 2>&1 | tail -30
```

Expected: all tests pass, no regressions in existing tests (foundation, extraction, mcp-initialize, installer-targets, etc.).

- [ ] **Step 4: Add CHANGELOG entry**

Open `CHANGELOG.md` and add under `## [Unreleased]` → `### New Features`:

```markdown
### New Features

- Workspace support: manage multiple repositories under a single `codegraph-workspace.yaml`. Use `codegraph workspace init`, `codegraph workspace add`, and `codegraph workspace index` to set up a workspace, then attach the MCP server to the workspace root — `codegraph_explore` and `codegraph_search` automatically fan out across all indexed repos and return attributed results.
```

- [ ] **Step 5: Commit**

```bash
git add __tests__/workspace.test.ts CHANGELOG.md
git commit -m "feat(workspace): add end-to-end integration test and CHANGELOG entry"
```

---

## Self-Review Checklist (already run — issues fixed inline)

- **Spec coverage:** All 9 spec sections covered: config, registry, manager, CLI (7 commands), ToolHandler fanout (explore/search/status/files), MCPEngine wiring, tests (unit + integration + regression), non-goals documented in spec.
- **Placeholder scan:** No TBDs. All code blocks are complete and runnable.
- **Type consistency:**
  - `WorkspaceManager` constructor, `setWorkspace`, `getRepoName`, `openAllCodeGraphs` all consistent across tasks 3, 5, 6.
  - `RepoRecord` fields match the SQL schema and the `addRepo` call sites throughout.
  - `ToolHandler` constructor change in Task 5 is backward-compatible (second arg optional).
  - `ExtractionError` shape (`message`, `severity`) matches `src/types.ts:263`.
  - `loadWorkspaceManager()` lazy-require in engine.ts matches the export name `WorkspaceManager` from `manager.ts`.
