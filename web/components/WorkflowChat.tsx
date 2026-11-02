'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_ORVIA_API_URL ?? 'http://127.0.0.1:4100';

type Id = number;
type ChatMessage = {
  id: Id;
  workflowId: Id;
  workflowRunId: Id | null;
  nodeKey: string | null;
  type: 'started' | 'progress' | 'completed' | 'failed' | 'review' | 'decision' | 'redo' | 'guidance' | 'system';
  content: string;
  mentionsJson: string[] | null;
  attachmentsJson: Array<{ name: string; path: string }> | null;
  createdAt: string;
};

type NodeInfo = { key: string; name: string; type: 'task' | 'checkpoint' | 'start' | 'end' };

const TYPE_ICON: Record<ChatMessage['type'], string> = {
  started: '▶',
  progress: '…',
  completed: '✓',
  failed: '✗',
  review: '⏳',
  decision: '✅',
  redo: '↩',
  guidance: '💬',
  system: '●',
};

const TYPE_LABEL: Record<ChatMessage['type'], string> = {
  started: '开始',
  progress: '进展',
  completed: '完成',
  failed: '失败',
  review: '等待复核',
  decision: '决策',
  redo: '退回重做',
  guidance: '人工指导',
  system: '系统',
};

function nodeColor(type: NodeInfo['type'] | undefined): string {
  if (type === 'start') return '#71e3bd';
  if (type === 'end') return '#82909f';
  if (type === 'checkpoint') return '#e8b568';
  return '#8dbbf7';
}

function nodeInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function ChatInput({ workflowId, nodes, onSent, onLive }: {
  workflowId: Id;
  nodes: NodeInfo[];
  onSent: () => void;
  onLive: (live: { node: NodeInfo; content: string } | null) => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [selectedMention, setSelectedMention] = useState(0);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingNode, setStreamingNode] = useState<NodeInfo | null>(null);
  const streamingBufferRef = useRef('');
  const streamingIndexRef = useRef(0);
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatableNodes = nodes.filter((n) => n.type !== 'start' && n.type !== 'end');

  useEffect(() => {
    onLive(isStreaming && streamingNode ? { node: streamingNode, content: streamingContent } : null);
  }, [isStreaming, streamingNode, streamingContent, onLive]);

  useEffect(() => {
    return () => {
      if (streamingTimerRef.current) {
        clearTimeout(streamingTimerRef.current);
        streamingTimerRef.current = null;
      }
    };
  }, []);
  const ALL_MENTION = { key: '__all__', name: 'all', type: 'task' as const };

  function detectMention(value: string, cursorPos: number) {
    let atPos = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      if (value[i] === '@') { atPos = i; break; }
      if (value[i] === ' ' || value[i] === '\n') break;
    }
    if (atPos >= 0) {
      setMentionStart(atPos);
      setMentionFilter(value.slice(atPos + 1, cursorPos));
      setShowMentions(true);
      setSelectedMention(0);
    } else {
      setShowMentions(false);
      setMentionStart(-1);
    }
  }

  const allMatchesFilter = 'all'.includes(mentionFilter.toLowerCase());
  const filteredNodes = chatableNodes.filter((n) =>
    n.name.toLowerCase().includes(mentionFilter.toLowerCase()),
  );
  const mentionOptions: NodeInfo[] = [
    ...(allMatchesFilter ? [ALL_MENTION] : []),
    ...filteredNodes,
  ];

  function insertMention(node: NodeInfo) {
    const before = text.slice(0, mentionStart);
    const after = text.slice(mentionStart + 1 + mentionFilter.length);
    const newText = `${before}@${node.name} ${after}`;
    setText(newText);
    setShowMentions(false);
    setMentionStart(-1);
    inputRef.current?.focus();
  }

  function extractMentions(content: string): { mentionKeys: string[] } {
    const mentionKeys: string[] = [];
    const seen = new Set<string>();
    for (const match of content.matchAll(/@([^\s@]+)/g)) {
      const token = match[1] ?? '';
      if (/^all$/i.test(token)) {
        if (!seen.has('__all__')) {
          mentionKeys.push('__all__');
          seen.add('__all__');
        }
        continue;
      }
      const node = chatableNodes.find((item) => item.name === token || item.key === token);
      if (!node || seen.has(node.key)) continue;
      mentionKeys.push(node.key);
      seen.add(node.key);
    }
    return { mentionKeys };
  }

  function buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = typeof window !== 'undefined' ? window.sessionStorage.getItem('orvia.token') ?? '' : '';
    const tenant = typeof window !== 'undefined' ? window.sessionStorage.getItem('orvia.tenant') ?? '' : '';
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (tenant) headers['x-orvia-tenant-id'] = tenant;
    return headers;
  }

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function startTypewriter() {
    if (streamingTimerRef.current) return;
    const TYPING_SPEED = 45;
    function tick() {
      const buffer = streamingBufferRef.current;
      if (streamingIndexRef.current < buffer.length) {
        streamingIndexRef.current += 1;
        setStreamingContent(buffer.slice(0, streamingIndexRef.current));
        streamingTimerRef.current = setTimeout(tick, TYPING_SPEED);
      } else {
        streamingTimerRef.current = null;
      }
    }
    tick();
  }

  async function doSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (isStreaming) {
      if (streamingTimerRef.current) {
        clearTimeout(streamingTimerRef.current);
        streamingTimerRef.current = null;
      }
      setIsStreaming(false);
      setStreamingContent('');
      setStreamingNode(null);
    }
    const { mentionKeys } = extractMentions(trimmed);
    const startTime = Date.now();
    console.log('[Chat] 📤 发送消息:', { content: trimmed, mentionKeys, time: new Date().toLocaleTimeString() });
    setSending(true);
    try {
      let res: Response;
      try {
        res = await fetch(`${API_URL}/api/workflows/${workflowId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
          body: JSON.stringify({ content: trimmed, mentions: mentionKeys }),
        });
        console.log('[Chat] ⏱️ 响应时间:', Date.now() - startTime, 'ms, status:', res.status);
      } catch (fetchError) {
        console.error('[Chat] Fetch failed:', fetchError);
        setSending(false);
        return;
      }
      if (!mentionKeys.length) {
        if (res.ok) {
          setText('');
          setShowMentions(false);
          onSent();
        }
        setSending(false);
        return;
      }
      setText('');
      setShowMentions(false);
      onSent();
      setStreamingContent('');
      streamingBufferRef.current = '';
      setStreamingNode(null);
      setIsStreaming(true);
      console.log('[Chat] 🔄 开始SSE流, 总耗时:', Date.now() - startTime, 'ms');
      if (res.body && res.headers.get('content-type')?.includes('text/event-stream')) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let pendingEvent = '';
        let pendingData = '';
        let chunkCount = 0;
        let speaker = { key: '__conductor__', name: '管理员' };
        const clearLiveReply = () => {
          setStreamingContent('');
          setStreamingNode(null);
          streamingBufferRef.current = '';
          streamingIndexRef.current = 0;
          if (streamingTimerRef.current) {
            clearTimeout(streamingTimerRef.current);
            streamingTimerRef.current = null;
          }
          onSent();
        };
        const applyEvent = (eventName: string, raw: string) => {
          const parsed = raw ? JSON.parse(raw) as { nodeKey?: string; name?: string; content?: string; error?: string } : {};
          if (eventName === 'stream_start') {
            speaker = {
              key: typeof parsed.nodeKey === 'string' ? parsed.nodeKey : '__conductor__',
              name: typeof parsed.name === 'string' ? parsed.name : '管理员',
            };
            const known = chatableNodes.find((node) => node.key === speaker.key);
            setStreamingNode(known ?? { key: speaker.key, name: speaker.name, type: 'task' });
            setStreamingContent('');
            streamingBufferRef.current = '';
            streamingIndexRef.current = 0;
          } else if (eventName === 'stream_chunk' && parsed.content) {
            chunkCount++;
            streamingBufferRef.current = parsed.content;
            if (!streamingTimerRef.current) startTypewriter();
          } else if (eventName === 'stream_done' || eventName === 'stream_error') {
            clearLiveReply();
          } else if (eventName === 'done') {
            setIsStreaming(false);
            setStreamingContent('');
            setStreamingNode(null);
            if (streamingTimerRef.current) {
              clearTimeout(streamingTimerRef.current);
              streamingTimerRef.current = null;
            }
            onSent();
          }
        };
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith(':')) continue;
              if (line.startsWith('event:')) pendingEvent = line.slice(6).trim();
              else if (line.startsWith('data:')) pendingData = line.slice(5).trim();
              else if (line === '' && pendingEvent) {
                const eventName = pendingEvent;
                const raw = pendingData;
                pendingEvent = '';
                pendingData = '';
                try {
                  applyEvent(eventName, raw);
                } catch (parseError) {
                  console.error('[Chat] 解析错误:', parseError, 'data:', raw);
                }
              }
            }
          }
          console.log('[Chat] 📚 流结束, 总chunk数:', chunkCount, ', 总耗时:', Date.now() - startTime, 'ms');
          setTimeout(() => {
            setIsStreaming(false);
            setStreamingContent('');
            setStreamingNode(null);
            if (streamingTimerRef.current) {
              clearTimeout(streamingTimerRef.current);
              streamingTimerRef.current = null;
            }
            onSent();
          }, 300);
        } catch (streamError) {
          console.error('[Chat] Stream read error:', streamError);
          setIsStreaming(false);
          setStreamingContent('');
          setStreamingNode(null);
          if (streamingTimerRef.current) {
            clearTimeout(streamingTimerRef.current);
            streamingTimerRef.current = null;
          }
          onSent();
        } finally {
          reader.releaseLock();
        }
      } else {
        console.warn('[Chat] No stream response, status:', res.status);
        onSent();
      }
    } finally {
      setSending(false);
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    const cursor = e.target.selectionStart ?? value.length;
    setText(value);
    detectMention(value, cursor);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (showMentions && mentionOptions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedMention((i) => Math.min(i + 1, mentionOptions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedMention((i) => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionOptions[selectedMention]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); setShowMentions(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend();
    }
  }

  return <div className="chat-input-area">
    {showMentions && mentionOptions.length > 0 ? <div className="chat-mention-popup">
      {mentionOptions.map((node, i) => (
        <button type="button" key={node.key} className={`chat-mention-option${i === selectedMention ? ' selected' : ''}`}
          onClick={() => insertMention(node)}
          onMouseEnter={() => setSelectedMention(i)}>
          <span className="chat-avatar" style={{ background: node.key === '__all__' ? '#6366f1' : nodeColor(node.type) }}>{node.key === '__all__' ? '📢' : nodeInitial(node.name)}</span>
          <strong>{node.name}</strong>
          <small>{node.key === '__all__' ? '全部节点' : node.type === 'task' ? 'Agent' : '复核'}</small>
        </button>
      ))}
    </div> : null}
    <div className="chat-input-form">
      <input ref={inputRef} type="text" className="chat-input" placeholder="输入消息，@ 提及节点…"
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setShowMentions(false), 200)} />
      <button type="button" className="chat-send-btn" disabled={!text.trim()} onClick={() => void doSend()}>发送</button>
    </div>
  </div>;
}

export function WorkflowChat({
  messages, nodes, workflowId, onOpenChat, onOpenDeliverable, onRefresh, onRunFromStart, running,
}: {
  messages: ChatMessage[];
  nodes: NodeInfo[];
  workflowId: Id;
  onOpenChat?: (nodeKey: string) => void;
  onOpenDeliverable?: (directory: string) => Promise<void>;
  onRefresh?: () => void;
  /** 从第一个节点开始执行；返回 null 表示成功，返回文案表示失败原因 */
  onRunFromStart?: () => Promise<string | null>;
  running?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickBottom, setStickBottom] = useState(true);
  const [dialogW, setDialogW] = useState(800);
  const [dialogH, setDialogH] = useState(640);
  const [showMembers, setShowMembers] = useState(false);
  const [live, setLive] = useState<{ node: NodeInfo; content: string } | null>(null);
  const [runPrompt, setRunPrompt] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState('');
  const [clearPrompt, setClearPrompt] = useState(false);
  const [clearing, setClearing] = useState(false);
  const onLive = useCallback((next: { node: NodeInfo; content: string } | null) => setLive(next), []);
  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);

  async function startFromFirstNode() {
    if (!onRunFromStart || starting) return;
    setStarting(true);
    setRunError('');
    try {
      const error = await onRunFromStart();
      if (error) {
        setRunError(error);
        return;
      }
      setRunPrompt(false);
      onRefresh?.();
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : '开始执行失败');
    } finally {
      setStarting(false);
    }
  }

  async function clearMessages() {
    if (clearing) return;
    setClearing(true);
    try {
      const token = typeof window !== 'undefined' ? window.sessionStorage.getItem('orvia.token') ?? '' : '';
      const tenant = typeof window !== 'undefined' ? window.sessionStorage.getItem('orvia.tenant') ?? '' : '';
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      if (tenant) headers['x-orvia-tenant-id'] = tenant;
      const res = await fetch(`${API_URL}/api/workflows/${workflowId}/messages`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok) throw new Error(`清空失败 (${res.status})`);
      setClearPrompt(false);
      onRefresh?.();
    } catch (cause) {
      console.error('[Chat] 清空会话失败:', cause);
    } finally {
      setClearing(false);
    }
  }

  useEffect(() => {
    if (stickBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, live, stickBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setStickBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  }

  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: dialogW, startH: dialogH };
  }, [dialogW, dialogH]);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const dx = e.clientX - resizeRef.current.startX;
    const dy = e.clientY - resizeRef.current.startY;
    setDialogW(Math.min(1200, Math.max(360, resizeRef.current.startW + dx)));
    setDialogH(Math.min(900, Math.max(300, resizeRef.current.startH + dy)));
  }, []);

  const onResizeUp = useCallback(() => {
    resizeRef.current = null;
  }, []);

  const nodeMap = new Map(nodes.map((n) => [n.key, n]));
  const memberCount = nodes.filter((n) => n.type !== 'start' && n.type !== 'end').length;

  const messageList = <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
    {messages.map((msg, index) => {
      const prevRunId = index > 0 ? messages[index - 1]!.workflowRunId : null;
      const showRunDivider = msg.workflowRunId !== null && msg.workflowRunId !== prevRunId && prevRunId !== null;
      const node = msg.nodeKey === '__conductor__'
        ? { key: '__conductor__', name: '管理员', type: 'task' as const }
        : msg.nodeKey ? nodeMap.get(msg.nodeKey) : undefined;
      const mentions = Array.isArray(msg.mentionsJson) ? msg.mentionsJson : [];
      const attachments = Array.isArray(msg.attachmentsJson) ? msg.attachmentsJson : [];
      const isUser = msg.type === 'guidance' && !msg.nodeKey;
      const isNodeReply = msg.type === 'guidance' && !!msg.nodeKey;
      const isSystem = msg.type === 'system';

      return <div key={msg.id}>
        {showRunDivider ? <div className="chat-run-divider"><span>第 {msg.workflowRunId} 次执行</span></div> : null}
        {isSystem ? <div className={`chat-bubble ${msg.type} system`}>
          <div className="chat-bubble-body"><p>{msg.content}</p></div>
        </div> : isUser ? <div className={`chat-bubble ${msg.type} user`}>
          <div className="chat-bubble-head">
            <span className="chat-avatar" style={{ background: 'linear-gradient(135deg,#7c3aed,#6366f1)', fontSize: 12 }}>我</span>
            <strong className="chat-sender">我</strong>
            <time>{formatTime(msg.createdAt)}</time>
          </div>
          <div className="chat-bubble-body">
            <p>{msg.content}</p>
            {attachments.length > 0 ? <div className="chat-attachments">
              {attachments.map((file) => <button type="button" className="chat-attachment" key={file.path} onClick={() => onOpenDeliverable?.(file.path)}>📎 {file.name}</button>)}
            </div> : null}
          </div>
        </div> : <div className={`chat-bubble ${msg.type} ${isNodeReply ? 'node-reply' : ''}`}>
          <div className="chat-bubble-head">
            <span className="chat-avatar" style={{ background: nodeColor(node?.type) }}>{node ? nodeInitial(node.name) : TYPE_ICON[msg.type]}</span>
            <strong className="chat-sender" onClick={msg.nodeKey && onOpenChat ? () => onOpenChat(msg.nodeKey!) : undefined}>{node?.name ?? '系统'}</strong>
            <time style={{ marginLeft: 'auto' }}>{formatTime(msg.createdAt)}</time>
          </div>
          <div className="chat-bubble-body">
            <p>{msg.content}</p>
            {attachments.length > 0 ? <div className="chat-attachments">
              {attachments.map((file) => <button type="button" className="chat-attachment" key={file.path} onClick={() => onOpenDeliverable?.(file.path)}>📎 {file.name}</button>)}
            </div> : null}
          </div>
        </div>}
      </div>;
    })}
    {live ? <div className="chat-bubble guidance node-reply streaming">
      <div className="chat-bubble-head">
        <span className="chat-avatar" style={{ background: nodeColor(live.node.type), fontSize: 12 }}>{nodeInitial(live.node.name)}</span>
        <strong className="chat-sender">{live.node.name}</strong>
        <small className="chat-time">{live.content ? '正在输入...' : '正在思考'}</small>
      </div>
      <div className="chat-bubble-body">
        {live.content ? (
          <p>{live.content}<span className="streaming-cursor">|</span></p>
        ) : (
          <p className="thinking-dots"><span></span><span></span><span></span></p>
        )}
      </div>
    </div> : null}
  </div>;

  const emptyView = <div className="chat-empty">
    <p className="muted">执行后这里会显示过程</p>
    <div className="chat-member-list">
      <h4>群成员</h4>
      {nodes.map((node) => (
        <div className="chat-member" key={node.key}>
          <span className="chat-avatar" style={{ background: nodeColor(node.type) }}>{nodeInitial(node.name)}</span>
          <strong>{node.name}</strong>
          <small>{node.type === 'task' ? 'Agent' : node.type === 'checkpoint' ? '人工复核' : node.type === 'start' ? '开始' : '结束'}</small>
        </div>
      ))}
    </div>
  </div>;

  return <div className="chat-dialog" style={{ width: dialogW, height: dialogH }}>
    <div className="chat-dialog-header">
      <span className="chat-avatar" style={{ background: '#6366f1', width: 22, height: 22, fontSize: 11 }}>💬</span>
      <h3>群聊</h3>
      <button type="button" className="chat-member-count" onClick={() => setShowMembers((v) => !v)}>{memberCount} 位成员</button>
      {onRunFromStart ? <button type="button" className="chat-run-btn"
        onClick={() => { setRunError(''); setRunPrompt(true); }}
        disabled={running || starting}
        title={running ? '当前 Run 正在运行，请先停止' : '从第一个节点开始执行'}>▶ 开始执行</button> : null}
      {messages.length > 0 ? <button type="button" className="chat-clear-btn"
        onClick={() => setClearPrompt(true)}
        disabled={clearing}
        title="清空当前会话的所有消息">清空</button> : null}
    </div>
    {messages.length === 0 && !live ? emptyView : messageList}
    {showMembers && messages.length > 0 ? <div className="chat-member-panel">
      <div className="chat-member-panel-head">
        <strong>群成员 ({memberCount})</strong>
        <button type="button" onClick={() => setShowMembers(false)}>✕</button>
      </div>
      <div className="chat-member-panel-list">
        {nodes.map((node) => (
          <div className="chat-member" key={node.key}>
            <span className="chat-avatar" style={{ background: nodeColor(node.type), width: 32, height: 32, fontSize: 13 }}>{nodeInitial(node.name)}</span>
            <strong>{node.name}</strong>
            <small>{node.type === 'task' ? 'Agent' : node.type === 'checkpoint' ? '人工复核' : node.type === 'start' ? '开始' : '结束'}</small>
          </div>
        ))}
      </div>
    </div> : null}
    <ChatInput workflowId={workflowId} nodes={nodes} onSent={() => onRefresh?.()} onLive={onLive} />
    {runPrompt ? <div className="chat-confirm-backdrop" onMouseDown={() => { if (!starting) { setRunPrompt(false); setRunError(''); } }}>
      <div className="chat-confirm" role="dialog" aria-modal="true" aria-label="确认开始执行" onMouseDown={(event) => event.stopPropagation()}>
        <h4>确认开始执行</h4>
        <p>将从第一个节点开始执行。这个 Workflow 已经执行过的节点会重新跑一遍。</p>
        {runError ? <p className="alert">{runError}</p> : null}
        <div className="chat-confirm-actions">
          <button type="button" onClick={() => { setRunPrompt(false); setRunError(''); }} disabled={starting}>取消</button>
          <button type="button" className="chat-confirm-primary" onClick={() => void startFromFirstNode()} disabled={starting}>{starting ? '提交中…' : '确认开始'}</button>
        </div>
      </div>
    </div> : null}
    {clearPrompt ? <div className="chat-confirm-backdrop" onMouseDown={() => { if (!clearing) setClearPrompt(false); }}>
      <div className="chat-confirm" role="dialog" aria-modal="true" aria-label="确认清空会话" onMouseDown={(event) => event.stopPropagation()}>
        <h4>确认清空会话</h4>
        <p>将删除当前 Workflow 的全部群聊消息（包括执行进度记录）。此操作不可恢复。</p>
        <div className="chat-confirm-actions">
          <button type="button" onClick={() => setClearPrompt(false)} disabled={clearing}>取消</button>
          <button type="button" className="chat-confirm-primary" onClick={() => void clearMessages()} disabled={clearing}>{clearing ? '清空中…' : '确认清空'}</button>
        </div>
      </div>
    </div> : null}
    <div className="chat-dialog-resize"
      onPointerDown={onResizeDown}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeUp} />
  </div>;
}