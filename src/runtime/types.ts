export type RuntimeSessionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

export interface RuntimeSessionInput {
  sessionId: number;
  taskId: number;
  prompt?: string;
  systemPrompt?: string;
  model?: string;
  provider?: string;
  /** 传给 Pi `--api-key`。与 provider/model 成套传入时禁止回退到 Pi 本机凭证 */
  apiKey?: string;
  workingDirectory?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  /** Pi `--skill` 路径；配合 disableDefaultSkills 只加载 Orvia 勾选的 Skill */
  skillPaths?: string[];
  disableDefaultSkills?: boolean;
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
