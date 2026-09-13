import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

const realWriteFile = fs.writeFile;
const writeError = new Error('partial write EIO');
mock.module('node:fs/promises', () => ({
  ...fs,
  writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    await realWriteFile(args[0], '{"version":', args[2]);
    throw writeError;
  },
}));
const { writeWorkflowReceipt } = await import('./workflow-receipt');

const run: WorkflowRun = {
  id: 'native-run',
  workflow_name: 'plan',
  conversation_id: 'conversation',
  parent_conversation_id: null,
  codebase_id: null,
  status: 'completed',
  outcome: null,
  user_message: '',
  metadata: {},
  started_at: new Date(0),
  completed_at: new Date(1),
  last_activity_at: null,
  working_path: null,
  user_id: null,
  parent_run_id: null,
  adopted_from_run_id: null,
  output_root: null,
};

test('partial receipt write rejects without publishing JSON or leaving temporary files', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'archon-receipt-partial-'));
  const destination = join(root, 'result.json');
  try {
    await expect(writeWorkflowReceipt(destination, run)).rejects.toBe(writeError);
    expect(existsSync(destination)).toBe(false);
    expect(await fs.readdir(root)).toEqual([]);
  } finally {
    await removeTempTree(root);
  }
});
