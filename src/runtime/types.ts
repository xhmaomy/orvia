export type RuntimeSessionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

export interface RuntimeSessionInput {
  sessionId: number;
  taskId: number;
  prompt?: string;
  systemPrompt?: string;
  model?: string;
  provider?: string;
  workingDirectory?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  command?: string;
  environment?: Record<string, string>;
  onEvent?: (event: RuntimeSessionEvent) => void;
}

export interface RuntimeSessionEvent {
  sessionId: number;
  type: 'started' | 'stdout' | 'stderr' | 'activity' | 'thinking' | 'completed' | 'failed' | 'paused' | 'resumed';
  payload?: unknown;
}

export interface RuntimeSessionResult {
  sessionId: number;
  status: RuntimeSessionStatus;
  runtime: string;
  pid?: number;
  message?: string;
}

export interface AgentRuntimeAdapter {
  readonly name: string;
  start(input: RuntimeSessionInput): Promise<RuntimeSessionResult>;
  wait(sessionId: number): Promise<RuntimeSessionResult>;
  pause(sessionId: number): Promise<RuntimeSessionResult>;
  resume(sessionId: number): Promise<RuntimeSessionResult>;
  stop(sessionId: number): Promise<RuntimeSessionResult>;
  shutdown(): Promise<void>;
}
