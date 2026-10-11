import { beijingParts } from './workflow-workspace.js';

export const MAX_WORKFLOW_VERSIONS = 30;

export function beijingDateStamp(date = new Date()): string {
  const parts = beijingParts(date);
  return `${parts.year}${parts.month}${parts.day}`;
}

/** Build label like v1-20261011 from 1-based seq. */
export function formatWorkflowVersionLabel(seq: number, date = new Date()): string {
  if (!Number.isInteger(seq) || seq < 1) throw new Error('version seq must be a positive integer');
  return `v${seq}-${beijingDateStamp(date)}`;
}

export function nextWorkflowVersionSeq(maxSeq: number | null | undefined): number {
  const current = typeof maxSeq === 'number' && Number.isInteger(maxSeq) && maxSeq > 0 ? maxSeq : 0;
  return current + 1;
}

/** Versions to drop when keeping at most `limit` newest (by seq ascending = oldest first). */
export function versionsToPrune<T extends { seq: number }>(rows: T[], limit = MAX_WORKFLOW_VERSIONS): T[] {
  if (rows.length <= limit) return [];
  const ordered = [...rows].sort((left, right) => left.seq - right.seq);
  return ordered.slice(0, ordered.length - limit);
}
