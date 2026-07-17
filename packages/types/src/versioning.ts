export interface VersionCheckpointSummary {
  version: 1;
  id: string;
  reason: 'bootstrap' | 'run-complete' | 'shutdown-freeze' | 'rollback';
  status: 'complete' | 'partial';
  createdAt: string;
  dataCommit?: string;
  workspace?: {
    repositoryId: string;
    beforeCommit?: string;
    commit?: string;
    trackedPathCount: number;
  };
  warningCodes: string[];
}

export interface VersionCheckpointManifest {
  version: 1;
  id: string;
  reason: VersionCheckpointSummary['reason'];
  status: 'pending' | VersionCheckpointSummary['status'];
  createdAt: string;
  completedAt?: string;
  runId?: string;
  sessionId?: string;
  rollbackOf?: string;
  data: {
    repositoryId: 'littlesheep-data';
    beforeCommit?: string;
    commit?: string;
    trackedPathCount: number;
  };
  workspace?: {
    repositoryId: string;
    beforeCommit?: string;
    commit?: string;
    trackedPaths: string[];
  };
  warningCodes: string[];
}
