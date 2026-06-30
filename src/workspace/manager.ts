import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceRegistry, RepoRecord, WORKSPACE_DB_FILENAME } from './registry';
import {
  readWorkspaceConfig,
  writeWorkspaceConfig,
  findNearestWorkspaceRoot,
  WORKSPACE_CONFIG_FILENAME,
} from './config';
import { isInitialized } from '../directory';
import CodeGraph from '../index';
import type { IndexOptions } from '../index';
import type { IndexResult } from '../extraction';
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

const loadCodeGraph = (): typeof CodeGraph => CodeGraph;

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
      const cg = loadCodeGraph().openSync(repo.path);
      try {
        const result = await cg.indexAll(options);
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
      } finally {
        try { cg.close(); } catch { /* ignore */ }
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
    const opts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ('ignore' | 'pipe')[] };
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    const sha = execSync('git rev-parse --short HEAD', opts).trim();
    return { branch: branch || null, sha: sha || null };
  } catch {
    return { branch: null, sha: null };
  }
}
