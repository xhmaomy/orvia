import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type {
  AgentRuntimeAdapter,
  RuntimeSessionInput,
  RuntimeSessionEvent,
  RuntimeSessionResult,
} from './types.js';

interface ParsedPiOutput {
  handled: boolean;
  textDelta?: string;
  thinkingDelta?: string;
  finalText?: string;
  finalThinking?: string;
  activity?: string;
}

function describePiTool(toolName: string): string {
  if (toolName === 'read' || toolName === 'grep' || toolName === 'find' || toolName === 'ls') return '正在查看这个 Agent 的文件…';
  if (toolName === 'edit' || toolName === 'write') return '正在按指导修改这个 Agent 的文件…';
  if (toolName === 'bash') return '正在这个 Agent 的目录里执行命令…';
  return '正在处理你的指导…';
}

export function parsePiOutputLine(line: string): ParsedPiOutput {
  try {
    const event = JSON.parse(line) as {
      type?: string;
      message?: {
        role?: string;
        content?: Array<{ type?: string; text?: string; thinking?: string }>;
      };
      assistantMessageEvent?: {
        type?: string;
        delta?: string;
        content?: string;
      };
      toolName?: string;
    };
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      return { handled: false };
    }
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta' && typeof event.assistantMessageEvent.delta === 'string') {
      return { handled: true, thinkingDelta: event.assistantMessageEvent.delta };
    }
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_end' && typeof event.assistantMessageEvent.content === 'string') {
      return { handled: true, finalThinking: event.assistantMessageEvent.content };
    }
    if (
      event.type === 'message_update'
      && event.assistantMessageEvent?.type === 'text_delta'
      && typeof event.assistantMessageEvent.delta === 'string'
    ) {
      return { handled: true, textDelta: event.assistantMessageEvent.delta };
    }
    if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
      return { handled: true, activity: describePiTool(event.toolName) };
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const finalText = event.message.content
        ?.filter((content) => content.type === 'text' && typeof content.text === 'string')
        .map((content) => content.text)
        .join('');
      const finalThinking = event.message.content
        ?.filter((content) => content.type === 'thinking' && typeof content.thinking === 'string')
        .map((content) => content.thinking)
        .join('');
      return { handled: true, finalText, ...(finalThinking ? { finalThinking } : {}) };
    }
    return { handled: true };
  } catch {
    return { handled: false };
  }
}

/**
 * Pi Runtime 的 Orvia 适配边界。
 *
 * Orvia 只依赖这个适配器，不直接依赖 Pi 的内部实现。Pi 通过命令行进程
 * 启动，stdout/stderr 转换为统一 RuntimeSessionEvent，便于后续写入 Event 表。
 */
export class PiRuntimeAdapter implements AgentRuntimeAdapter {
  readonly name = 'pi';
  private readonly processes = new Map<number, ChildProcessByStdio<null, Readable, Readable>>();
  private readonly statuses = new Map<number, RuntimeSessionResult['status']>();
  private readonly callbacks = new Map<number, RuntimeSessionInput['onEvent']>();
  private readonly results = new Map<number, RuntimeSessionResult>();
  private readonly waiters = new Map<number, Array<(result: RuntimeSessionResult) => void>>();

