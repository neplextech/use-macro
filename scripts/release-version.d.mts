export interface ReleaseRequest {
  version: string;
  tag: string;
}

export interface ParseReleaseOptions {
  trigger?: 'dispatch' | 'push';
  timestamp?: number;
}

export function parseReleaseInput(input: string, currentVersion: string, options?: ParseReleaseOptions): ReleaseRequest;
export function parsePushCommit(subject: string, currentVersion: string): ReleaseRequest | undefined;
