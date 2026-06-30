# Workspace Feature Design

**Date:** 2026-06-29
**Status:** Approved

## Goal

Introduce a first-class Workspace that manages many repositories, enables multi-repo search, and exposes a unified MCP interface for AI agents. The existing single-repository workflow must continue to work unchanged.

**Deferred for a follow-on:** cross-repo import/symbol edge resolution.

## Design Principles

- Do not rewrite the existing indexing engine.
- Treat each repository as an independent CodeGraph instance.
- Build a workspace orchestration layer above the existing `ToolHandler`.
- Minimize changes that would make future upstream rebases difficult.

---

## 1. Architecture Overview

### New module: `src/workspace/`

Three new files, no external dependencies:

**`src/workspace/config.ts`**
Reads and writes `codegraph-workspace.yaml` at the workspace root. The YAML format is simple enough to parse with a hand-rolled scanner (same approach as `src/resolution/workspace-packages.ts` for pnpm), avoiding a new dependency.

```yaml
name: company

repositories:
  - name: frontend
    path: ./repositories/frontend
  - name: backend
    path: ./repositories/backend
  - name: shared
    path: ./repositories/shared
```

**`src/workspace/registry.ts`**
`WorkspaceRegistry` class backed by `workspace.db` (SQLite via `node:sqlite`, same stack as per-project DBs). Provides `addRepo`, `removeRepo`, `listRepos`, `updateRepoStatus` operations against the repos table.

**`src/workspace/manager.ts`**
`WorkspaceManager` class. Owns the registry, orchestrates all workspace CLI operations, and exposes `openAllCodeGraphs()` for the MCP fanout path.

### Narrow additions to two existing files

**`src/mcp/engine.ts`** — on startup, calls `WorkspaceManager.findNearest(root)`. If found, passes it as the second constructor argument to `ToolHandler`.

**`src/mcp/tools.ts`** — `ToolHandler` accepts an optional `WorkspaceManager`. A new private `fanoutSearch` method fans out queries to all registered repos when `projectPath` is absent and a workspace is attached.

The daemon, proxy, query pool, and worker threads are untouched.

---

## 2. Data Model

### `codegraph-workspace.yaml`

Located at the workspace root. Fields:

| Field | Type | Description |
|---|---|---|
| `name` | string | Human-readable workspace name |
| `repositories` | array | List of member repos |
| `repositories[].name` | string | Logical name used in output attribution and CLI commands |
| `repositories[].path` | string | Path relative to the workspace root |

### `workspace.db`

Located at `<workspace-root>/.codegraph/workspace.db`. The workspace root does **not** get `codegraph init` run on it — `.codegraph/` here is created by `workspace init` as a workspace-only directory, containing only `workspace.db`.

#### Schema

```sql
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,  -- absolute path; UNIQUE prevents duplicate registrations
  status TEXT NOT NULL,       -- 'indexed' | 'pending' | 'error'
  last_indexed_at INTEGER,
  branch TEXT,
  commit_sha TEXT,
  remote_url TEXT,
  primary_language TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE workspace_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`workspace_metadata` stores workspace name, creation timestamp, and schema version (same pattern as `project_metadata` in `schema.sql`).

---

## 3. WorkspaceManager

```typescript
class WorkspaceManager {
  // Lifecycle
  static init(workspaceRoot: string, name: string): WorkspaceManager
  static open(workspaceRoot: string): WorkspaceManager
  static findNearest(startPath: string): WorkspaceManager | null  // walks up from startPath

  // Registry operations
  addRepo(repoPath: string, name?: string): Promise<void>  // runs codegraph init if needed, then registers
  removeRepo(name: string): void                           // removes from registry only; leaves .codegraph/ intact
  listRepos(): RepoRecord[]

  // Indexing
  indexAll(options?: IndexOptions): Promise<IndexResult[]>  // runs indexAll() on each repo in parallel

  // Status
  getStatus(): WorkspaceStatus   // { total, indexed, pending, errored }
  doctor(): DoctorResult[]       // checks: path exists? indexed? stale?

  // MCP fanout support
  openAllCodeGraphs(): CodeGraph[]  // opens all repos with status='indexed' via CodeGraph.openSync

