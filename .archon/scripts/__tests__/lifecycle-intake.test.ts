import { describe, expect, it } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const script = resolve(import.meta.dir, '../../workflows/sdlc/lifecycle/scripts/select-target.py');
const trackTempRoot = trackTempRoots();

interface Issue {
  number: number;
  labels: { name: string }[];
  url: string;
  html_url: string;
}

function issue(number: number, labels = ['factory']): Issue {
  return {
    number,
    labels: labels.map(name => ({ name })),
    url: `https://api.github.com/repos/example/project/issues/${number}`,
    html_url: `https://github.com/example/project/issues/${number}`,
  };
}

interface Fixture {
  issues?: readonly (readonly Issue[])[];
  prs?: { title?: string; body?: string | null }[][];
  target?: string;
  label?: string;
  origin?: string;
  fail?: 'issues' | 'pulls' | 'git';
}

function runIntake(fixture: Fixture = {}): SpawnSyncReturns<string> & { root: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'lifecycle-intake-')));
  writeFileSync(join(root, 'fixture.json'), JSON.stringify(fixture));
  writeFileSync(
    join(root, 'git'),
    `#!/bin/sh
exec python3 -c 'import json,sys; f=json.load(open("fixture.json")); assert sys.argv[1:]==["remote","get-url","origin"]; print(f.get("origin", "https://github.com/example/project.git")); sys.exit(1 if f.get("fail")=="git" else 0)' "$@"
`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(root, 'gh'),
    `#!/usr/bin/env python3
import json, sys
from urllib.parse import urlsplit, parse_qs
f = json.load(open('fixture.json'))
args = sys.argv[1:]
with open('calls.jsonl', 'a') as out:
    out.write(json.dumps(args) + '\\n')
if args[0] == 'api':
    assert args[1:3] == ['--hostname', 'github.com'], args
    endpoint = urlsplit(args[3])
    assert endpoint.path in ('repos/example/project/issues', 'repos/example/project/pulls'), args
    kind = endpoint.path.rsplit('/', 1)[1]
    params = parse_qs(endpoint.query)
    assert params['state'] == ['open'] and params['per_page'] == ['100'], args
    if kind == 'issues':
        assert params.get('labels', ['']) == [f.get('label', '')], args
    else:
        assert 'labels' not in params, args
    pages = f.get('issues' if kind == 'issues' else 'prs', [[]])
    result = pages if '--paginate' in args and '--slurp' in args else pages[:1]
else:
    kind = 'issues' if args[0] == 'issue' else 'pulls'
    pages = f.get('issues' if kind == 'issues' else 'prs', [[]])
    result = pages[0]
if f.get('fail') == kind:
    print(json.dumps(result))
    print('fixture gh failure', file=sys.stderr)
    sys.exit(1)
print(json.dumps(result))
`,
    { mode: 0o755 }
  );
  const result = spawnSync('python3', [script], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ''}`,
      GH_REPO: 'other/wrong',
      GH_HOST: 'other.example',
      INPUTS_TARGET: fixture.target ?? '',
      INPUTS_INTAKE_LABEL: fixture.label ?? '',
    },
    encoding: 'utf8',
  });
  return { ...result, root };
}

function selected(fixture: Fixture, number: number): void {
  const result = runIntake(fixture);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    target: issue(number).html_url,
    found: true,
    selected: true,
  });
}

describe('lifecycle backlog intake', () => {
  it('requires exact label membership even when GitHub returns other labels', () => {
    selected(
      {
        label: 'factory',
        issues: [[issue(1, []), issue(2, ['Factory']), issue(3, ['factory-ready']), issue(4)]],
      },
      4
    );
  });

  it('excludes every archon state label and PR references in title or body', () => {
    selected(
      {
        label: 'factory',
        issues: [
          [
            issue(1, ['factory', 'archon-ready']),
            issue(2, ['factory', 'archon-blocked']),
            issue(3),
            issue(4),
            issue(5),
          ],
        ],
        prs: [[{ title: 'Fix #3', body: null }, { body: 'Closes #4' }]],
      },
      5
    );
  });

  it('preserves unrestricted intake with the default empty label', () => {
    selected({ issues: [[issue(8), issue(2, [])]] }, 2);
  });

  it('passes explicit targets through without reading git or GitHub', () => {
    const result = runIntake({ target: 'work order', label: 'factory', fail: 'git' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      target: 'work order',
      found: true,
      selected: false,
      reason: 'explicit target',
    });
    expect(() => readFileSync(join(result.root, 'calls.jsonl'))).toThrow();
  });

  it.each([{ issues: [] }, { issues: [issue(1, []), issue(2, ['factory', 'archon-ready'])] }])(
    'completes with nothing to do when no issue is eligible (%j)',
    ({ issues }) => {
      const result = runIntake({ label: 'factory', issues: [issues] });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ target: '', found: false, selected: true });
    }
  );

  it('selects the oldest across more than 100 matching issues', () => {
    selected(
      {
        label: 'factory',
        issues: [Array.from({ length: 100 }, (_, index) => issue(index + 3)), [issue(2), issue(1)]],
      },
      1
    );
  });

  it('orders issue numbers numerically across pages', () => {
    selected({ label: 'factory', issues: [[issue(10)], [issue(9)]], prs: [] }, 9);
  });

  it('excludes references on later PR pages', () => {
    selected(
      {
        label: 'factory',
        issues: [[issue(1), issue(2)]],
        prs: [Array.from({ length: 100 }, () => ({ body: '' })), [{ body: 'Fix #1' }]],
      },
      2
    );
  });

  it('does not treat REST pull requests as issues', () => {
    const pullRequest = { ...issue(1), pull_request: {} };
    selected({ issues: [[pullRequest, issue(2)]] }, 2);
  });

  it.each([
    'https://github.com/example/project.git',
    'git@github.com:example/project.git',
    'ssh://git@github.com/example/project.git',
  ])('uses origin despite ambient gh repository and host overrides (%s)', origin => {
    selected({ origin, issues: [[issue(1)]] }, 1);
  });

  it('encodes the label as query data', () => {
    const label = 'factory & é/#?';
    selected({ label, issues: [[issue(1, [label])]] }, 1);
  });

  it.each(['issues', 'pulls', 'git'] as const)(
    'fails closed on %s failure even with partial output',
    fail => {
      const result = runIntake({ label: 'factory', issues: [[issue(1)]], fail });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('select-target:');
    }
  );

  it('rejects unsupported origins before querying GitHub', () => {
    const result = runIntake({ origin: 'https://gitlab.com/example/project.git' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(() => readFileSync(join(result.root, 'calls.jsonl'))).toThrow();
  });
});
