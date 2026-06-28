/**
 * Front-load hook project resolution (#964).
 *
 * The Claude `UserPromptSubmit` front-load hook must inject CodeGraph context
 * for the RIGHT project — including the monorepo case where the agent's cwd is
 * an un-indexed workspace root and the index lives in a sub-project. These test
 * `planFrontload` / `findIndexedSubprojectRoots` directly (the hook's decision
 * logic), since the end-to-end hook is validated by a live agent run, not a
 * unit test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planFrontload, findIndexedSubprojectRoots, isStructuralPrompt, hasStructuralKeyword, extractCodeTokens, isShortMessage, isCoordinationResponse, extractInjectedFiles, shouldSuppressInjection, readHookSession, writeHookSession, getHookSessionPath } from '../src/directory';

/** Make `dir` look indexed (isInitialized needs `.codegraph/codegraph.db`). */
function mkIndexed(dir: string): string {
  fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '');
  return dir;
}
/** A workspace-root manifest so the down-scan gate (looksLikeProjectRoot) passes. */
function mkWorkspaceRoot(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"workspaces":["packages/*"]}');
  return dir;
}

describe('planFrontload — front-load hook project resolution (#964)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-frontload-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('cwd is itself indexed → front-load cwd (the common single-project case)', () => {
    mkIndexed(tmp);
    const plan = planFrontload(tmp, 'how does login work');
    expect(plan.exploreRoot).toBe(tmp);
    expect(plan.viaSubScan).toBe(false);
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('a nested file under an indexed project resolves up to that project', () => {
    mkIndexed(tmp);
    const nested = path.join(tmp, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(planFrontload(nested, 'trace the flow').exploreRoot).toBe(tmp);
  });

  it('un-indexed workspace root with ONE indexed sub-project → front-load it (the #964 case)', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const plan = planFrontload(tmp, 'how does the request get handled');
    expect(plan.exploreRoot).toBe(api);
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('multiple indexed sub-projects, prompt names one by path → front-load it, nudge the rest', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'in packages/api, how does the handler validate the token?');
    expect(plan.exploreRoot).toBe(api);
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects).toEqual([web]);
  });

  it('multiple indexed sub-projects, prompt names one by package name → front-load it', () => {
    mkWorkspaceRoot(tmp);
    mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'how does the web frontend render the dashboard?');
    expect(plan.exploreRoot).toBe(web);
  });

  it('multiple indexed sub-projects, NO clear match → nudge the full list, do not guess', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'how does authentication work end to end?');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects.sort()).toEqual([api, web].sort());
  });

  it('un-indexed dir that is NOT a workspace root → no-op (guards $HOME-style crawls)', () => {
    // Indexed project exists below, but cwd has no manifest, so the down-scan is skipped.
    mkIndexed(path.join(tmp, 'some', 'project'));
    const plan = planFrontload(tmp, 'how does it work');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('nothing indexed anywhere → no-op', () => {
    mkWorkspaceRoot(tmp);
    fs.mkdirSync(path.join(tmp, 'packages', 'api'), { recursive: true });
    const plan = planFrontload(tmp, 'how does it work');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.nudgeProjects).toEqual([]);
  });
});

describe('findIndexedSubprojectRoots', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-subscan-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('finds indexed projects a couple levels down and skips node_modules/.git', () => {
    mkIndexed(path.join(tmp, 'packages', 'api'));
    mkIndexed(path.join(tmp, 'services', 'auth'));
    // Decoys that must NOT be scanned into.
    mkIndexed(path.join(tmp, 'node_modules', 'dep'));
    mkIndexed(path.join(tmp, '.git', 'x'));
    const found = findIndexedSubprojectRoots(tmp).map((p) => path.relative(tmp, p)).sort();
    expect(found).toEqual([path.join('packages', 'api'), path.join('services', 'auth')].sort());
  });

  it('does not descend INTO an indexed project (a project\'s sub-dirs are not separate projects)', () => {
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    mkIndexed(path.join(api, 'submodule')); // nested index under an already-indexed project
    const found = findIndexedSubprojectRoots(tmp);
    expect(found).toEqual([api]);
  });

  it('respects the depth bound', () => {
    mkIndexed(path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'deep'));
    expect(findIndexedSubprojectRoots(tmp, { maxDepth: 2 })).toEqual([]);
  });
});

