import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const sha = 'a'.repeat(40);
const passing = {
	id: 123,
	event: 'push',
	head_branch: 'main',
	head_sha: sha,
	status: 'completed',
	conclusion: 'success'
};

function gate(runs, main = sha, failApi = false) {
	const dir = mkdtempSync(join(tmpdir(), 'pages-gate-'));
	try {
		writeFileSync(
			join(dir, 'gh'),
			`#!/usr/bin/env bash
set -eu
[[ "$1" == api ]]
if [[ "\${FAIL_API}" == yes ]]; then exit 1; fi
if [[ "$*" == *'/actions/workflows/publish-dist.yml/runs?'* ]]; then
  [[ "$*" == *'event=push&branch=main&head_sha=${sha}'* && "$*" == *--paginate* ]]
  printf '%s' "$RUNS" | jq -r "\${!#}"
elif [[ "$2" == 'repos/example/repo/git/ref/heads/main' ]]; then
  printf '%s' "$MAIN" | jq -r "\${!#}"
else
  exit 1
fi
`,
			{ mode: 0o755 }
		);
		return spawnSync('bash', ['scripts/check-pages-deployment.sh'], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${dir}:${process.env.PATH}`,
				GH_REPO: 'example/repo',
				TARGET_SHA: sha,
				RUNS: JSON.stringify({ workflow_runs: runs }),
				MAIN: JSON.stringify({ object: { sha: main } }),
				FAIL_API: failApi ? 'yes' : 'no'
			}
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('accepts a successful main push for the current commit', () => {
	assert.equal(gate([passing]).status, 0);
});

test('rejects missing, incomplete, failed, manual, wrong-branch and wrong-commit runs', () => {
	for (const runs of [
		[],
		[{ ...passing, status: 'in_progress' }],
		[{ ...passing, conclusion: 'failure' }],
		[{ ...passing, event: 'workflow_dispatch' }],
		[{ ...passing, head_branch: 'other' }],
		[{ ...passing, head_sha: 'b'.repeat(40) }]
	]) {
		assert.notEqual(gate(runs).status, 0);
	}
});

test('rejects a once-passing commit after main advances', () => {
	assert.notEqual(gate([passing], 'b'.repeat(40)).status, 0);
});

test('fails closed when the API is unavailable', () => {
	assert.notEqual(gate([passing], sha, true).status, 0);
});
