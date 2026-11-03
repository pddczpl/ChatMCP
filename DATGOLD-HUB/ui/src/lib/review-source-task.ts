// The source of review the Review tab uses: the files a conversation changed, read from the Hub's task-review (docs/REVIEW-API.md), and the three things a person can do with them. The
// calls to the Hub are brought in (lib/api.ts has them), so that this is plain code a test can run. A Hub error reaches the caller as it came, with its status and code.
import type { ReviewFile, ReviewLimitation, ReviewSnapshot, ReviewSource } from './review-source.ts';

export interface TaskReviewApi {
  getTaskReview(taskId: string): Promise<{
    taskId?: string;
    checkpoints?: { total: number; targeted: number; broad: number };
    files?: ReviewFile[];
    truncated?: boolean;
    omitted?: { protected?: number };
    limitations?: ReviewLimitation[];
  }>;
  saveFile(file: string, content: string, expectedSha: string): Promise<{ sha256?: string }>;
  acceptFile(checkpointId: string, file: string, expectedSha: string): Promise<unknown>;
  rejectCreated(taskId: string, file: string, expectedSha: string): Promise<unknown>;
}

export function taskCheckpointSource(taskId: string, api: TaskReviewApi): ReviewSource {
  return {
    kind: 'task-checkpoint',
    async load(): Promise<ReviewSnapshot> {
      const answer = await api.getTaskReview(taskId);
      return {
        taskId: answer.taskId ?? taskId,
        checkpoints: answer.checkpoints,
        files: Array.isArray(answer.files) ? answer.files : [],
        truncated: Boolean(answer.truncated),
        omitted: { protected: Number(answer.omitted?.protected) || 0 },
        limitations: Array.isArray(answer.limitations) ? answer.limitations : [],
      };
    },
    async saveText(path, content, expectedSha) {
      const saved = await api.saveFile(path, content, expectedSha);
      // The Hub always names the sha now on disk; an answer that does not gives an empty one, which carries no marks to a new sha.
      return { sha256: typeof saved?.sha256 === 'string' ? saved.sha256 : '' };
    },
    async accept(file) {
      if (!file.currentSha || !file.checkpointId) throw new TypeError();
      await api.acceptFile(file.checkpointId, file.path, file.currentSha);
    },
    async rejectCreated(file) {
      if (!file.currentSha) throw new TypeError();
      await api.rejectCreated(taskId, file.path, file.currentSha);
    },
  };
}
