// SE-01: repository secret audit. The scanner script (scripts/secret-scan.sh)
// must flag a committed secret-shaped value, respect the allowlist, and
// catch secrets that only exist in git history (removed from the tree).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../scripts/secret-scan.sh', import.meta.url));

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function runScan(repo: string, allowlist: string): { code: number; out: string } {
  try {
    const out = execFileSync(
      'bash',
      [SCRIPT, repo],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CF_SCAN_SCOPE: '.',
          CF_SCAN_HISTORY: '1',
          SECRET_SCAN_ALLOWLIST: allowlist,
        },
        timeout: 30000,
      },
    );
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 99, out: String(err.stdout ?? '') + String(err.stderr ?? '') };
  }
}

describe('secret-scan.sh (SE-01)', () => {
  let repo: string;
  let allowlist: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    allowlist = join(repo, 'allowlist.txt');
    writeFileSync(allowlist, '');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    mkdirSync(join(repo, 'src'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function commitConfig(body: string): void {
    writeFileSync(join(repo, 'src', 'config.ts'), body);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add config');
  }

  it('flags a committed AWS key id in the tree scan', () => {
    commitConfig(`export const AWS_KEY = 'AKIA1234567890ABCDEF';\n`);
    const r = runScan(repo, allowlist);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FINDING [tree]');
    expect(r.out).toContain('src/config.ts');
    expect(r.out).toContain('pattern=aws_access_key_id');
    // the secret value itself must never appear in scanner output
    expect(r.out).not.toContain('AKIA1234567890ABCDEF');
  });

  it('goes quiet once the finding is allowlisted', () => {
    commitConfig(`export const AWS_KEY = 'AKIA1234567890ABCDEF';\n`);
    writeFileSync(allowlist, 'src/config.ts\taws_access_key_id\ttest fixture\n');
    const r = runScan(repo, allowlist);
    expect(r.out).toContain('PASS');
    expect(r.code).toBe(0);
  });

  it('still flags a secret that was removed from the tree but lives in history', () => {
    commitConfig(`export const AWS_KEY = 'AKIA1234567890ABCDEF';\n`);
    git(repo, 'rm', '-q', 'src/config.ts');
    git(repo, 'commit', '-qm', 'remove config');
    const r = runScan(repo, allowlist);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FINDING [history]');
    expect(r.out).toContain('src/config.ts');
    expect(r.out).not.toContain('FINDING [tree]');
  });

  it('does not flag documentation placeholders', () => {
    commitConfig(`CF_SIGNING_SECRET=<redacted>\nAWS_KEY=\n`);
    const r = runScan(repo, allowlist);
    expect(r.code).toBe(0);
    expect(r.out).toContain('PASS');
  });
});
