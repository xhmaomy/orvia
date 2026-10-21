'use client';

import { CSSProperties, FormEvent, memo, PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { beijingClock } from '../lib/beijing-time';
import { useAutoDismiss } from '../lib/use-auto-dismiss';

type Id = number;
export type BoardNode = { key: string; name: string; type: 'task' | 'checkpoint' | 'start' | 'end'; capabilities: string[]; skills: string[]; modelId: number | null; question: string; instruction: string; outputRequirement: string; acceptanceRule: string; maxRedos: number; requirement: string; x: number; y: number; w: number; h: number };
export type BoardProvider = { id: Id; name: string; type: string };
export type BoardModel = { id: Id; providerId: Id; name: string; displayName: string };
export type BoardLoop = { key: string; nodeKeys: string[]; maxIterations: number };
export type BoardEdge = { source: string; target: string };
export type NodeCheckEntry = { verdict: 'pass' | 'reject' | 'unclear'; label: string; detail: string; at?: string };
export type NodeCheck = NodeCheckEntry & { history?: NodeCheckEntry[] };
export type SummaryFile = { name: string; path: string };
export type SummaryNode = { key: string; name: string; status: string; error?: string; files: SummaryFile[] };
type CapabilityRow = { id: Id; key: string; name: string; description?: string | null };
type SkillRow = { id: Id; key: string; name: string; description?: string | null; kind?: string };
type EventRow = { id: Id; type: string; payloadJson?: unknown; payload?: unknown; createdAt?: string; occurredAt?: string; workflowRunId?: Id };
type StoredNode = { id: Id; name: string; capability?: string | null; capabilitiesJson?: unknown; nodeType?: string; configJson?: unknown };
type StoredEdge = { sourceNodeId: Id; targetNodeId: Id };

const NODE_W = 196;
const NODE_H = 74;
const NODE_MIN_W = 168;
const NODE_MIN_H = 74;
const NODE_MAX_W = 640;
const NODE_MAX_H = 420;

function clampSize(value: unknown, fallback: number, min: number, max: number) {
  const next = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(max, Math.max(min, next)));
}
function nodeBox(node: { w?: number; h?: number }) {
  return { w: clampSize(node.w, NODE_W, NODE_MIN_W, NODE_MAX_W), h: clampSize(node.h, NODE_H, NODE_MIN_H, NODE_MAX_H) };
}

function roleTitle(type: BoardNode['type']) {
  if (type === 'start') return '开始';
  if (type === 'end') return '结束';
  if (type === 'checkpoint') return '人工复核';
  return 'Agent 节点';
}

export function graphFromStored(nodes: StoredNode[], edges: StoredEdge[]): { nodes: BoardNode[]; edges: BoardEdge[] } {
  const boardNodes = nodes.map((node, index) => {
    const config = node.configJson && typeof node.configJson === 'object' ? node.configJson as Record<string, unknown> : {};
    const fromList = Array.isArray(node.capabilitiesJson) ? node.capabilitiesJson.filter((item): item is string => typeof item === 'string') : [];
    const capabilities = fromList.length ? fromList : (node.capability ? [node.capability] : []);
    const skills = Array.isArray(config.skills) ? config.skills.filter((item): item is string => typeof item === 'string') : [];
    const modelIdRaw = typeof config.modelId === 'number' ? config.modelId : typeof config.modelId === 'string' ? Number(config.modelId) : NaN;
    const modelId = Number.isInteger(modelIdRaw) && modelIdRaw > 0 ? modelIdRaw : null;
    return {
      key: typeof config.key === 'string' ? config.key : `node-${node.id}`,
      name: node.name,
      type: (node.nodeType === 'checkpoint' || node.nodeType === 'start' || node.nodeType === 'end' ? node.nodeType : 'task') as BoardNode['type'],
      capabilities,
      skills,
      modelId: (node.nodeType === 'checkpoint' || node.nodeType === 'start' || node.nodeType === 'end') ? null : modelId,
      question: typeof config.question === 'string' && !/^Approve checkpoint:/i.test(config.question.trim()) ? config.question : '',
      instruction: typeof config.instruction === 'string' ? config.instruction : '',
      outputRequirement: typeof config.outputRequirement === 'string' ? config.outputRequirement : '',
      acceptanceRule: typeof config.acceptanceRule === 'string' ? config.acceptanceRule : '',
      maxRedos: Number.isInteger(Number(config.maxRedos)) && Number(config.maxRedos) >= 1 ? Number(config.maxRedos) : 3,
      requirement: typeof config.requirement === 'string' ? config.requirement : '',
      x: typeof config.x === 'number' ? config.x : 48 + (index % 3) * 250,
      y: typeof config.y === 'number' ? config.y : 40 + Math.floor(index / 3) * 150,
      w: clampSize(config.w, NODE_W, NODE_MIN_W, NODE_MAX_W),
      h: clampSize(config.h, NODE_H, NODE_MIN_H, NODE_MAX_H),
    };
  });
  const keyOf = new Map(nodes.map((node, index) => [node.id, boardNodes[index]?.key]));
  const boardEdges = edges.flatMap((edge) => {
    const source = keyOf.get(edge.sourceNodeId);
    const target = keyOf.get(edge.targetNodeId);
    return source && target ? [{ source, target }] : [];
  });
  return { nodes: boardNodes, edges: boardEdges };
}

function CatalogPicker({ label, hint, emptyLabel, options, selected, onChange }: { label: string; hint: string; emptyLabel: string; options: { key: string; name: string }[]; selected: string[]; onChange: (next: string[]) => void }) {
  const chosen = selected.map((key) => options.find((item) => item.key.toLowerCase() === key.toLowerCase()) ?? { key, name: key });
  const remaining = options.filter((item) => !selected.some((key) => key.toLowerCase() === item.key));
  return <div className="capability-picker">
    <label>{label}<select value="" onChange={(event) => { const key = event.target.value; if (key) onChange([...selected, key]); }}>
      <option value="">{options.length ? (remaining.length ? emptyLabel : '目录项都已选上') : '目录还是空的'}</option>
      {remaining.map((item) => <option value={item.key} key={item.key}>{item.name} · {item.key}</option>)}
    </select><small className="field-hint">{hint}</small></label>
    {chosen.length ? <div className="picked-list">{chosen.map((item) => <div className="picked-item" key={item.key}><span>{item.name}</span><small>{item.key}</small><button type="button" onClick={() => onChange(selected.filter((key) => key.toLowerCase() !== item.key.toLowerCase()))}>移除</button></div>)}</div> : null}
  </div>;
}
function CapabilityPicker({ label, hint, options, selected, onChange }: { label: string; hint: string; options: CapabilityRow[]; selected: string[]; onChange: (next: string[]) => void }) {
  return <CatalogPicker label={label} hint={hint} emptyLabel="请选择能力" options={options} selected={selected} onChange={onChange} />;
}
function SkillPicker({ label, hint, options, selected, onChange }: { label: string; hint: string; options: SkillRow[]; selected: string[]; onChange: (next: string[]) => void }) {
  return <CatalogPicker label={label} hint={hint} emptyLabel="请选择 Skill" options={options} selected={selected} onChange={onChange} />;
}

const NODE_STATUS: Record<string, string> = {
  pending: '待处理', blocked: '等待上游', running: '进行中', paused: '已暂停',
  awaiting_decision: '等待确认', completed: '已完成', failed: '失败', cancelled: '已停止',
};

type BoardDecision = {
  id: number;
  question: string;
  decision?: string | null;
  action?: string | null;
  status?: string;
  contextJson?: unknown;
  createdAt?: string;
  resolvedAt?: string | null;
};

function decisionContext(item: BoardDecision): Record<string, unknown> {
  return item.contextJson && typeof item.contextJson === 'object' ? item.contextJson as Record<string, unknown> : {};
}

function decisionNodeKey(item: BoardDecision): string | null {
  const context = decisionContext(item);
  if (typeof context.checkerKey === 'string' && context.checkerKey) return context.checkerKey;
  if (typeof context.key === 'string' && context.key) return context.key;
  return null;
}

function decisionKind(item: BoardDecision) {
  const context = decisionContext(item);
  if (context.kind === 'acceptance') return 'acceptance' as const;
  if ('loopKey' in context) return 'loop' as const;
  return 'checkpoint' as const;
}

function reviewQuestionText(question: string | undefined) {
  const text = question?.trim() ?? '';
  if (!text) return '';
  // 隐藏旧版默认文案，例如 Approve checkpoint: 人工审核?
  if (/^Approve checkpoint:/i.test(text)) return '';
  return text;
}

function reviewActionLabel(action?: string | null, status?: string) {
  const value = action || status || '';
  if (value === 'approve' || value === 'approved' || value === 'override' || value === 'overridden') return '批准';
  if (value === 'return' || value === 'request_changes' || value === 'changes_requested' || value === 'repeat' || value === 'replan') return '退回';
  if (value === 'reject' || value === 'rejected') return '拒绝';
  if (value === 'pending') return '待确认';
  return value || '已处理';
}

