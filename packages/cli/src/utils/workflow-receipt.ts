import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

export interface WorkflowReceipt {
  version: 1;
  runId: WorkflowRun['id'];
  workflowName: WorkflowRun['workflow_name'];
  status: WorkflowRun['status'];
  outcome: WorkflowRun['outcome'];
}

export async function writeWorkflowReceipt(path: string, run: WorkflowRun): Promise<void> {
  const receipt: WorkflowReceipt = {
    version: 1,
    runId: run.id,
    workflowName: run.workflow_name,
    status: run.status,
    outcome: run.outcome,
  };
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
