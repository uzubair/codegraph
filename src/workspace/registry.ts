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
    const ALLOWED_COLUMNS = new Set(['path', 'status', 'last_indexed_at', 'branch', 'commit_sha', 'remote_url', 'primary_language']);
    const entries = Object.entries(updates).filter(([k, v]) => v !== undefined && ALLOWED_COLUMNS.has(k));
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