function reviewTimeText(item: BoardDecision) {
  const raw = item.resolvedAt || item.createdAt;
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 人工复核节点：按连线找所有上游（开始/结束除外），用于分别复核 */
function checkpointUpstreams(
  nodeKey: string,
  nodes: BoardNode[],
  edges: BoardEdge[],
  deliverables: Record<string, string>,
): Array<{ key: string; name: string; folder: string; type: BoardNode['type'] }> {
  return edges
    .filter((edge) => edge.target === nodeKey)
    .flatMap((edge) => {
      const source = nodes.find((item) => item.key === edge.source);
      if (!source || source.type === 'start' || source.type === 'end') return [];
      return [{
        key: source.key,
        name: source.name?.trim() || source.key,
        folder: deliverables[source.key] || '',
        type: source.type,
      }];
    });
}

function upstreamDeliverables(
  nodeKey: string,
  nodes: BoardNode[],
  edges: BoardEdge[],
  deliverables: Record<string, string>,
): Array<{ key: string; name: string; folder: string }> {
  return checkpointUpstreams(nodeKey, nodes, edges, deliverables)
    .filter((item) => item.folder)
    .map(({ key, name, folder }) => ({ key, name, folder }));
}

type ReviewPayload = { key: string; name: string; note: string; action?: 'approve' | 'return' | 'reject' };
type NodeReviewEntry = { action: string; note: string; name: string; at?: string };

function decisionReviews(item: BoardDecision): ReviewPayload[] {
  const raw = decisionContext(item).reviews;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const key = typeof record.key === 'string' ? record.key : '';
    const name = typeof record.name === 'string' ? record.name : key;
    const note = typeof record.note === 'string' ? record.note
      : typeof record.reason === 'string' ? record.reason : '';
    if (!key && !note) return [];
    const action = record.action === 'approve' || record.action === 'return' || record.action === 'reject'
      ? record.action
      : undefined;
    return [{ key, name, note, action }];
  });
}

/** 合并任务上的按节点历史 + 决策里的 reviews，得到每个上游自己的时间线 */
function mergeUpstreamHistories(
  stored: Record<string, NodeReviewEntry[]> | undefined,
  decisions: BoardDecision[] | undefined,
  checkpointKey: string,
): Record<string, NodeReviewEntry[]> {
  const merged: Record<string, NodeReviewEntry[]> = {};
  for (const [key, entries] of Object.entries(stored ?? {})) {
    merged[key] = [...entries];
  }
  for (const item of decisions ?? []) {
    if (decisionNodeKey(item) !== checkpointKey) continue;
    if (!item.status || item.status === 'pending' || item.status === 'superseded') continue;
    if (decisionKind(item) === 'acceptance') continue;
    const reviews = decisionReviews(item);
    const at = item.resolvedAt || item.createdAt;
    if (reviews.length) {
      for (const review of reviews) {
        const list = merged[review.key] ?? [];
        const exists = list.some((entry) => entry.note === review.note && entry.action === (review.action || item.action || '') && entry.at === at);
        if (!exists) {
          list.push({
            action: review.action || item.action || item.status || '',
            note: review.note,
            name: review.name,
            at: at || undefined,
          });
          merged[review.key] = list;
        }
      }
    } else if ((item.decision ?? '').trim()) {
      // 旧数据没有按节点拆分时，挂到 _all
      const list = merged._all ?? [];
      list.push({
        action: item.action || item.status || '',
        note: String(item.decision),
        name: '复核',
        at: at || undefined,
      });
      merged._all = list;
    }
  }
  for (const list of Object.values(merged)) {
    list.sort((a, b) => (Date.parse(b.at || '') || 0) - (Date.parse(a.at || '') || 0));
  }
  return merged;
}

const rememberedLogLines = new Map<number, string>();
const LOG_LIMIT = 400;

function eventTypeLabel(type: string) {
  if (type === 'task.failed') return '任务失败';
  if (type === 'task.retry_scheduled') return '任务重试';
  if (type === 'task.completed') return '任务完成';
  if (type === 'workflow.completed') return '流程完成';
  if (type === 'workflow.stopped') return '流程停止';
  return type;
}

function logLine(event: EventRow) {
  const payload = event.payload ?? event.payloadJson;
  let detail = '';
  if (typeof payload === 'string') detail = payload.replace(/\s+/g, ' ').trim();
  else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === 'string') {
      const name = typeof record.name === 'string' && record.name.trim() ? `「${record.name.trim()}」` : '';
      detail = `${name}${record.error}`.trim();
    } else if (typeof record.message === 'string') detail = record.message;
    else detail = JSON.stringify(payload);
  }
  const when = event.occurredAt ?? event.createdAt;
  const time = beijingClock(when);
  return `${time}  ${eventTypeLabel(event.type)}${detail ? `  ${detail.slice(0, 240)}` : ''}`;
}

function rememberedLogLine(event: EventRow) {
  const cached = rememberedLogLines.get(event.id);
  if (cached) return cached;
  const line = logLine(event);
  rememberedLogLines.set(event.id, line);
  if (rememberedLogLines.size > 8000) {
    const oldest = rememberedLogLines.keys().next().value;
    if (oldest !== undefined) rememberedLogLines.delete(oldest);
  }
  return line;
}

const LogText = memo(function LogText({ events }: { events: EventRow[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const stickBottom = useRef(true);
  const text = useMemo(() => {
    if (!events.length) return '';
    const start = Math.max(0, events.length - LOG_LIMIT);
    const body = events.slice(start).map(rememberedLogLine).join('\n');
    return start > 0 ? `较早的 ${start} 条已收起\n${body}` : body;
  }, [events]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !stickBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [text]);
  return <pre
    className="log-view"
    ref={ref}
    onScroll={() => {
      const node = ref.current;
      if (!node) return;
      stickBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    }}
  >{text || '点击执行后，过程会显示在这里。每个 Workflow 只有一条 Run。'}</pre>;
});

function ChatComposer({ placeholder, onSend, onStop, busy = false }: { placeholder: string; onSend: (text: string) => void | boolean | Promise<boolean>; onStop?: () => void | Promise<void>; busy?: boolean }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const locked = busy || sending;
  function submit() {
    if (locked) return;
    const text = draft.trim();
    if (!text) { void onSend(''); return; }
    setDraft('');
    setSending(true);
    void Promise.resolve(onSend(text)).then((sent) => {
      if (sent === false) setDraft(text);
    }).finally(() => setSending(false));
  }
  function stop() {
    if (!onStop || stopping || !busy) return;
    setStopping(true);
    void Promise.resolve(onStop()).finally(() => setStopping(false));
  }
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <label className="sr-only" htmlFor="node-chat-input">指导</label>
    <textarea id="node-chat-input" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return; event.preventDefault(); submit(); }} placeholder={locked ? 'Agent 正在回复…' : placeholder} disabled={locked} />
    {busy ? <button type="button" className="danger" onClick={stop} disabled={stopping}>{stopping ? '打断中…' : '打断'}</button> : <button type="submit" disabled={locked}>{sending ? '发送中' : '发送'}</button>}
  </form>;
}

type RuleDraft = { id: string; text: string };
type NodeEditor = { key: string | null; name: string; type: BoardNode['type']; capabilities: string[]; skills: string[]; providerId: string; modelId: string; question: string; instruction: string; outputRequirement: string; acceptanceRules: RuleDraft[]; maxRedos: string; requirement: string; anchorKey: string | null };

function ruleDrafts(value: string): RuleDraft[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map((text, index) => ({ id: `saved-${index}`, text }));
}
type InputFile = { name: string; size: number };

