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