  async start(input: RuntimeSessionInput): Promise<RuntimeSessionResult> {
    const existing = this.processes.get(input.sessionId);
    if (existing && existing.exitCode === null) {
      return { sessionId: input.sessionId, status: 'running', runtime: this.name, pid: existing.pid };
    }
    this.results.delete(input.sessionId);

    const command = input.command ?? process.env.PI_COMMAND ?? 'pi';
    const args = ['--print', '--mode', 'json', '--no-session'];
    if (input.provider) args.push('--provider', input.provider);
    if (input.model) args.push('--model', input.model);
    if (input.systemPrompt) args.push('--system-prompt', input.systemPrompt);
    if (input.allowedTools) {
      if (input.allowedTools.length === 0) args.push('--no-tools');
      else args.push('--tools', input.allowedTools.join(','));
    }
    if (input.deniedTools && input.deniedTools.length > 0) {
      args.push('--exclude-tools', input.deniedTools.join(','));
    }
    args.push('--', input.prompt ?? 'Continue the assigned Orvia task.');

    const child = spawn(command, args, {
      cwd: input.workingDirectory,
      env: { ...process.env, ...input.environment },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.processes.set(input.sessionId, child);
    this.statuses.set(input.sessionId, 'running');
    this.callbacks.set(input.sessionId, input.onEvent);

    const emit = (event: RuntimeSessionEvent) => {
      input.onEvent?.(event);
    };
    let stdoutBuffer = '';
    let sawTextDelta = false;
    let sawThinkingDelta = false;
    let finalText = '';
    let finalThinking = '';
    const consumeStdoutLine = (line: string) => {
      if (!line) return;
      const parsed = parsePiOutputLine(line);
      if (!parsed.handled) {
        emit({ sessionId: input.sessionId, type: 'stdout', payload: `${line}\n` });
        return;
      }
      if (parsed.thinkingDelta !== undefined) {
        sawThinkingDelta = true;
        emit({ sessionId: input.sessionId, type: 'thinking', payload: parsed.thinkingDelta });
      }
      if (parsed.textDelta !== undefined) {
        sawTextDelta = true;
        emit({ sessionId: input.sessionId, type: 'stdout', payload: parsed.textDelta });
      }
      if (parsed.activity) emit({ sessionId: input.sessionId, type: 'activity', payload: parsed.activity });
      if (parsed.finalText !== undefined) finalText = parsed.finalText;
      if (parsed.finalThinking !== undefined) finalThinking = parsed.finalThinking;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) consumeStdoutLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      emit({ sessionId: input.sessionId, type: 'stderr', payload: chunk.toString('utf8') });
    });
    let spawnError: Error | undefined;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => {
      if (stdoutBuffer) consumeStdoutLine(stdoutBuffer);
      if (!sawThinkingDelta && finalThinking) {
        emit({ sessionId: input.sessionId, type: 'thinking', payload: finalThinking });
      }
      if (!sawTextDelta && finalText) {
        emit({ sessionId: input.sessionId, type: 'stdout', payload: finalText });
      }
      const status = code === 0 && !spawnError ? 'completed' : 'failed';
      const result = {
        sessionId: input.sessionId,
        status,
        runtime: this.name,
        pid: child.pid,
        message: spawnError?.message ?? (signal ? `Pi exited with signal ${signal}` : undefined),
      } satisfies RuntimeSessionResult;
      this.statuses.set(input.sessionId, status);
      this.results.set(input.sessionId, result);
      this.processes.delete(input.sessionId);
      this.callbacks.delete(input.sessionId);
      for (const resolve of this.waiters.get(input.sessionId) ?? []) resolve(result);
      this.waiters.delete(input.sessionId);
      emit({
        sessionId: input.sessionId,
        type: status,
        payload: { code, signal },
      });
    });

    emit({ sessionId: input.sessionId, type: 'started', payload: { pid: child.pid, command, args } });
    return {
      sessionId: input.sessionId,
      status: 'running',
      runtime: this.name,
      pid: child.pid,
      message: `Pi process started with pid ${child.pid}`,
    };
  }

  async wait(sessionId: number): Promise<RuntimeSessionResult> {
    const result = this.results.get(sessionId);
    if (result) return result;
    const process = this.processes.get(sessionId);
    if (!process && this.statuses.has(sessionId)) {
      return { sessionId, status: this.statuses.get(sessionId)!, runtime: this.name };
    }
    if (!process) {
      return { sessionId, status: 'failed', runtime: this.name, message: 'Runtime session has not been started' };
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(sessionId) ?? [];
      waiters.push(resolve);
      this.waiters.set(sessionId, waiters);
    });
  }

  async pause(sessionId: number): Promise<RuntimeSessionResult> {
    const child = this.processes.get(sessionId);
    if (!child || child.exitCode !== null) {
      return { sessionId, status: this.statuses.get(sessionId) ?? 'failed', runtime: this.name, message: 'Pi process is not running' };
    }
    if (process.platform === 'win32') {
      return { sessionId, status: 'running', runtime: this.name, pid: child.pid, message: 'Pausing Pi processes is not supported on Windows yet' };
    }
    child.kill('SIGSTOP');
    this.statuses.set(sessionId, 'paused');
    this.callbacks.get(sessionId)?.({ sessionId, type: 'paused', payload: { pid: child.pid } });
    return { sessionId, status: 'paused', runtime: this.name, pid: child.pid };
  }

  async resume(sessionId: number): Promise<RuntimeSessionResult> {
    const child = this.processes.get(sessionId);
    if (!child || child.exitCode !== null) {
      return { sessionId, status: this.statuses.get(sessionId) ?? 'failed', runtime: this.name, message: 'Pi process is not running' };
    }
    if (process.platform === 'win32') {
      return { sessionId, status: 'running', runtime: this.name, pid: child.pid, message: 'Pi process is already running on Windows' };
    }
    child.kill('SIGCONT');
    this.statuses.set(sessionId, 'running');
    this.callbacks.get(sessionId)?.({ sessionId, type: 'resumed', payload: { pid: child.pid } });
    return { sessionId, status: 'running', runtime: this.name, pid: child.pid };
  }

  async stop(sessionId: number): Promise<RuntimeSessionResult> {
    const child = this.processes.get(sessionId);
    if (!child || child.exitCode !== null) {
      return { sessionId, status: this.statuses.get(sessionId) ?? 'failed', runtime: this.name, message: 'Pi process is not running' };
    }
    child.kill('SIGTERM');
    return { sessionId, status: 'failed', runtime: this.name, pid: child.pid, message: 'Pi process stop requested' };
  }

  async shutdown(): Promise<void> {
    const active = [...this.processes.keys()];
    await Promise.all(active.map((sessionId) => this.stop(sessionId)));
    await Promise.all(active.map((sessionId) => this.wait(sessionId)));
  }
}

export const piRuntime = new PiRuntimeAdapter();
