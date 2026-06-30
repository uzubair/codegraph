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
    CodeGraph.initSync(repoDir).close();
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
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_explore', { query: 'hello' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/not initialized|No CodeGraph project/i);
  });

  it('fanout searches all indexed repos and attributes results', async () => {
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
    const result = await handler.execute('codegraph_explore', { query: 'soloFn', projectPath: repoA });
    expect(result.isError).toBeFalsy();
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