  getWorkspaceRoot(): string
  close(): void
}
```

**`addRepo` behavior:**
1. Resolve the path to absolute.
2. Check if `path` already exists in the `repos` table → no-op if so.
3. If the repo does not have a `.codegraph/` directory, run `CodeGraph.init(repoPath)`.
4. Insert a row with `status='pending'` and `added_at=now`.
5. Update `codegraph-workspace.yaml` to include the new entry.

**`findNearest` behavior:** walks up the directory tree from `startPath` looking for `codegraph-workspace.yaml`, identical in structure to `findNearestCodeGraphRoot` in `src/directory.ts`. Returns `null` if not found.

---

## 4. CLI Commands

A `workspace` subcommand group is added to `src/bin/codegraph.ts` using the same `.command()` pattern as all existing commands. All workspace commands call `WorkspaceManager.findNearest(process.cwd())` to locate the workspace, matching the UX of `git` commands finding `.git/`.

| Command | Behavior |
|---|---|
| `codegraph workspace init [path]` | Creates `codegraph-workspace.yaml` + `.codegraph/workspace.db` at path (default: cwd). Errors if one already exists. |
| `codegraph workspace add <path> [--name <name>]` | Registers repo, runs `codegraph init` if needed. |
| `codegraph workspace remove <name>` | Removes from registry; leaves `.codegraph/` on disk. |
| `codegraph workspace index` | Indexes all registered repos, shows per-repo shimmer progress. |
| `codegraph workspace list` | Lists repos with status, last-indexed timestamp, branch, commit SHA. |
| `codegraph workspace status` | Summary line (N indexed / N total) + per-repo health. |
| `codegraph workspace doctor` | Checks each repo: path exists, `.codegraph/` present, index not stale. Reports problems. |

---

## 5. ToolHandler Workspace Fanout

### Constructor

```typescript
constructor(cg: CodeGraph | null, workspace?: WorkspaceManager) {
  this.cg = cg;
  this.workspace = workspace ?? null;
}
```

All existing call sites pass only `cg` — no change required.

### Fanout trigger

The workspace fanout activates when **both** conditions hold:
1. `this.workspace != null`
2. The tool call has no `projectPath` argument

If `projectPath` is provided, the existing single-project path runs unchanged. Agents already using `projectPath` see zero behavior change.

### `codegraph_explore` fanout

One output block per repo, prefixed with a repo-name header (`## [backend]`). Total output is capped at the existing `getExploreOutputBudget(totalFileCount)` limit; per-repo budget is `totalBudget / repoCount` (minimum 1 call per repo).

### Search tools fanout (`codegraph_explore` in query mode, symbol search)

Results from all repos are merged and re-ranked by score, with each result attributed to its repo in the output text.

### `codegraph_status` fanout

Reports status for every registered repo in sequence — indexed file count, last sync time, watcher state.

### Tools that do NOT fan out

`codegraph_files` requires a specific project scope. When workspace is active and `projectPath` is absent, it returns an error guiding the agent to pass `projectPath`.

---

## 6. MCPEngine Integration

Single addition in `MCPEngine.initialize()`:

```typescript
const workspace = WorkspaceManager.findNearest(root);
if (workspace) {
  this.toolHandler = new ToolHandler(cg, workspace);
} else {
  this.toolHandler = new ToolHandler(cg);
}
```

The daemon, proxy, query pool, and worker threads are not changed. Workspace fanout runs on the main thread where the injected `WorkspaceManager` lives; per-repo queries inside the fanout use the same `CodeGraph.openSync` path that workers already use for `projectPath` calls.

---

## 7. Testing

New test file: `__tests__/workspace.test.ts`

Uses the same pattern as existing tests: real SQLite, real files in `fs.mkdtempSync`, no mocks, `afterEach` cleanup.

### Unit tests

| Test | Verifies |
|---|---|
| `workspace init` creates `codegraph-workspace.yaml` + `workspace.db` | Config + DB bootstrapped correctly |
| `workspace add` on an uninitialized repo runs `codegraph init` | Auto-init |
| `workspace add` on an already-initialized repo skips init | Idempotent |
| `workspace add` with a duplicate path is a no-op | No duplicate rows |
| `workspace remove` deletes registry row, leaves `.codegraph/` on disk | Registry-only removal |
| `WorkspaceManager.findNearest` finds workspace from a subdirectory | Walk-up detection |
| `workspace list` returns all registered repos | Registry reads correctly |
| `workspace index` updates `last_indexed_at` after indexing | Indexing + timestamp |

### Integration test

Synthetic workspace:

```
tmp/workspace/
  codegraph-workspace.yaml
  frontend/   ← minimal TS source files
  backend/    ← minimal TS source files
  shared/     ← minimal TS source files with a symbol unique to shared
```

Verify: a `ToolHandler` with an attached `WorkspaceManager` finds the symbol defined only in `shared/` when `codegraph_explore` is called with no `projectPath`.

### Regression test

Verify: a `ToolHandler` constructed without a `WorkspaceManager` behaves identically to the current behavior on all existing tool calls.

---

## 8. Non-Goals (this version)

- Cross-repo import/symbol edge resolution (e.g., wiring `frontend imports User from shared` as a graph edge). Deferred.
- Workspace-wide rename or refactoring.
- Git repository cloning / submodule support.
- Cargo workspaces, npm workspaces, Gradle, Bazel auto-discovery.
- Architecture visualization or dependency cycle detection.
- GitHub / Jira / Fleet integration.
- Worker thread support for workspace fanout (runs on main thread; sufficient for the initial use case).

---

## 9. Success Criteria

After implementation, the following workflow must work end-to-end:

```bash
codegraph workspace init
codegraph workspace add ./frontend
codegraph workspace add ./backend
codegraph workspace add ./payments
codegraph workspace index
```

Then, with the MCP server attached to the workspace root, an agent must be able to ask:

- "Where is `User` defined across the workspace?" — returns result attributed to the repo that defines it.
- "Show every repository using `PaymentStatus`." — returns results from all repos that reference it.
- "What breaks if I change this API?" — impact radius across all repos via per-repo `codegraph_explore`.

All existing single-repo workflows (`codegraph init`, `codegraph index`, `codegraph serve --mcp` on a non-workspace root) must continue to work unchanged.