describe('hasStructuralKeyword — keyword signal fires the hook directly (#994)', () => {
  it('English keywords match, with `\\b` so "flow" ≠ "flower"', () => {
    expect(hasStructuralKeyword('how does article publish work')).toBe(true);
    expect(hasStructuralKeyword('where is the token validated')).toBe(true);
    expect(hasStructuralKeyword('trace the request flow')).toBe(true);
    expect(hasStructuralKeyword('what calls parseToken')).toBe(true);
    expect(hasStructuralKeyword('water the flower')).toBe(false);   // "flow" in "flower"
  });

  it('Chinese keywords match WITHOUT `\\b` — the #994 fix (were silently dropped)', () => {
    expect(hasStructuralKeyword('介绍文章发布流程')).toBe(true);      // introduce / flow
    expect(hasStructuralKeyword('登录是如何实现的')).toBe(true);       // how / implement
    expect(hasStructuralKeyword('这个函数的调用链')).toBe(true);        // call (chain)
    expect(hasStructuralKeyword('支付模块依赖哪些服务')).toBe(true);    // depend
    expect(hasStructuralKeyword('修复这个拼写错误')).toBe(false);       // "fix this typo"
  });

  it('a bare code-token is NOT a keyword — it needs graph verification', () => {
    expect(hasStructuralKeyword('看看 get_user 这段逻辑')).toBe(false);
    expect(hasStructuralKeyword('I really love JavaScript')).toBe(false);
  });
});

describe('extractCodeTokens — candidate symbols the hook verifies against the graph', () => {
  it('pulls camelCase / PascalCase / snake_case / call / member tokens', () => {
    expect(extractCodeTokens('prepareArticlePublish 的调用链')).toContain('prepareArticlePublish');
    expect(extractCodeTokens('看看 get_user 这段逻辑')).toContain('get_user');   // snake_case
    expect(extractCodeTokens('render() 在哪触发')).toContain('render');          // call form
    expect(extractCodeTokens('user.login 做了什么').sort()).toEqual(['login', 'user']); // member access
    expect(extractCodeTokens('看看 UserService')).toContain('UserService');      // PascalCase class kept
  });

  it('a tech brand is extracted as a CANDIDATE — the hook’s graph check is what rejects it', () => {
    // This is the #994 follow-up: "JavaScript" is identifier-shaped, so it surfaces
    // here as a candidate; the hook only fires if it's a real symbol in the index.
    expect(extractCodeTokens('I really love JavaScript')).toEqual(['JavaScript']);
    expect(extractCodeTokens('thoughts on GitHub vs GitLab').sort()).toEqual(['GitHub', 'GitLab']);
  });

  it('ordinary prose and doc/data filenames yield no tokens', () => {
    expect(extractCodeTokens('fix typo in readme')).toEqual([]);
    expect(extractCodeTokens('fix the typo in README.md')).toEqual([]);   // doc filename excluded
    expect(extractCodeTokens('bump the version in package.json')).toEqual([]);
    expect(extractCodeTokens('water the flower')).toEqual([]);
  });
});

