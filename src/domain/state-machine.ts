export type RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'awaiting_decision'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskStatus =
  | 'pending'
  | 'blocked'
  | 'running'
  | 'paused'
  | 'awaiting_decision'
  | 'completed'
  | 'failed'
  | 'cancelled';

const runTransitions: Record<RunStatus, readonly RunStatus[]> = {
  pending: ['running', 'paused', 'cancelled'],
  running: ['paused', 'awaiting_decision', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  awaiting_decision: ['running', 'paused', 'failed', 'cancelled'],
  completed: ['running'],
  failed: ['running', 'paused', 'cancelled'],
  cancelled: ['running'],
};

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['blocked', 'running', 'cancelled'],
  blocked: ['pending', 'running', 'cancelled'],
  running: ['pending', 'paused', 'awaiting_decision', 'completed', 'failed', 'cancelled'],
  paused: ['pending', 'running', 'cancelled'],
  awaiting_decision: ['pending', 'blocked', 'completed', 'failed', 'cancelled'],
  completed: ['pending'], // 人工退回后上游可重跑
  failed: ['pending', 'cancelled'],
  cancelled: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return from === to || runTransitions[from].includes(to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || taskTransitions[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) throw new Error(`Invalid workflow run transition: ${from} -> ${to}`);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new Error(`Invalid task transition: ${from} -> ${to}`);
}