function ChatTurn({ message, fold }: { message: { id: number; role: string; content: string; thinking?: string | null; status: string }; fold: number }) {
  const thoughtRef = useRef<HTMLParagraphElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const streaming = message.status === 'streaming' || message.status === 'pending';
  const answer = message.content;
  const hasAnswer = answer.trim().length > 0;
  const thought = message.thinking?.trim() ?? '';
  const showThought = message.role === 'assistant' && (thought.length > 0 || (streaming && !hasAnswer));
  const thinkingOpen = streaming && !hasAnswer;
  useEffect(() => {
    const node = thoughtRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [thought, answer]);
  useLayoutEffect(() => {
    const node = detailsRef.current;
    if (!node || thinkingOpen) return;
    node.open = false;
  }, [thinkingOpen, fold]);
  return <article className={`message ${message.role}${streaming ? ' streaming' : ''}`}>
    <span>{message.role === 'user' ? '你' : 'Agent'}</span>
    {showThought ? <details className="thinking-box" ref={detailsRef} open={thinkingOpen ? true : undefined}>
      <summary>{streaming && !hasAnswer ? '正在思考' : '思考过程'}</summary>
      <p ref={thoughtRef}>{thought || '正在组织思路'}{streaming && !hasAnswer ? <i className="stream-caret" /> : null}</p>
    </details> : null}
    {hasAnswer || !streaming ? <p>{hasAnswer ? answer : '（没有回复）'}{streaming && hasAnswer ? <i className="stream-caret" /> : null}</p> : null}
  </article>;
}

export type WorkflowVersionOption = { id: number; version: string; seq: number; name: string; publishedAt?: string };

export function WorkflowBoard({
  mode, name, version, versions, currentVersionId, nodes, edges, loops, capabilities, skills, providers, models, events, progress, failures, checks, deliverables, reviewHistories, directory, runStatus, runStatusCode, dirty,
  onClose, onName, onSelectVersion, onNodes, onEdges, onLoops, onPersist, onPublish, onSave, onExecute, onStop, onOpenDirectory, onOpenDeliverable, onLoadSummary, onReadFile, onListFiles, onUploadFile, onDeleteFile,
  decisions, decisionNotes, onDecisionNote, onResolveDecision,
  chatNode, chatMessages, chatError, onOpenChat, onCloseChat, onSendChat, onStopChat,
}: {
  mode: 'create' | 'view';
  name: string;
  version: string;
  versions: WorkflowVersionOption[];
  currentVersionId: number | null;
  nodes: BoardNode[];
  edges: BoardEdge[];
  loops: BoardLoop[];
  capabilities: CapabilityRow[];
  skills: SkillRow[];
  providers: BoardProvider[];
  models: BoardModel[];
  events: EventRow[];
  progress: Record<string, string>;
  failures?: Record<string, string>;
  checks: Record<string, NodeCheck>;
  deliverables: Record<string, string>;
  reviewHistories?: Record<string, Record<string, NodeReviewEntry[]>>;
  directory: string;
  runStatus?: string;
  runStatusCode?: string;
  /** 画布内容与已发布版本不一致：还有没发布的修改 */
  dirty?: boolean;
  onClose: () => void;
  onName: (value: string) => void;
  onSelectVersion: (versionId: number) => void;
  onNodes: (nodes: BoardNode[]) => void;
  onEdges: (edges: BoardEdge[]) => void;
  onLoops: (loops: BoardLoop[]) => void;
  onPersist: (nodes: BoardNode[], edges: BoardEdge[], silent?: boolean, loops?: BoardLoop[]) => Promise<boolean>;
  onPublish: () => void;
  onSave?: () => void;
  onExecute: () => void;
  onStop: () => Promise<boolean>;
  decisions?: BoardDecision[];
  decisionNotes?: Record<number, string>;
  onDecisionNote?: (id: number, text: string) => void;
  onResolveDecision?: (
    id: number,
    action: 'approve' | 'return' | 'reject',
    options?: { decision?: string; reviews?: ReviewPayload[]; targetKey?: string },
  ) => void;
  onOpenDirectory: () => Promise<void>;
  onOpenDeliverable: (directory: string) => Promise<void>;
  onLoadSummary: () => Promise<{ nodes: SummaryNode[] }>;
  onReadFile: (filePath: string) => Promise<{ name: string; text?: string; binary?: boolean; path?: string }>;
  onListFiles: () => Promise<{ directory: string; files: InputFile[] }>;
  onUploadFile: (file: File) => Promise<void>;
  onDeleteFile: (name: string) => Promise<void>;
  chatNode: BoardNode | null;
  chatMessages: Array<{ id: number; role: string; content: string; thinking?: string | null; status: string }>;
  chatError: string;
  onOpenChat: (key: string) => void;
  onCloseChat: () => void;
  onSendChat: (content: string) => void | Promise<boolean>;
  onStopChat: () => void | Promise<void>;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: string; dx: number; dy: number; x: number; y: number; moved: boolean } | null>(null);
  const sizeRef = useRef<{ key: string; x: number; y: number; w: number; h: number; moved: boolean } | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const chatStickBottom = useRef(true);
  const [chatFold, setChatFold] = useState(0);
  function sendChat(text: string) {
    if (text.trim()) {
      chatStickBottom.current = true;
      setChatFold((value) => value + 1);
    }
    return onSendChat(text);
  }
  function onChatLogScroll() {
    const node = chatRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    chatStickBottom.current = distance < 48;
  }
  const linkRef = useRef<string | null>(null);
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const paneRef = useRef<{ startX: number; startW: number } | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  // 拖动/缩放过程中不要用 props 覆盖本地尺寸，否则轮询重渲染会把放大结果冲掉
  if (!dragRef.current && !sizeRef.current) {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(nodes[0]?.key ?? null);
  const [editor, setEditor] = useState<NodeEditor | null>(null);
  const [nodeError, setNodeError] = useState('');
  const [inputFiles, setInputFiles] = useState<InputFile[]>([]);
  const [inputDirectory, setInputDirectory] = useState('');
  const [loopOpen, setLoopOpen] = useState(false);
  const [loopNodes, setLoopNodes] = useState<string[]>([]);
  const [loopMax, setLoopMax] = useState('1');
  const [logOpen, setLogOpen] = useState(false);
  const [logHeight, setLogHeight] = useState(220);
  const [logFloorId, setLogFloorId] = useState(0);
  const [chatWidth, setChatWidth] = useState(340);
  const [banner, setBanner] = useState('');
  const [acceptanceView, setAcceptanceView] = useState<{ check: NodeCheck; nodeKey: string } | null>(null);
  const [reviewHistoryKey, setReviewHistoryKey] = useState<string | null>(null);
  /** 人工复核：按「决策id:上游key」分别记说明 */
  const [upstreamNotes, setUpstreamNotes] = useState<Record<string, string>>({});
  const [rejectNote, setRejectNote] = useState('');
  const [decisionView, setDecisionView] = useState<number | null>(null);
  const seenDecisions = useRef<Set<number>>(new Set());
  const [nodeMenu, setNodeMenu] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryNodes, setSummaryNodes] = useState<SummaryNode[] | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [fileView, setFileView] = useState<{ name: string; text: string; path: string } | null>(null);
  const editable = mode === 'create';
  const running = runStatusCode === 'running';
  const canEdit = !running;

  useEffect(() => {
    chatStickBottom.current = true;
  }, [chatNode?.key]);
  useEffect(() => {
    const node = chatRef.current;
    if (!node || !chatStickBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [chatMessages, chatNode?.key]);
  useEffect(() => { if (running) setBanner(''); }, [running]);
  useAutoDismiss(banner, setBanner);
  useAutoDismiss(nodeError, setNodeError);
  useAutoDismiss(summaryError, setSummaryError);
  const seenFailureKey = useRef('');
  useEffect(() => {
    const entries = Object.entries(failures ?? {}).filter(([, reason]) => reason.trim());
    if (!entries.length) {
      seenFailureKey.current = '';
      return;
    }
    const fingerprint = entries.map(([key, reason]) => `${key}:${reason}`).join('|');
    if (fingerprint === seenFailureKey.current) return;
    seenFailureKey.current = fingerprint;
    const text = entries.map(([key, reason]) => {
      const host = nodes.find((node) => node.key === key);
      return `${host?.name || key}：${reason}`;
    }).join('；');
    setBanner(`执行失败：${text}`);
    setLogOpen(true);
  }, [failures, nodes]);
  const decisionsByNode = useMemo(() => {
    const map = new Map<string, BoardDecision>();
    for (const item of decisions ?? []) {
      // 只挂待处理决策；已批准/退回/拒绝的不能继续占着「待确认」
      if (item.status && item.status !== 'pending') continue;
      const key = decisionNodeKey(item);
      if (key && !map.has(key)) map.set(key, item);
    }
    return map;
  }, [decisions]);
  const reviewHistoryByNode = useMemo(() => {
    const map = new Map<string, BoardDecision[]>();
    for (const item of decisions ?? []) {
      if (!item.status || item.status === 'pending' || item.status === 'superseded') continue;
      if (decisionKind(item) === 'acceptance') continue;
      const key = decisionNodeKey(item);
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    for (const [key, list] of map) {
      list.sort((a, b) => {
        const at = Date.parse(a.resolvedAt || a.createdAt || '') || a.id;
        const bt = Date.parse(b.resolvedAt || b.createdAt || '') || b.id;
        return bt - at;
      });
      map.set(key, list);
    }
    return map;
  }, [decisions]);
  function openAcceptanceDetail(nodeKey: string, check?: NodeCheck | null, pending?: BoardDecision | null) {
    const decision = pending ?? decisionsByNode.get(nodeKey) ?? null;
    if (decision) setDecisionView(decision.id);
    setAcceptanceView({
      nodeKey,
      check: check ?? checks[nodeKey] ?? {
        verdict: 'unclear',
        label: '待确认',
        detail: decision?.question ?? '请确认后继续。',
      },
    });
  }
  const activeDecision = decisions?.find((item) => item.id === decisionView) ?? null;
  useEffect(() => {
    const live = new Set((decisions ?? []).map((item) => item.id));
    for (const id of [...seenDecisions.current]) if (!live.has(id)) seenDecisions.current.delete(id);
    if (decisionView != null && !live.has(decisionView)) {
      setDecisionView(null);
      setAcceptanceView(null);
    }
    // 当前打开的决策已处理完：切到该节点的历史；从头开始作废的则直接关掉
    if (decisionView != null) {
      const current = (decisions ?? []).find((item) => item.id === decisionView);
      if (current?.status === 'superseded') {
        setDecisionView(null);
        setReviewHistoryKey(null);
        setAcceptanceView(null);
        seenDecisions.current.delete(current.id);
      } else if (current && current.status && current.status !== 'pending') {
        const key = decisionNodeKey(current);
        setDecisionView(null);
        if (key) setReviewHistoryKey(key);
      }
    }
    for (const item of decisions ?? []) {
      if (item.status && item.status !== 'pending') continue;
      if (seenDecisions.current.has(item.id)) continue;
      seenDecisions.current.add(item.id);
      setReviewHistoryKey(null);
      setDecisionView(item.id);
      const key = decisionNodeKey(item);
      if (key) setSelected(key);
      // 校验待处理：直接打开详情面板，在面板里批准继续 / 再做一次
      if (key && decisionKind(item) === 'acceptance') {
        setAcceptanceView({
          nodeKey: key,
          check: checks[key] ?? { verdict: 'unclear', label: '待确认', detail: item.question },
        });
      }
      break;
    }
  }, [decisions, decisionView, checks]);
  useEffect(() => {
    if (!nodeMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-action="menu"]')) return;
      setNodeMenu(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setNodeMenu(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [nodeMenu]);
  useEffect(() => {
    if (!editor) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setEditor(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor]);

  function point(event: { clientX: number; clientY: number }) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  const decisionHost = activeDecision ? nodes.find((node) => node.key === decisionNodeKey(activeDecision)) : null;
  const bounds = nodes.reduce((box, node) => {
    const size = nodeBox(node);
    const extra = decisionHost?.key === node.key ? 220 : 120;
    return { w: Math.max(box.w, node.x + Math.max(size.w, 300) + 120), h: Math.max(box.h, node.y + size.h + extra) };
  }, { w: 960, h: 520 });
  function moveNode(key: string, x: number, y: number) {
    const next = nodesRef.current.map((node) => node.key === key ? { ...node, x: Math.max(8, x), y: Math.max(8, y) } : node);
    nodesRef.current = next;
    onNodes(next);
  }
  function guardEdit() {
    if (canEdit) return true;
    setBanner('请先停止 Run，再编辑 Agent');
    return false;
  }
  function openCreate(anchor?: BoardNode) {
    if (!guardEdit()) return;
    setNodeError('');
    setEditor({ key: null, name: '', type: 'task', capabilities: [], skills: [], providerId: '', modelId: '', question: '', instruction: '', outputRequirement: '', acceptanceRules: [], maxRedos: '3', requirement: '', anchorKey: anchor?.key ?? null });
  }
  function openEdit(node: BoardNode) {
    if (!guardEdit()) return;
    setNodeError('');
    setSelected(node.key);
    const model = node.modelId ? models.find((item) => item.id === node.modelId) : undefined;
    setEditor({
      key: node.key,
      name: node.name,
      type: node.type,
      capabilities: [...node.capabilities],
      skills: [...(node.skills ?? [])],
      providerId: model ? String(model.providerId) : '',
      modelId: node.modelId ? String(node.modelId) : '',
      question: node.question,
      instruction: node.instruction,
      outputRequirement: node.outputRequirement,
      acceptanceRules: ruleDrafts(node.acceptanceRule),
      maxRedos: String(node.maxRedos || 3),
      requirement: node.requirement,
      anchorKey: null,
    });
    if (node.type === 'start') {
      void onListFiles().then((result) => { setInputFiles(result.files); setInputDirectory(result.directory); }).catch((cause) => setNodeError(cause instanceof Error ? cause.message : '文件列表加载失败'));
    }
  }
  function placeNext(anchor: BoardNode) {
    const anchorSize = nodeBox(anchor);
    const x = anchor.x + anchorSize.w + 88;
    let y = anchor.y;
    const blocked = (nx: number, ny: number) => nodes.some((item) => {
      const size = nodeBox(item);
      return Math.abs(item.x - nx) < size.w - 24 && Math.abs(item.y - ny) < size.h - 8;
    });
    while (blocked(x, y)) y += NODE_H + 36;
    return { x, y };
  }
  async function saveNode(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    const name = editor.name.trim();
    if (!name) { setNodeError(editor.type === 'task' ? '请填写 Agent 节点的名称' : '请填写名称'); return; }
    const structural = editor.type === 'start' || editor.type === 'end';
    const checkpoint = editor.type === 'checkpoint';
    if (editor.type === 'task' && !editor.capabilities.length) { setNodeError('请至少选择一项能力'); return; }
    const selectedModelId = Number(editor.modelId);
    const nextModelId = editor.type === 'task' && Number.isInteger(selectedModelId) && selectedModelId > 0 ? selectedModelId : null;
    if (editor.type === 'task' && !nextModelId) { setNodeError('请为这个 Agent 选择模型'); return; }
    if (editor.type === 'task' && nextModelId && !models.some((item) => item.id === nextModelId)) {
      setNodeError('所选模型不可用，请到「模型管理」确认后再选');
      return;
    }
    const question = checkpoint ? editor.question.trim() : '';
    const instruction = structural || checkpoint ? '' : editor.instruction.trim();
    const outputRequirement = structural || checkpoint ? '' : editor.outputRequirement.trim();
    const acceptanceRule = editor.type === 'task' ? editor.acceptanceRules.map((item) => item.text.trim()).filter(Boolean).join('\n') : '';
    const maxRedos = Number(editor.maxRedos);
    if (acceptanceRule && (!Number.isInteger(maxRedos) || maxRedos < 1)) { setNodeError('最多退回次数至少为 1'); return; }
    const requirement = editor.requirement;
    let nextNodes = nodes;
    let nextEdges = edges;
    let key = editor.key;
    const acceptance = { acceptanceRule, maxRedos: Number.isInteger(maxRedos) && maxRedos >= 1 ? maxRedos : 3 };
    const nextSkills = structural || checkpoint ? [] : editor.skills;
    const nextCapabilities = editor.type === 'task' ? editor.capabilities : [];
    if (key) {
      nextNodes = nodes.map((node) => node.key === key ? { ...node, name, type: editor.type, capabilities: nextCapabilities, skills: nextSkills, modelId: nextModelId, question, instruction, outputRequirement, ...acceptance, requirement } : node);
    } else {
      key = `node-${Date.now()}`;
      const anchor = editor.anchorKey ? nodes.find((node) => node.key === editor.anchorKey) : undefined;
      const position = anchor ? placeNext(anchor) : { x: 80 + (nodes.length % 4) * 40, y: 80 + (nodes.length % 3) * 36 };
      nextNodes = [...nodes, { key, name, type: editor.type, capabilities: nextCapabilities, skills: nextSkills, modelId: nextModelId, question, instruction, outputRequirement, ...acceptance, requirement, ...position, w: NODE_W, h: NODE_H }];
      if (anchor && !edges.some((edge) => edge.source === anchor.key && edge.target === key)) {
        nextEdges = [...edges, { source: anchor.key, target: key }];
      }
    }
    const saved = await onPersist(nextNodes, nextEdges);
    if (!saved) return;
    onNodes(nextNodes);
    onEdges(nextEdges);
    setSelected(key);
    setEditor(null);
    setNodeError('');
  }
  async function removeNode(key: string) {
    if (!guardEdit()) return;
    const target = nodes.find((node) => node.key === key);
    if (target?.type === 'start' || target?.type === 'end') { setBanner('开始和结束不能删除'); return; }
    const nextNodes = nodes.filter((node) => node.key !== key);
    const nextEdges = edges.filter((edge) => edge.source !== key && edge.target !== key);
    const nextLoops = loops.map((loop) => ({ ...loop, nodeKeys: loop.nodeKeys.filter((item) => item !== key) })).filter((loop) => loop.nodeKeys.length > 0);
    onLoops(nextLoops);
    const saved = await onPersist(nextNodes, nextEdges, false, nextLoops);
    if (!saved) return;
    onNodes(nextNodes);
    onEdges(nextEdges);
    if (selected === key) setSelected(null);
    if (editor?.key === key) setEditor(null);
  }
  async function removeEdge(source: string, target: string) {
    if (!guardEdit()) return;
    const nextEdges = edges.filter((edge) => edge.source !== source || edge.target !== target);
    const saved = await onPersist(nodes, nextEdges);
    if (!saved) return;
    onEdges(nextEdges);
  }
  async function connect(source: string, target: string) {
    if (!guardEdit()) return;
    if (!source || !target || source === target) return;
    if (edges.some((edge) => edge.source === source && edge.target === target)) return;
    const nextEdges = [...edges, { source, target }];
    const saved = await onPersist(nodes, nextEdges);
    if (!saved) return;
    onEdges(nextEdges);
  }
  function resizeNode(key: string, w: number, h: number) {
    const next = nodesRef.current.map((node) => node.key === key ? { ...node, w: clampSize(w, NODE_W, NODE_MIN_W, NODE_MAX_W), h: clampSize(h, NODE_H, NODE_MIN_H, NODE_MAX_H) } : node);
    nodesRef.current = next;
    onNodes(next);
  }
  function onCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (sizeRef.current) {
      const sizing = sizeRef.current;
      const w = sizing.w + event.clientX - sizing.x;
      const h = sizing.h + event.clientY - sizing.y;
      if (Math.abs(event.clientX - sizing.x) > 2 || Math.abs(event.clientY - sizing.y) > 2) sizing.moved = true;
      resizeNode(sizing.key, w, h);
    }
    if (dragRef.current) {
      if (Math.abs(event.clientX - dragRef.current.x) > 4 || Math.abs(event.clientY - dragRef.current.y) > 4) dragRef.current.moved = true;
      if (dragRef.current.moved) {
        const here = point(event);
        moveNode(dragRef.current.key, here.x - dragRef.current.dx, here.y - dragRef.current.dy);
      }
    }
    if (linkRef.current) setCursor(point(event));
  }
  function onCanvasPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const sizing = sizeRef.current;
    const dragged = dragRef.current;
    const source = linkRef.current;
    sizeRef.current = null;
    dragRef.current = null;
    linkRef.current = null;
    setCursor(null);
    if (sizing) {
      if (sizing.moved && canEdit) void onPersist(nodesRef.current, edgesRef.current, true);
      return;
    }
    if (dragged && !dragged.moved && !source) {
      const node = nodesRef.current.find((item) => item.key === dragged.key);
      if (node?.type === 'end') {
        setSummaryOpen(true);
        setSummaryError('');
        setSummaryNodes(null);
        void onLoadSummary().then((result) => setSummaryNodes(result.nodes)).catch((cause) => setSummaryError(cause instanceof Error ? cause.message : '流程结果加载失败'));
        return;
      }
      if (node?.type === 'checkpoint') {
        // 人工节点不打开右侧对话；有待确认打开复核面板，否则看历史
        const pending = decisionsByNode.get(node.key);
        setSelected(node.key);
        if (pending && decisionKind(pending) !== 'acceptance') {
          setReviewHistoryKey(null);
          setDecisionView(pending.id);
        } else if (
          (reviewHistoryByNode.get(node.key) ?? []).length > 0
          || Object.values(reviewHistories?.[node.key] ?? {}).some((entries) => entries.length > 0)
        ) {
          setDecisionView(null);
          setReviewHistoryKey(node.key);
        }
        return;
      }
      if (node) {
        const pending = decisionsByNode.get(node.key);
        if (pending && decisionKind(pending) === 'acceptance') {
          openAcceptanceDetail(node.key, checks[node.key], pending);
          return;
        }
      }
      if (node && node.type !== 'start') onOpenChat(node.key);
      return;
    }
    if (dragged?.moved && canEdit) void onPersist(nodesRef.current, edgesRef.current, true);
    if (!source || !canEdit) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const port = hit?.closest('[data-port="in"]');
    const target = port?.getAttribute('data-node');
    if (target) void connect(source, target);
  }
  function startNodeResize(node: BoardNode, event: ReactPointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const size = nodeBox(node);
    sizeRef.current = { key: node.key, x: event.clientX, y: event.clientY, w: size.w, h: size.h, moved: false };
    setSelected(node.key);
    canvasRef.current?.setPointerCapture(event.pointerId);
  }
  function startDrag(node: BoardNode, event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('[data-port],[data-action]')) return;
    const here = point(event);
    dragRef.current = { key: node.key, dx: here.x - node.x, dy: here.y - node.y, x: event.clientX, y: event.clientY, moved: false };
    setSelected(node.key);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function startLink(node: BoardNode, event: ReactPointerEvent<HTMLButtonElement>) {
    if (!guardEdit()) return;
    event.stopPropagation();
    linkRef.current = node.key;
    setCursor(point(event));
    canvasRef.current?.setPointerCapture(event.pointerId);
  }
  function capabilityText(keys: string[]) {
    return keys.map((key) => capabilities.find((item) => item.key === key)?.name ?? key).join('、');
  }
  function skillText(keys: string[]) {
    return keys.map((key) => skills.find((item) => item.key === key)?.name ?? key).join('、');
  }
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    resizeRef.current = { startY: event.clientY, startH: logHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeRef.current) return;
    const boardHeight = boardRef.current?.clientHeight ?? window.innerHeight;
    const max = Math.max(140, boardHeight - 180);
    const next = resizeRef.current.startH + (resizeRef.current.startY - event.clientY);
    setLogHeight(Math.min(max, Math.max(96, next)));
  }
  function endResize() {
    resizeRef.current = null;
  }
  function startPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    paneRef.current = { startX: event.clientX, startW: chatWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function movePaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = paneRef.current;
    if (!drag) return;
    const boardWidth = boardRef.current?.clientWidth ?? window.innerWidth;
    const max = Math.max(240, boardWidth - 250);
    const next = drag.startW - (event.clientX - drag.startX);
    setChatWidth(Math.min(max, Math.max(240, next)));
  }
  function endPaneResize() {
    paneRef.current = null;
  }

  const sourceNode = cursor && linkRef.current ? nodes.find((node) => node.key === linkRef.current) : null;

  return <div className="workflow-board" ref={boardRef} role="dialog" aria-label={editable ? '新建 Workflow' : name || 'Workflow'}>
    <header className="board-bar">
      <label>名称<input value={name} onChange={(event) => onName(event.target.value)} placeholder="例如实现功能" readOnly={!canEdit} /></label>
      <label>版本{versions.length ? (
        <select
          value={currentVersionId ?? ''}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isInteger(next) || next < 1 || next === currentVersionId) return;
            onSelectVersion(next);
          }}
          disabled={!versions.length}
          title={version}
        >
          {!currentVersionId ? <option value="">未发布</option> : null}
          {versions.map((item) => <option key={item.id} value={item.id}>{item.version}</option>)}
        </select>
      ) : (
        <input value={version || '未发布'} readOnly />
      )}</label>
      <label className="board-root">主目录<button type="button" title={directory || '打开主目录'} onClick={() => void onOpenDirectory()}>{directory || '打开主目录'}</button></label>
      <div className="run-controls board-bar-actions">
        {onSave ? <button type="button" onClick={() => { if (!guardEdit()) return; onSave(); }} disabled={running}>{currentVersionId ? '保存' : '保存草稿'}</button> : null}
        <button type="button" onClick={() => { if (!guardEdit()) return; onPublish(); }} disabled={running}>{editable ? '发布 Workflow' : '发布'}</button>
        <button type="button" onClick={() => void (async () => {
          if (canEdit) await onPersist(nodesRef.current, edgesRef.current, true);
          onClose();
        })()}>返回列表</button>
      </div>
      {currentVersionId ? (dirty ? <span className="board-dirty">有未发布的修改</span> : <span className="board-dirty clean">与当前版本一致</span>) : <span className="board-dirty">尚未发布</span>}
    </header>
    <div className={`board-body${chatNode ? ' with-chat' : ''}`} style={{ '--chat-width': `${chatWidth}px` } as CSSProperties}>
      <div className="board-stage">
        <div className="panel-head">
          {runStatusCode === 'awaiting_decision'
            ? <h3>等待人工复核：点高亮节点上的「待确认」，或点节点打开批准/重做</h3>
            : running ? <h3>运行中可以拖动 Agent，点节点可以对话</h3> : <span />}
          <div className="run-controls">
            <button type="button" onClick={() => openCreate()}>添加 Agent 节点</button>
            <button type="button" onClick={() => { if (!guardEdit()) return; const current = loops[0]; setLoopNodes(current?.nodeKeys ?? []); setLoopMax(String(current?.maxIterations ?? 1)); setLoopOpen(true); }}>循环</button>
            <button type="button" onClick={onExecute}>执行</button>
            <button type="button" onClick={() => void onStop()}>停止</button>
            <button type="button" onClick={() => setLogOpen((open) => !open)} aria-expanded={logOpen}>{logOpen ? '收起日志' : '查看日志'}{runStatus ? ` · ${runStatus}` : ''}</button>
          </div>
        </div>
        {banner ? <p className="alert">{banner}</p> : null}
        <div className="board-scroll">
        <div className="board-canvas" ref={canvasRef} style={{ width: bounds.w, height: bounds.h }} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp}>
          <svg className="board-links">
            {edges.map((edge) => {
              const from = nodes.find((node) => node.key === edge.source);
              const to = nodes.find((node) => node.key === edge.target);
              if (!from || !to) return null;
              const fromSize = nodeBox(from);
              const toSize = nodeBox(to);
              const x1 = from.x + fromSize.w;
              const y1 = from.y + fromSize.h / 2;
              const x2 = to.x;
              const y2 = to.y + toSize.h / 2;
              const mid = (x1 + x2) / 2;
              const d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
              return <g key={`${edge.source}-${edge.target}`}>
                <path className="edge-hit" d={d} aria-label="双击删除连线" onDoubleClick={() => void removeEdge(edge.source, edge.target)} />
                <path d={d} />
              </g>;
            })}
            {sourceNode && cursor ? <path d={`M ${sourceNode.x + nodeBox(sourceNode).w} ${sourceNode.y + nodeBox(sourceNode).h / 2} L ${cursor.x} ${cursor.y}`} /> : null}
          </svg>
          {nodes.map((node) => {
            const nodeStatus = progress[node.key];
            const statusLabel = nodeStatus ? NODE_STATUS[nodeStatus] ?? nodeStatus : '';
            const failureReason = nodeStatus === 'failed' ? (failures?.[node.key] ?? '') : '';
            const pending = decisionsByNode.get(node.key);
            const check = checks[node.key];
            const modelLabel = node.type === 'task' && node.modelId
              ? (models.find((item) => item.id === node.modelId)?.displayName ?? `模型 #${node.modelId}`)
              : '';
            // 有未处理决策就显示「待确认」；不要再卡进度状态，否则会只剩「不合格」却没有继续入口
            const showDecision = Boolean(pending);
            // unclear/待确认只走上面的决策按钮，确认后不再用校验标签显示「待确认」
            const showCheck = Boolean(check) && !showDecision && (check.verdict === 'pass' || check.verdict === 'reject');
            const size = nodeBox(node);
            return <article className={`board-node ${node.type} ${selected === node.key ? 'selected' : ''} ${nodeStatus ? `status-${nodeStatus}` : ''} ${showDecision ? 'needs-decision' : ''} ${failureReason ? 'has-failure' : ''}`} key={node.key} style={{ left: node.x, top: node.y, width: size.w, height: size.h }} onPointerDown={(event) => startDrag(node, event)}>
            <button type="button" className="port in" data-port="in" data-node={node.key} aria-label="连入" />
            <div className="node-menu-wrap">
              <button type="button" className="node-more" data-action="menu" aria-label="更多" aria-expanded={nodeMenu === node.key} title="更多" onPointerDown={(event) => event.stopPropagation()} onClick={() => setNodeMenu((current) => current === node.key ? null : node.key)}>⋯</button>
              {nodeMenu === node.key ? <div className="node-menu" role="menu" data-action="menu">
                <button type="button" role="menuitem" data-action="menu" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setNodeMenu(null); openEdit(node); }}>编辑</button>
                {node.type === 'start' || node.type === 'end' ? null : node.type === 'checkpoint' ? (() => {
                  const items = checkpointUpstreams(node.key, nodes, edges, deliverables).filter((item) => item.folder);
                  if (items.length === 0) {
                    return <button type="button" role="menuitem" data-action="menu" onPointerDown={(event) => event.stopPropagation()} onClick={() => {
                      setNodeMenu(null);
                      setBanner('上游还没有交付物，等 Agent 产出后再打开');
                    }}>交付物</button>;
                  }
                  if (items.length === 1) {
                    return <button type="button" role="menuitem" data-action="menu" onPointerDown={(event) => event.stopPropagation()} onClick={() => {
                      setNodeMenu(null);
                      void onOpenDeliverable(items[0]!.folder);
                    }}>交付物 · {items[0]!.name}</button>;
                  }
                  return items.map((item) => <button type="button" role="menuitem" data-action="menu" key={`deliverable-${item.key}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => {
                    setNodeMenu(null);
                    void onOpenDeliverable(item.folder);
                  }}>交付物 · {item.name}</button>);
                })() : <button type="button" role="menuitem" data-action="menu" onPointerDown={(event) => event.stopPropagation()} onClick={() => {
                  setNodeMenu(null);
                  const folder = deliverables[node.key] || '';
                  if (!folder) {
                    setBanner('这个节点还没有交付物');
                    return;
                  }
                  void onOpenDeliverable(folder);
                }}>交付物</button>}
                {node.type === 'start' || node.type === 'end' ? null : <button type="button" role="menuitem" className="danger" data-action="menu" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setNodeMenu(null); void removeNode(node.key); }}>删除</button>}
              </div> : null}
            </div>
            {showDecision ? <button type="button" className="decision-mark" data-action="decision" title="在此节点确认" onPointerDown={(event) => event.stopPropagation()} onClick={() => {
              if (decisionKind(pending!) === 'acceptance') openAcceptanceDetail(node.key, check, pending);
              else setDecisionView(pending!.id);
            }}>待确认</button> : <>
              {statusLabel ? <em className={`node-status ${nodeStatus}`} title={failureReason || undefined}>{statusLabel}</em> : null}
              {showCheck ? <button type="button" className={`acceptance-mark ${check!.verdict}`} data-action="acceptance" title="查看判断依据" onClick={() => openAcceptanceDetail(node.key, check, pending)}>{check!.label}</button> : null}
            </>}
            <strong>{node.name || (node.type === 'task' ? '未命名 Agent' : '未命名')}</strong>
            {failureReason ? <p className="node-failure" title={failureReason}>{failureReason}</p> : null}
            <small>{node.type === 'end' ? '点此查看流程进度和产物' : node.type === 'task' ? <em className="agent-mark">Agent 节点</em> : roleTitle(node.type)}{node.type === 'end' ? '' : loops.some((loop) => loop.nodeKeys.includes(node.key)) ? ' · 循环' : ''}{modelLabel ? ` · ${modelLabel}` : node.type === 'task' ? ' · 未选模型' : ''}{node.type === 'task' && node.acceptanceRule.trim() ? ' · 校验上游' : ''}{node.type !== 'end' && node.capabilities.length ? ` · ${capabilityText(node.capabilities)}` : ''}{node.type === 'task' && (node.skills?.length ?? 0) > 0 ? ` · Skill ${skillText(node.skills)}` : ''}</small>
            <button type="button" className="port out" data-port="out" data-node={node.key} aria-label="连出" onPointerDown={(event) => startLink(node, event)} />
            <button type="button" className="node-resize" data-action="resize" aria-label="调整节点大小" title="拖动调整大小" onPointerDown={(event) => startNodeResize(node, event)} />
            <button type="button" className="node-add" data-action="add" aria-label="新建下一个 Agent 节点" onPointerDown={(event) => event.stopPropagation()} onClick={() => openCreate(node)} />
          </article>;
          })}
          {(() => {
            const pending = activeDecision
              && (!activeDecision.status || activeDecision.status === 'pending')
              && decisionKind(activeDecision) !== 'acceptance'
              ? activeDecision
              : null;
            const historyKey = pending ? decisionNodeKey(pending) : reviewHistoryKey;
            if (!historyKey && !pending) return null;
            const hostKey = historyKey ?? decisionNodeKey(pending!);
            const host = hostKey ? nodes.find((node) => node.key === hostKey) : null;
            if (!host) return null;
            const size = nodeBox(host);
            return <div
              className="node-decision-pop"
              data-action="decision"
              style={{ left: host.x, top: host.y + size.h + 8, width: Math.max(size.w, 360) }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="node-decision-head">
                <strong>{pending ? '人工复核' : '复核历史'}</strong>
                <button type="button" onClick={() => { setDecisionView(null); setReviewHistoryKey(null); }}>收起</button>
              </div>
              {(() => {
                const upstreams = checkpointUpstreams(host.key, nodes, edges, deliverables);
                const byUpstream = mergeUpstreamHistories(reviewHistories?.[host.key], decisions, host.key);
                const noteOf = (key: string) => pending ? (upstreamNotes[`${pending.id}:${key}`] ?? '') : '';
                const setNote = (key: string, text: string) => {
                  if (!pending) return;
                  setUpstreamNotes((current) => ({ ...current, [`${pending.id}:${key}`]: text }));
                };
                const buildReviews = (action: 'approve' | 'return' | 'reject', onlyKey?: string) => upstreams
                  .filter((item) => !onlyKey || item.key === onlyKey)
                  .map((item) => ({
                    key: item.key,
                    name: item.name,
                    note: noteOf(item.key).trim(),
                    action: onlyKey ? 'return' as const : action,
                  }));
                const orphanHistory = byUpstream._all ?? [];
                const hasAnyHistory = upstreams.some((item) => (byUpstream[item.key] ?? []).length > 0) || orphanHistory.length > 0;
                if (!pending && !hasAnyHistory) return <p className="muted">还没有复核记录。</p>;
                return <>
                  {pending && reviewQuestionText(pending.question) ? <p className="decision-question">{reviewQuestionText(pending.question)}</p> : null}
                  {upstreams.length ? <div className="review-upstreams">
                    {upstreams.map((item) => {
                      const nodeHistory = byUpstream[item.key] ?? [];
                      const humanUpstream = item.type === 'checkpoint';
                      return <article className="review-upstream-card" key={item.key}>
                        <header>
                          <strong>{item.name}{humanUpstream ? ' · 人工复核' : ''}</strong>
                          {item.folder ? <button type="button" className="review-deliverable-link" onClick={() => void onOpenDeliverable(item.folder)}>打开交付物</button> : null}
                        </header>
                        {nodeHistory.length ? <div className="review-node-history">
                          {nodeHistory.map((entry, index) => <article className="review-history-item" key={`${item.key}-${entry.at ?? index}-${index}`}>
                            <header>
                              <span>{reviewActionLabel(entry.action)}</span>
                              <time>{entry.at ? new Date(entry.at).toLocaleString('zh-CN', { hour12: false }) : ''}</time>
                            </header>
                            <p className="prose">{entry.note.trim() || '（没有填写说明）'}</p>
                          </article>)}
                        </div> : null}
                        {pending ? humanUpstream ? <p className="alert">不能退回到人工节点</p> : <>
                          <textarea
                            value={noteOf(item.key)}
                            onChange={(event) => setNote(item.key, event.target.value)}
                            placeholder="复核说明"
                          />
                          <div className="decision-actions">
                            <button type="button" onClick={() => {
                              const note = noteOf(item.key).trim();
                              if (note.length < 2) { setBanner(`退回「${item.name}」时请填写说明`); return; }
                              onResolveDecision?.(pending.id, 'return', {
                                decision: `【${item.name}】${note}`,
                                reviews: buildReviews('return', item.key),
                                targetKey: item.key,
                              });
                            }}>退回此节点</button>
                          </div>
                        </> : null}
                      </article>;
                    })}
                  </div> : pending ? <p className="alert">没有可复核的上游 Agent</p> : null}
                  {orphanHistory.length ? <div className="review-node-history">
                    {orphanHistory.map((entry, index) => <article className="review-history-item" key={`all-${entry.at ?? index}`}>
                      <header>
                        <span>{reviewActionLabel(entry.action)}</span>
                        <time>{entry.at ? new Date(entry.at).toLocaleString('zh-CN', { hour12: false }) : ''}</time>
                      </header>
                      <p className="prose">{entry.note.trim() || '（没有填写说明）'}</p>
                    </article>)}
                  </div> : null}
                  {pending ? <>
                    <textarea
                      className="review-reject-input"
                      value={rejectNote}
                      onChange={(event) => setRejectNote(event.target.value)}
                      placeholder="拒绝说明"
                    />
                    <div className="decision-actions">
                      <button type="button" className="decision-primary" onClick={() => {
                        const approvable = upstreams.filter((item) => item.type !== 'checkpoint');
                        if (!approvable.length) { setBanner('没有可批准的上游 Agent'); return; }
                        const reviews = approvable.map((item) => ({
                          key: item.key,
                          name: item.name,
                          note: noteOf(item.key).trim() || '批准',
                          action: 'approve' as const,
                        }));
                        onResolveDecision?.(pending.id, 'approve', {
                          decision: reviews.map((item) => `【${item.name}】${item.note}`).join('\n'),
                          reviews,
                        });
                      }}>全部批准</button>
                      <button type="button" className="danger" onClick={() => {
                        const fromNodes = upstreams
                          .filter((item) => item.type !== 'checkpoint' && noteOf(item.key).trim())
                          .map((item) => `【${item.name}】${noteOf(item.key).trim()}`)
                          .join('\n');
                        const rejectText = rejectNote.trim() || fromNodes;
                        if (rejectText.length < 2) { setBanner('拒绝时请填写说明'); return; }
                        onResolveDecision?.(pending.id, 'reject', {
                          decision: rejectText,
                          reviews: upstreams.filter((item) => item.type !== 'checkpoint').map((item) => ({
                            key: item.key,
                            name: item.name,
                            note: noteOf(item.key).trim() || rejectText,
                            action: 'reject' as const,
                          })),
                        });
                      }}>拒绝</button>
                    </div>
                  </> : null}
                </>;
              })()}
            </div>;
          })()}
        </div>
        </div>
      </div>
      {chatNode ? <div className="pane-resize" role="separator" aria-orientation="vertical" aria-label="调整对话宽度" onPointerDown={startPaneResize} onPointerMove={movePaneResize} onPointerUp={endPaneResize} onPointerCancel={endPaneResize} /> : null}
      {chatNode ? <aside className="node-chat" aria-label={`${chatNode.name}的对话`}>
        <div className="panel-head"><h3>{chatNode.name || (chatNode.type === 'task' ? '未命名 Agent' : '未命名')}</h3><button type="button" onClick={onCloseChat}>关闭</button></div>
        <p className="muted">{chatNode.type === 'checkpoint' ? '这里只记复核指导，不调用模型。批准/退回/拒绝请点节点上的「待确认」。多个上游时，请按节点分别写说明；退回只会重跑被退回的那个 Agent。' : running ? '执行还在进行。对话会带上当前任务上下文，可以问它在做什么；但不会中途改写这次执行，新指导留给之后。' : '和这个 Agent 沟通。若已有执行记录，对话会带上最近任务上下文；指导会留下来给之后的执行。'}</p>
        {chatError ? <p className="alert">{chatError}</p> : null}
        <div className="node-chat-log" ref={chatRef} onScroll={onChatLogScroll}>
          {chatMessages.length ? chatMessages.map((message) => <ChatTurn message={message} fold={chatFold} key={message.id} />) : <p className="muted">{chatNode.type === 'checkpoint' ? '还没有指导。写下这次复核要特别看什么。' : '还没有对话。写下你希望这个 Agent 怎么做。'}</p>}
        </div>
        <ChatComposer key={chatNode.key} busy={chatMessages.some((item) => item.status === 'streaming' || item.status === 'pending')} placeholder={chatNode.type === 'checkpoint' ? '告诉这次复核要看什么，回车发送' : '指导这个 Agent，回车发送'} onSend={sendChat} onStop={onStopChat} />
      </aside> : null}
    </div>
    {editor ? <div className="node-dialog-backdrop" onMouseDown={() => setEditor(null)}>
      <form className="node-dialog panel form" role="dialog" aria-modal="true" aria-label={editor.type === 'task' ? (editor.key ? '编辑 Agent 节点' : '新建 Agent 节点') : roleTitle(editor.type)} onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void saveNode(event)}>
        <div className="panel-head"><h3>{editor.type === 'task' ? (editor.key ? '编辑 Agent 节点' : '新建 Agent 节点') : editor.type === 'checkpoint' ? (editor.key ? '编辑人工复核' : '新建人工复核') : roleTitle(editor.type)}</h3><button type="button" onClick={() => setEditor(null)}>关闭</button></div>
        {nodeError ? <p className="alert">{nodeError}</p> : null}
        <label>名称<input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder={editor.type === 'task' ? '这个 Agent 在协作里的名称' : '面板上显示的名称'} /></label>
        {editor.type === 'start' || editor.type === 'end' ? <p className="muted">{editor.type === 'start' ? '开始负责把这次的需求描述和文件交给后面的 Agent，本身不调用模型。' : '结束汇总整条流程的进度，并列出每个节点的产物文件。点结束节点可以查看，点文件名打开内容。本身不调用模型。'}</p> : <label>类型<select value={editor.type} onChange={(event) => {
          const nextType = event.target.value === 'checkpoint' ? 'checkpoint' : 'task';
          setEditor({
            ...editor,
            type: nextType,
            ...(nextType === 'checkpoint' ? { providerId: '', modelId: '', skills: [], capabilities: [], instruction: '', outputRequirement: '', acceptanceRules: [] } : {}),
          });
        }}><option value="task">Agent 节点</option><option value="checkpoint">人工复核</option></select></label>}
        {editor.type === 'checkpoint' ? <p className="muted">流程走到这里会停住等人确认。创建时只需命名；批准、重做或交给下游，在复核弹出时操作。</p> : null}
        {editor.type === 'start' ? <label>需求描述<textarea value={editor.requirement} onChange={(event) => setEditor({ ...editor, requirement: event.target.value })} placeholder="写下这次要分析的需求" /></label> : null}
        {editor.type === 'start' ? <label>需求文件<input type="file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void onUploadFile(file).then(() => onListFiles()).then((result) => { setInputFiles(result.files); setInputDirectory(result.directory); }).catch((cause) => setNodeError(cause instanceof Error ? cause.message : '上传失败')); }} /></label> : null}
        {editor.type === 'start' && inputDirectory ? <p className="muted">文件目录：{inputDirectory}</p> : null}
        {editor.type === 'start' && inputFiles.length ? <div className="picked-list">{inputFiles.map((file) => <div className="picked-item" key={file.name}><span>{file.name}</span><button type="button" onClick={() => void onDeleteFile(file.name).then(() => onListFiles()).then((result) => setInputFiles(result.files)).catch((cause) => setNodeError(cause instanceof Error ? cause.message : '删除失败'))}>移除</button></div>)}</div> : null}
        {editor.type === 'task' ? <CapabilityPicker label="能力" hint="从下拉里选择，至少一项。协作时按这些能力理解这个 Agent。" options={capabilities} selected={editor.capabilities} onChange={(next) => setEditor({ ...editor, capabilities: next })} /> : null}
        {editor.type === 'task' ? <SkillPicker label="Skill" hint="可选。例如勾选「网络访问」后，这个节点执行时可以搜索网页并抓取 URL。目录在「Skill 管理」维护。" options={skills} selected={editor.skills} onChange={(next) => setEditor({ ...editor, skills: next })} /> : null}
        {editor.type === 'task' ? <>
          <label>Provider<select value={editor.providerId} onChange={(event) => {
            const providerId = event.target.value;
            const stillValid = models.some((item) => String(item.id) === editor.modelId && String(item.providerId) === providerId);
            setEditor({ ...editor, providerId, modelId: providerId && !stillValid ? '' : editor.modelId });
          }}><option value="">请选择 Provider</option>{providers.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.type}</option>)}</select><small className="field-hint">先选厂商，Model 会按厂商过滤。</small></label>
          <label>Model<select value={editor.modelId} onChange={(event) => {
            const modelId = event.target.value;
            const model = models.find((item) => String(item.id) === modelId);
            setEditor({ ...editor, modelId, providerId: model ? String(model.providerId) : editor.providerId });
          }}><option value="">请选择 Model</option>{models.filter((item) => !editor.providerId || String(item.providerId) === editor.providerId).map((item) => <option value={item.id} key={item.id}>{item.displayName} · {providers.find((provider) => provider.id === item.providerId)?.name ?? '未知厂商'}</option>)}</select><small className="field-hint">必选。执行和对话时会把这个模型传给 Pi。</small></label>
          {!providers.length || !models.length ? <p className="alert">还没有可用模型。请先到「模型管理」创建 Provider 和 Model。</p> : null}
        </> : null}
        {editor.type === 'task' ? <label>任务说明<textarea value={editor.instruction} onChange={(event) => setEditor({ ...editor, instruction: event.target.value })} placeholder="这个 Agent 每次要做的事，例如根据上游 Agent 的产出整理范围" /></label> : null}
        {editor.type === 'task' ? <label>产出要求<textarea value={editor.outputRequirement} onChange={(event) => setEditor({ ...editor, outputRequirement: event.target.value })} placeholder="必须交出来的文件和结构，例如写成《需求分析文档》，包含背景、用户、功能范围、不做的事、验收标准" /></label> : null}
        {editor.type === 'task' ? <div className="rule-list"><span>上游产物校验规则</span><small className="field-hint">点加号添加一条。每一条都是不合格条件，满足任意一条就不合格。一条都不加则视为合格。不合格会退回给出这份内容的节点。</small>{editor.acceptanceRules.map((rule) => <div className="rule-row" key={rule.id}><input value={rule.text} onChange={(event) => setEditor({ ...editor, acceptanceRules: editor.acceptanceRules.map((item) => item.id === rule.id ? { ...item, text: event.target.value } : item) })} placeholder="例如缺少需求背景说明" /><button type="button" onClick={() => setEditor({ ...editor, acceptanceRules: editor.acceptanceRules.filter((item) => item.id !== rule.id) })}>移除</button></div>)}<button type="button" className="rule-add" onClick={() => setEditor({ ...editor, acceptanceRules: [...editor.acceptanceRules, { id: `new-${Date.now()}`, text: '' }] })}>+</button></div> : null}
        {editor.type === 'task' ? <label>最多退回次数<input type="number" min={1} value={editor.maxRedos} onChange={(event) => setEditor({ ...editor, maxRedos: event.target.value })} /><small className="field-hint">不合格时最多自动退回这么多次；达到后会停下来让你确认。填 1 表示只自动退回 1 次。默认 3。改完后请保存节点再执行。</small></label> : null}
        {editor.type === 'checkpoint' ? <label>询问（可选）<input value={editor.question} onChange={(event) => setEditor({ ...editor, question: event.target.value })} placeholder="例如是否批准这次改动？" /></label> : null}
        <div className="run-controls"><button type="submit">保存</button><button type="button" onClick={() => setEditor(null)}>取消</button></div>
      </form>
    </div> : null}
    {summaryOpen ? <div className="node-dialog-backdrop" onMouseDown={() => { setSummaryOpen(false); setSummaryError(''); }}>
      <div className="node-dialog panel" role="dialog" aria-modal="true" aria-label="流程结果" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-head"><h3>流程进度和产物</h3><button type="button" onClick={() => { setSummaryOpen(false); setSummaryError(''); }}>关闭</button></div>
        {summaryError ? <p className="alert">{summaryError}</p> : null}
        {summaryNodes === null && !summaryError ? <p className="muted">正在读取流程结果。</p> : null}
        {summaryNodes && summaryNodes.length === 0 && !summaryError ? <p className="muted">还没有执行记录。</p> : null}
        {(summaryNodes ?? []).map((item) => <div className="summary-node" key={item.key}>
          <strong>{item.name}</strong> <em className={`node-status ${item.status}`}>{NODE_STATUS[item.status] ?? item.status}</em>
          {item.error ? <p className="node-failure" title={item.error}>失败原因：{item.error}</p> : null}
          {item.files.length ? <div className="summary-files">{item.files.map((file) => <button type="button" key={file.path} onClick={() => void onReadFile(file.path).then((result) => {
            if (result.binary) { void onOpenDeliverable(file.path); return; }
            setFileView({ name: result.name, text: result.text ?? '', path: result.path || file.path });
          }).catch((cause) => setSummaryError(cause instanceof Error ? cause.message : '文件打开失败'))}>{file.name}</button>)}</div> : <p className="muted">没有产物文件</p>}
        </div>)}
      </div>
    </div> : null}
    {fileView ? <div className="node-dialog-backdrop" onMouseDown={() => setFileView(null)}>
      <div className="node-dialog panel" role="dialog" aria-modal="true" aria-label={fileView.name} onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-head">
          <h3>{fileView.name}</h3>
          <div className="run-controls">
            {fileView.path ? <button type="button" title="在访达中打开所在目录" onClick={() => void onOpenDeliverable(fileView.path).catch((cause) => setSummaryError(cause instanceof Error ? cause.message : '目录打开失败'))}>打开所在目录</button> : null}
            <button type="button" onClick={() => setFileView(null)}>关闭</button>
          </div>
        </div>
        <pre className="prose">{fileView.text}</pre>
      </div>
    </div> : null}
    {acceptanceView ? (() => {
      const pending = decisionsByNode.get(acceptanceView.nodeKey) ?? null;
      const acceptanceDecision = pending && decisionKind(pending) === 'acceptance' ? pending : null;
      const returns = (acceptanceView.check.history ?? []).filter((item) => item.verdict === 'reject');
      return <div className="node-dialog-backdrop" onMouseDown={() => setAcceptanceView(null)}>
        <div className="node-dialog panel" role="dialog" aria-modal="true" aria-label="校验结果" onMouseDown={(event) => event.stopPropagation()}>
          <div className="panel-head"><h3>校验结果 · {acceptanceView.check.label}</h3><button type="button" onClick={() => setAcceptanceView(null)}>关闭</button></div>
          {returns.length ? <div className="acceptance-history">
            <h4>退回记录 · {returns.length} 次</h4>
            {returns.map((item, index) => <article className="acceptance-history-item" key={`${item.at ?? index}-${index}`}>
              <header><span>第 {index + 1} 次退回</span>{item.at ? <time>{beijingClock(item.at)}</time> : null}</header>
              <p className="prose">{item.detail}</p>
            </article>)}
          </div> : null}
          <div className="acceptance-current">
            <h4>{acceptanceDecision ? '本次判断' : returns.length ? '最终结果' : '判断依据'}</h4>
            <p className="prose">{acceptanceView.check.detail || acceptanceDecision?.question || '（没有写出具体原因）'}</p>
          </div>
          {acceptanceDecision ? <div className="decision-detail">
            <h4>待处理 · 确认后继续</h4>
            <p className="decision-question">{acceptanceDecision.question}</p>
            <textarea value={decisionNotes?.[acceptanceDecision.id] ?? ''} onChange={(event) => onDecisionNote?.(acceptanceDecision.id, event.target.value)} placeholder="补充说明（可选）" />
            <div className="decision-actions">
              <button type="button" className="decision-primary" onClick={() => { onResolveDecision?.(acceptanceDecision.id, 'approve'); setAcceptanceView(null); setDecisionView(null); }}>批准继续</button>
              <button type="button" onClick={() => { onResolveDecision?.(acceptanceDecision.id, 'return'); setAcceptanceView(null); setDecisionView(null); }}>退回重做</button>
              <button type="button" className="danger" onClick={() => { onResolveDecision?.(acceptanceDecision.id, 'reject'); setAcceptanceView(null); setDecisionView(null); }}>拒绝</button>
            </div>
          </div> : null}
        </div>
      </div>;
    })() : null}
    {loopOpen ? <div className="node-dialog-backdrop" onMouseDown={() => setLoopOpen(false)}>
      <form className="node-dialog panel form" role="dialog" aria-modal="true" aria-label="设置循环" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => {
        event.preventDefault();
        const maxIterations = Number(loopMax);
        if (!Number.isInteger(maxIterations) || maxIterations < 1) { setBanner('循环次数至少为 1'); return; }
        const chosen = nodes.filter((node) => loopNodes.includes(node.key));
        if (loopNodes.length === 0) { onLoops([]); void onPersist(nodes, edges, false, []); setLoopOpen(false); return; }
        if (!chosen.some((node) => node.type === 'task') || !chosen.some((node) => node.type === 'checkpoint')) { setBanner('循环里至少要有一个 Agent 节点和一个人工复核'); return; }
        const nextLoops = [{ key: loops[0]?.key ?? `loop-${Date.now()}`, nodeKeys: loopNodes, maxIterations }];
        onLoops(nextLoops);
        void onPersist(nodes, edges, false, nextLoops).then((saved) => { if (saved) setLoopOpen(false); });
      }}>
        <div className="panel-head"><h3>循环</h3><button type="button" onClick={() => setLoopOpen(false)}>关闭</button></div>
        <p className="muted">勾选要重复的 Agent 和人工复核。通过就继续交给后面的 Agent，再做一次就重跑这一段。次数用尽会停下。开始和结束不能放进循环。Agent 在自己的目录里工作。</p>
        <label>循环次数<input type="number" min="1" value={loopMax} onChange={(event) => setLoopMax(event.target.value)} /></label>
        {nodes.filter((node) => node.type === 'task' || node.type === 'checkpoint').map((node) => <label key={node.key}><input type="checkbox" checked={loopNodes.includes(node.key)} onChange={(event) => setLoopNodes(event.target.checked ? [...loopNodes, node.key] : loopNodes.filter((key) => key !== node.key))} /> {node.name}</label>)}
        <div className="run-controls"><button type="submit">保存</button><button type="button" onClick={() => { onLoops([]); void onPersist(nodes, edges, false, []); setLoopOpen(false); }}>清除循环</button></div>
      </form>
    </div> : null}
    {logOpen ? <section className="board-log" style={{ height: logHeight }}>
      <div className="log-resize" role="separator" aria-orientation="horizontal" aria-label="调整日志高度" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} />
      <div className="panel-head">
        <h3>执行日志{runStatus ? ` · ${runStatus}` : ''}</h3>
        <div className="run-controls">
          <button type="button" onClick={() => {
            const latest = events.reduce((max, event) => Math.max(max, event.id), logFloorId);
            setLogFloorId(latest);
          }}>清空</button>
          <button type="button" onClick={() => setLogOpen(false)}>收起</button>
        </div>
      </div>
      <LogText events={events.filter((event) => event.id > logFloorId)} />
    </section> : null}
  </div>;
}