describe('isStructuralPrompt — cheap candidate gate (keyword OR code-token)', () => {
  it('fires on a keyword prompt in any language', () => {
    expect(isStructuralPrompt('how does article publish work')).toBe(true);
    expect(isStructuralPrompt('介绍文章发布流程')).toBe(true);
  });

  it('fires on a code-token prompt with no keyword', () => {
    expect(isStructuralPrompt('看看 get_user 这段逻辑')).toBe(true);
    expect(isStructuralPrompt('where is prepareArticlePublish 定义')).toBe(true);
    expect(isStructuralPrompt('user.login 做了什么')).toBe(true);
  });

  it('a tech brand passes the CHEAP gate as a candidate — the hook then graph-verifies it', () => {
    // Layering, not a bug: isStructuralPrompt is shape-only, so a token-shaped brand
    // is a candidate here; the hook rejects it as a non-symbol (proven by the CLI e2e).
    expect(isStructuralPrompt('I really love JavaScript')).toBe(true);
  });

  it('non-structural prose stays a no-op — in either language', () => {
    expect(isStructuralPrompt('fix typo in readme')).toBe(false);
    expect(isStructuralPrompt('修复这个拼写错误')).toBe(false);
    expect(isStructuralPrompt('water the flower')).toBe(false);
    expect(isStructuralPrompt('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 1: isShortMessage
// ---------------------------------------------------------------------------

describe('isShortMessage — rejects prompts with fewer than 4 words', () => {
  it('returns true for empty/blank', () => {
    expect(isShortMessage('')).toBe(true);
    expect(isShortMessage('   ')).toBe(true);
  });

  it('returns true for 1–3 word messages', () => {
    expect(isShortMessage('Yes')).toBe(true);
    expect(isShortMessage('Ok')).toBe(true);
    expect(isShortMessage('Do 1 and')).toBe(true); // 3 words
    expect(isShortMessage('Go ahead')).toBe(true);
  });

  it('returns false for 4+ word messages', () => {
    expect(isShortMessage('Do 1 and 2')).toBe(false); // 4 words
    expect(isShortMessage('how does login work')).toBe(false);
    expect(isShortMessage('implement option 2 please')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 1: isCoordinationResponse
// ---------------------------------------------------------------------------

describe('isCoordinationResponse — whole-message pure-response patterns', () => {
  it('matches single affirmatives (case-insensitive, trailing punctuation stripped)', () => {
    expect(isCoordinationResponse('yes')).toBe(true);
    expect(isCoordinationResponse('Yes.')).toBe(true);
    expect(isCoordinationResponse('YES!')).toBe(true);
    expect(isCoordinationResponse('no')).toBe(true);
    expect(isCoordinationResponse('ok')).toBe(true);
    expect(isCoordinationResponse('sure')).toBe(true);
    expect(isCoordinationResponse('correct')).toBe(true);
    expect(isCoordinationResponse('right')).toBe(true);
    expect(isCoordinationResponse('perfect')).toBe(true);
    expect(isCoordinationResponse('agreed')).toBe(true);
    expect(isCoordinationResponse('great')).toBe(true);
    expect(isCoordinationResponse('good')).toBe(true);
  });

  it('matches approval phrases', () => {
    expect(isCoordinationResponse('sounds good')).toBe(true);
    expect(isCoordinationResponse('Sounds good.')).toBe(true);
    expect(isCoordinationResponse('that works')).toBe(true);
    expect(isCoordinationResponse('looks good')).toBe(true);
    expect(isCoordinationResponse('that makes sense')).toBe(true);
    expect(isCoordinationResponse('looks right')).toBe(true);
  });

  it('matches numbered choice phrases', () => {
    expect(isCoordinationResponse('option 2')).toBe(true);
    expect(isCoordinationResponse('go with 1')).toBe(true);
    expect(isCoordinationResponse('do 1 and 2')).toBe(true);
    expect(isCoordinationResponse('1 and 2')).toBe(true);
  });

  it('does NOT match when message has substantive content beyond the pattern', () => {
    expect(isCoordinationResponse('yes, that implementation is correct')).toBe(false);
    expect(isCoordinationResponse('yes and also fix the bug')).toBe(false);
    expect(isCoordinationResponse('looks good but add error handling')).toBe(false);
  });

  it('does NOT filter substantive questions that happen to contain these words', () => {
    expect(isCoordinationResponse('implement option 2 in the auth module')).toBe(false);
    expect(isCoordinationResponse('how should we structure this?')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isCoordinationResponse('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: extractInjectedFiles
// ---------------------------------------------------------------------------

describe('extractInjectedFiles — parses **`path`** file headers from explore output', () => {
  it('extracts file paths from a typical explore response', () => {
    const text = [
      '**`src/auth/token.ts`** — parseToken(function), validateJWT(function)',
      '```typescript',
      'code here',
      '```',
      '**`src/middleware/index.ts`** — authMiddleware(function)',
    ].join('\n');
    expect(extractInjectedFiles(text).sort()).toEqual(['src/auth/token.ts', 'src/middleware/index.ts'].sort());
  });

  it('returns empty array when no file headers are present', () => {
    expect(extractInjectedFiles('No file headers here — just prose.')).toEqual([]);
    expect(extractInjectedFiles('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: shouldSuppressInjection
// ---------------------------------------------------------------------------

describe('shouldSuppressInjection — dedup decision logic', () => {
  const now = Date.now();
  const TTL = 30 * 60 * 1000;

  it('does not suppress on cold start (empty session)', () => {
    const session = { lastActivity: 0, injectedFiles: [] };
    expect(shouldSuppressInjection(session, ['a.ts', 'b.ts'], now, TTL)).toBe(false);
  });

  it('does not suppress when session is expired', () => {
    const old = now - TTL - 1000;
    const session = { lastActivity: old, injectedFiles: ['a.ts', 'b.ts'] };
    expect(shouldSuppressInjection(session, ['a.ts', 'b.ts'], now, TTL)).toBe(false);
  });

  it('suppresses when 100% of files already seen', () => {
    const session = { lastActivity: now - 1000, injectedFiles: ['a.ts', 'b.ts'] };
    expect(shouldSuppressInjection(session, ['a.ts', 'b.ts'], now, TTL)).toBe(true);
  });

  it('suppresses at exactly the 70% threshold', () => {
    // 7 of 10 new files already seen → 70% → suppress
    const seen = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    const newFiles = [...seen, 'h.ts', 'i.ts', 'j.ts'];
    const session = { lastActivity: now - 1000, injectedFiles: seen };
    expect(shouldSuppressInjection(session, newFiles, now, TTL)).toBe(true);
  });

  it('does not suppress just below the 70% threshold', () => {
    // 6 of 10 new files already seen → 60% → inject
    const seen = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
    const newFiles = [...seen, 'g.ts', 'h.ts', 'i.ts', 'j.ts'];
    const session = { lastActivity: now - 1000, injectedFiles: seen };
    expect(shouldSuppressInjection(session, newFiles, now, TTL)).toBe(false);
  });

  it('does not suppress when newFiles is empty', () => {
    const session = { lastActivity: now - 1000, injectedFiles: ['a.ts'] };
    expect(shouldSuppressInjection(session, [], now, TTL)).toBe(false);
  });

  it('respects TTL=0 as "no session" (never suppress)', () => {
    const session = { lastActivity: now - 1000, injectedFiles: ['a.ts', 'b.ts'] };
    expect(shouldSuppressInjection(session, ['a.ts', 'b.ts'], now, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: readHookSession / writeHookSession / getHookSessionPath
// ---------------------------------------------------------------------------

describe('readHookSession / writeHookSession — session state I/O', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-session-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function mkIndexed(dir: string): string {
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '');
    return dir;
  }

  it('returns empty session when no state file exists (cold start)', () => {
    mkIndexed(tmp);
    const s = readHookSession(tmp);
    expect(s.lastActivity).toBe(0);
    expect(s.injectedFiles).toEqual([]);
  });

  it('round-trips a session through write + read', () => {
    mkIndexed(tmp);
    const session = { lastActivity: 1234567890, injectedFiles: ['src/a.ts', 'src/b.ts'] };
    writeHookSession(tmp, session);
    const loaded = readHookSession(tmp);
    expect(loaded.lastActivity).toBe(session.lastActivity);
    expect(loaded.injectedFiles).toEqual(session.injectedFiles);
  });

  it('returns empty session on malformed JSON', () => {
    mkIndexed(tmp);
    fs.writeFileSync(path.join(tmp, '.codegraph', '.hook-session.json'), 'not-json', 'utf-8');
    const s = readHookSession(tmp);
    expect(s.lastActivity).toBe(0);
    expect(s.injectedFiles).toEqual([]);
  });

  it('getHookSessionPath lives inside .codegraph/', () => {
    mkIndexed(tmp);
    expect(getHookSessionPath(tmp)).toContain('.codegraph');
    expect(getHookSessionPath(tmp)).toContain('.hook-session.json');
  });
});
