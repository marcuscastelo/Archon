import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SCRIPT_PATH = join(
  REPO_ROOT,
  '.archon',
  'workflows',
  'sdlc',
  'deliver',
  'scripts',
  'check-post-ready.py'
);
const PYTHON_COMMAND = globalThis.process.platform === 'win32' ? 'python' : 'python3';
const PYTHON = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("post_ready", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
data = json.load(sys.stdin)
try:
    print(json.dumps(module.classify(data["payload"], data["required"], module.timestamp(data["ready_after"]), data["head"], data["pre_ready"])))
except ValueError as error:
    print(str(error), file=sys.stderr)
    raise SystemExit(2)
`;

type StatusRow = Record<string, string>;

async function classify(
  rows: StatusRow[],
  preReady: StatusRow[] = [],
  markerHead = 'a'.repeat(40),
  payloadHead = markerHead
) {
  const process = Bun.spawn([PYTHON_COMMAND, '-c', PYTHON, SCRIPT_PATH], {
    cwd: REPO_ROOT,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  process.stdin.write(
    JSON.stringify({
      payload: { isDraft: false, headRefOid: payloadHead, statusCheckRollup: rows },
      required: ['CodeRabbit'],
      ready_after: '2026-09-13T07:00:00Z',
      head: markerHead,
      pre_ready: preReady,
    })
  );
  process.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('post-ready check gate', () => {
  it('does not accept a skipped status from the draft phase', async () => {
    const skipped = {
      __typename: 'StatusContext',
      context: 'CodeRabbit',
      startedAt: '2026-09-13T07:00:00Z',
      state: 'SUCCESS',
    };
    const result = await classify([skipped], [skipped]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'pending',
      detail: 'CodeRabbit (no run started after ready)',
    });
  });

  it('accepts a successful status started after the ready transition', async () => {
    const result = await classify([
      {
        __typename: 'StatusContext',
        context: 'CodeRabbit',
        startedAt: '2026-09-13T07:00:01Z',
        state: 'SUCCESS',
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'post-ready checks passed: CodeRabbit',
    });
  });

  it('fails when a fresh required check concludes skipped', async () => {
    const result = await classify([
      {
        __typename: 'CheckRun',
        name: 'CodeRabbit',
        startedAt: '2026-09-13T07:00:01Z',
        status: 'COMPLETED',
        conclusion: 'SKIPPED',
      },
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('required post-ready check failed: CodeRabbit (SKIPPED)');
  });

  it('fails when the PR head no longer matches the ready marker', async () => {
    const result = await classify([], [], 'b'.repeat(40), 'c'.repeat(40));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('the pull request head changed');
  });
});
