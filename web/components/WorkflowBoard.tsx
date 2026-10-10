'use client';

import { CSSProperties, FormEvent, memo, PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { beijingClock } from '../lib/beijing-time';

type Id = number;
export type BoardNode = { key: string; name: string; type: 'task' | 'checkpoint' | 'start' | 'end'; capabilities: string[]; question: string; instruction: string; outputRequirement: string; acceptanceRule: string; maxRedos: number; requirement: string; x: number; y: number; w: number; h: number };
export type BoardLoop = { key: string; nodeKeys: string[]; maxIterations: number };
export type BoardEdge = { source: string; target: string };
export type NodeCheck = { verdict: 'pass' | 'reject' | 'unclear'; label: string; detail: string };
export type SummaryFile = { name: string; path: string };
export type SummaryNode = { key: string; name: string; status: string; files: SummaryFile[] };
type CapabilityRow = { id: Id; key: string; name: string; description?: string | null };
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
    return {
      key: typeof config.key === 'string' ? config.key : `node-${node.id}`,
      name: node.name,
      type: (node.nodeType === 'checkpoint' || node.nodeType === 'start' || node.nodeType === 'end' ? node.nodeType : 'task') as BoardNode['type'],
      capabilities,
      question: typeof config.question === 'string' ? config.question : '',
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

function CapabilityPicker({ label, hint, options, selected, onChange }: { label: string; hint: string; options: CapabilityRow[]; selected: string[]; onChange: (next: string[]) => void }) {
  const chosen = selected.map((key) => options.find((item) => item.key.toLowerCase() === key.toLowerCase()) ?? { key, name: key });
  const remaining = options.filter((item) => !selected.some((key) => key.toLowerCase() === item.key));
  return <div className="capability-picker">
    <label>{label}<select value="" onChange={(event) => { const key = event.target.value; if (key) onChange([...selected, key]); }}>
      <option value="">{options.length ? (remaining.length ? '请选择能力' : '目录里的能力都已选上') : '请先选择项目'}</option>
      {remaining.map((item) => <option value={item.key} key={item.key}>{item.name} · {item.key}</option>)}
    </select><small className="field-hint">{hint}</small></label>
    {chosen.length ? <div className="picked-list">{chosen.map((item) => <div className="picked-item" key={item.key}><span>{item.name}</span><small>{item.key}</small><button type="button" onClick={() => onChange(selected.filter((key) => key.toLowerCase() !== item.key.toLowerCase()))}>移除</button></div>)}</div> : null}
  </div>;
}

const NODE_STATUS: Record<string, string> = {
  pending: '待处理', blocked: '等待上游', running: '进行中', paused: '已暂停',
  awaiting_decision: '等待确认', completed: '已完成', failed: '失败', cancelled: '已停止',
};

type BoardDecision = { id: number; question: string; contextJson?: unknown };

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

const rememberedLogLines = new Map<number, string>();
const LOG_LIMIT = 400;

function logLine(event: EventRow) {
  const payload = event.payload ?? event.payloadJson;
  let detail = '';
  if (typeof payload === 'string') detail = payload.replace(/\s+/g, ' ').trim();
  else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === 'string') detail = record.error;
    else if (typeof record.message === 'string') detail = record.message;
    else detail = JSON.stringify(payload);
  }
  const when = event.occurredAt ?? event.createdAt;
  const time = beijingClock(when);
  return `${time}  ${event.type}${detail ? `  ${detail.slice(0, 240)}` : ''}`;
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
  const text = useMemo(() => {
    if (!events.length) return '';
    const start = Math.max(0, events.length - LOG_LIMIT);
    const body = events.slice(start).map(rememberedLogLine).join('\n');
    return start > 0 ? `较早的 ${start} 条已收起\n${body}` : body;
  }, [events]);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return <pre className="log-view" ref={ref}>{text || '点击执行后，过程会显示在这里。每个 Workflow 只有一条 Run。'}</pre>;
});

function ChatComposer({ placeholder, onSend, busy = false }: { placeholder: string; onSend: (text: string) => void | boolean | Promise<boolean>; busy?: boolean }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
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
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <label className="sr-only" htmlFor="node-chat-input">指导</label>
    <textarea id="node-chat-input" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return; event.preventDefault(); submit(); }} placeholder={locked ? 'Agent 正在回复…' : placeholder} disabled={locked} />
    <button type="submit" disabled={locked}>{sending || busy ? '回复中' : '发送'}</button>
  </form>;
}

type RuleDraft = { id: string; text: string };
type NodeEditor = { key: string | null; name: string; type: BoardNode['type']; capabilities: string[]; question: string; instruction: string; outputRequirement: string; acceptanceRules: RuleDraft[]; maxRedos: string; requirement: string; anchorKey: string | null };

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

export function WorkflowBoard({
  mode, name, version, nodes, edges, loops, capabilities, events, progress, checks, deliverables, directory, runStatus, runStatusCode,
  onClose, onName, onVersion, onNodes, onEdges, onLoops, onPersist, onPublish, onExecute, onStop, onOpenDirectory, onOpenDeliverable, onLoadSummary, onReadFile, onListFiles, onUploadFile, onDeleteFile,
  decisions, decisionNotes, onDecisionNote, onResolveDecision,
  chatNode, chatMessages, chatError, onOpenChat, onCloseChat, onSendChat,
}: {
  mode: 'create' | 'view';
  name: string;
  version: string;
  nodes: BoardNode[];
  edges: BoardEdge[];
  loops: BoardLoop[];
  capabilities: CapabilityRow[];
  events: EventRow[];
  progress: Record<string, string>;
  checks: Record<string, NodeCheck>;
  deliverables: Record<string, string>;
  directory: string;
  runStatus?: string;
  runStatusCode?: string;
  onClose: () => void;
  onName: (value: string) => void;
  onVersion: (value: string) => void;
  onNodes: (nodes: BoardNode[]) => void;
  onEdges: (edges: BoardEdge[]) => void;
  onLoops: (loops: BoardLoop[]) => void;
  onPersist: (nodes: BoardNode[], edges: BoardEdge[], silent?: boolean, loops?: BoardLoop[]) => Promise<boolean>;
  onPublish: () => void;
  onExecute: () => void;
  onStop: () => Promise<boolean>;
  decisions?: BoardDecision[];
  decisionNotes?: Record<number, string>;
  onDecisionNote?: (id: number, text: string) => void;
  onResolveDecision?: (id: number, action: 'approve' | 'request_changes' | 'reject' | 'override' | 'replan' | 'repeat') => void;
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
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: string; dx: number; dy: number; x: number; y: number; moved: boolean } | null>(null);
  const sizeRef = useRef<{ key: string; x: number; y: number; w: number; h: number; moved: boolean } | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const [chatFold, setChatFold] = useState(0);
  function sendChat(text: string) {
    if (text.trim()) setChatFold((value) => value + 1);
    return onSendChat(text);
  }
  const linkRef = useRef<string | null>(null);
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const paneRef = useRef<{ startX: number; startW: number } | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(nodes[0]?.key ?? null);
  const [editor, setEditor] = useState<NodeEditor | null>(null);
  const [nodeError, setNodeError] = useState('');
  const [inputFiles, setInputFiles] = useState<InputFile[]>([]);
  const [inputDirectory, setInputDirectory] = useState('');
  const [loopOpen, setLoopOpen] = useState(false);
  const [loopNodes, setLoopNodes] = useState<string[]>([]);
  const [loopMax, setLoopMax] = useState('1');
  const [logHeight, setLogHeight] = useState(220);
  const [chatWidth, setChatWidth] = useState(340);
  const [banner, setBanner] = useState('');
  const [acceptanceView, setAcceptanceView] = useState<NodeCheck | null>(null);
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

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [chatMessages, chatNode?.key]);
  useEffect(() => { if (!running) setBanner(''); }, [running]);
  const decisionsByNode = useMemo(() => {
    const map = new Map<string, BoardDecision>();
    for (const item of decisions ?? []) {
      const key = decisionNodeKey(item);
      if (key && !map.has(key)) map.set(key, item);
    }
    return map;
  }, [decisions]);
  const activeDecision = decisions?.find((item) => item.id === decisionView) ?? null;
  useEffect(() => {
    const live = new Set((decisions ?? []).map((item) => item.id));
    for (const id of [...seenDecisions.current]) if (!live.has(id)) seenDecisions.current.delete(id);
    if (decisionView != null && !live.has(decisionView)) setDecisionView(null);
    for (const item of decisions ?? []) {
      if (seenDecisions.current.has(item.id)) continue;
      seenDecisions.current.add(item.id);
      setDecisionView(item.id);
      const key = decisionNodeKey(item);
      if (key) setSelected(key);
      break;
    }
  }, [decisions, decisionView]);
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
    setEditor({ key: null, name: '', type: 'task', capabilities: [], question: '', instruction: '', outputRequirement: '', acceptanceRules: [], maxRedos: '3', requirement: '', anchorKey: anchor?.key ?? null });
  }
  function openEdit(node: BoardNode) {
    if (!guardEdit()) return;
    setNodeError('');
    setSelected(node.key);
    setEditor({ key: node.key, name: node.name, type: node.type, capabilities: [...node.capabilities], question: node.question, instruction: node.instruction, outputRequirement: node.outputRequirement, acceptanceRules: ruleDrafts(node.acceptanceRule), maxRedos: String(node.maxRedos || 3), requirement: node.requirement, anchorKey: null });
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
    if (!structural && !editor.capabilities.length) { setNodeError('请至少选择一项能力'); return; }
    const question = editor.question.trim();
    const instruction = editor.instruction.trim();
    const outputRequirement = structural ? '' : editor.outputRequirement.trim();
    const acceptanceRule = editor.type === 'task' ? editor.acceptanceRules.map((item) => item.text.trim()).filter(Boolean).join('\n') : '';
    const maxRedos = Number(editor.maxRedos);
    if (acceptanceRule && (!Number.isInteger(maxRedos) || maxRedos < 1)) { setNodeError('最多退回次数至少为 1'); return; }
    const requirement = editor.requirement;
    let nextNodes = nodes;
    let nextEdges = edges;
    let key = editor.key;
    const acceptance = { acceptanceRule, maxRedos: Number.isInteger(maxRedos) && maxRedos >= 1 ? maxRedos : 3 };
    if (key) {
      nextNodes = nodes.map((node) => node.key === key ? { ...node, name, type: editor.type, capabilities: structural ? [] : editor.capabilities, question, instruction, outputRequirement, ...acceptance, requirement } : node);
    } else {
      key = `node-${Date.now()}`;
      const anchor = editor.anchorKey ? nodes.find((node) => node.key === editor.anchorKey) : undefined;
      const position = anchor ? placeNext(anchor) : { x: 80 + (nodes.length % 4) * 40, y: 80 + (nodes.length % 3) * 36 };
      nextNodes = [...nodes, { key, name, type: editor.type, capabilities: editor.capabilities, question, instruction, outputRequirement, ...acceptance, requirement, ...position, w: NODE_W, h: NODE_H }];
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
      <label>版本<input value={version} onChange={(event) => onVersion(event.target.value)} placeholder="v1" readOnly={!canEdit} /></label>
      <label className="board-root">主目录<button type="button" title={directory || '打开主目录'} onClick={() => void onOpenDirectory()}>{directory || '打开主目录'}</button></label>
      <div className="run-controls">
        {editable ? <button type="button" onClick={onPublish}>发布 Workflow</button> : null}
        <button type="button" onClick={onClose}>返回列表</button>
      </div>
    </header>
    <div className={`board-body${chatNode ? ' with-chat' : ''}`} style={{ '--chat-width': `${chatWidth}px` } as CSSProperties}>
      <div className="board-stage">
        <div className="panel-head">
          {running ? <h3>运行中可以拖动 Agent，点节点可以对话</h3> : <span />}
          <div className="run-controls">
            <button type="button" onClick={() => openCreate()}>添加 Agent 节点</button>
            <button type="button" onClick={() => { if (!guardEdit()) return; const current = loops[0]; setLoopNodes(current?.nodeKeys ?? []); setLoopMax(String(current?.maxIterations ?? 1)); setLoopOpen(true); }}>循环</button>
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
            const pending = decisionsByNode.get(node.key);
            const size = nodeBox(node);
            return <article className={`board-node ${node.type} ${selected === node.key ? 'selected' : ''} ${nodeStatus ? `status-${nodeStatus}` : ''} ${pending ? 'needs-decision' : ''}`} key={node.key} style={{ left: node.x, top: node.y, width: size.w, height: size.h }} onPointerDown={(event) => startDrag(node, event)}>
            <button type="button" className="port in" data-port="in" data-node={node.key} aria-label="连入" />
            <div className="node-menu-wrap">
              <button type="button" className="node-more" data-action="menu" aria-label="更多" aria-expanded={nodeMenu === node.key} title="更多" onPointerDown={(event) => event.stopPropagation()} onClick={() => setNodeMenu((current) => current === node.key ? null : node.key)}>⋯</button>
              {nodeMenu === node.key ? <div className="node-menu" role="menu" data-action="menu">
                <button type="button" role="menuitem" data-action="menu" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setNodeMenu(null); openEdit(node); }}>编辑</button>
                {node.type === 'start' || node.type === 'end' ? null : <button type="button" role="menuitem" data-action="menu" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setNodeMenu(null); const folder = deliverables[node.key] || ''; if (!folder) { setBanner('这个节点还没有交付物'); return; } void onOpenDeliverable(folder); }}>交付物</button>}
                {node.type === 'start' || node.type === 'end' ? null : <button type="button" role="menuitem" className="danger" data-action="menu" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setNodeMenu(null); void removeNode(node.key); }}>删除</button>}
              </div> : null}
            </div>
            {statusLabel ? <em className={`node-status ${nodeStatus}`}>{statusLabel}</em> : null}
            {checks[node.key] ? <button type="button" className={`acceptance-mark ${checks[node.key].verdict}`} data-action="acceptance" title="查看判断依据" onClick={() => setAcceptanceView(checks[node.key])}>{checks[node.key].label}</button> : null}
            {pending ? <button type="button" className="decision-mark" data-action="decision" title="在此节点确认" onPointerDown={(event) => event.stopPropagation()} onClick={() => setDecisionView(pending.id)}>待确认</button> : null}
            <strong>{node.name || (node.type === 'task' ? '未命名 Agent' : '未命名')}</strong>
            <small>{node.type === 'end' ? '点此查看流程进度和产物' : node.type === 'task' ? <em className="agent-mark">Agent 节点</em> : roleTitle(node.type)}{node.type === 'end' ? '' : loops.some((loop) => loop.nodeKeys.includes(node.key)) ? ' · 循环' : ''}{node.type === 'task' && node.acceptanceRule.trim() ? ' · 校验上游' : ''}{node.type !== 'end' && node.capabilities.length ? ` · ${capabilityText(node.capabilities)}` : ''}</small>
            <button type="button" className="port out" data-port="out" data-node={node.key} aria-label="连出" onPointerDown={(event) => startLink(node, event)} />
            <button type="button" className="node-resize" data-action="resize" aria-label="调整节点大小" title="拖动调整大小" onPointerDown={(event) => startNodeResize(node, event)} />
            <button type="button" className="node-add" data-action="add" aria-label="新建下一个 Agent 节点" onPointerDown={(event) => event.stopPropagation()} onClick={() => openCreate(node)} />
          </article>;
          })}
          {activeDecision ? (() => {
            const kind = decisionKind(activeDecision);
            const nodeKey = decisionNodeKey(activeDecision);
            const host = nodes.find((node) => node.key === nodeKey);
            if (!host) return null;
            const size = nodeBox(host);
            const acceptance = kind === 'acceptance';
            const loop = kind === 'loop';
            return <div
              className="node-decision-pop"
              data-action="decision"
              style={{ left: host.x, top: host.y + size.h + 8, width: Math.max(size.w, 300) }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="node-decision-head">
                <strong>确认</strong>
                <button type="button" onClick={() => setDecisionView(null)}>收起</button>
              </div>
              <p className="decision-question">{activeDecision.question}</p>
              <textarea value={decisionNotes?.[activeDecision.id] ?? ''} onChange={(event) => onDecisionNote?.(activeDecision.id, event.target.value)} placeholder={acceptance ? '写下这次的说明，必填' : '写下这次复核的说明，必填'} />
              <div className="decision-actions">
                <button type="button" className="decision-primary" onClick={() => onResolveDecision?.(activeDecision.id, 'approve')}>{acceptance ? '批准继续' : '批准'}</button>
                {acceptance || loop ? <button type="button" onClick={() => onResolveDecision?.(activeDecision.id, 'repeat')}>再做一次</button> : null}
                {acceptance ? null : <button type="button" onClick={() => onResolveDecision?.(activeDecision.id, 'request_changes')}>要求修改</button>}
                {acceptance ? null : <button type="button" onClick={() => onResolveDecision?.(activeDecision.id, 'replan')}>重新规划</button>}
                {acceptance ? null : <button type="button" className="danger" onClick={() => onResolveDecision?.(activeDecision.id, 'reject')}>拒绝</button>}
                {acceptance ? null : <button type="button" onClick={() => onResolveDecision?.(activeDecision.id, 'override')}>Override</button>}
              </div>
            </div>;
          })() : null}
        </div>
        </div>
      </div>
      {chatNode ? <div className="pane-resize" role="separator" aria-orientation="vertical" aria-label="调整对话宽度" onPointerDown={startPaneResize} onPointerMove={movePaneResize} onPointerUp={endPaneResize} onPointerCancel={endPaneResize} /> : null}
      {chatNode ? <aside className="node-chat" aria-label={`${chatNode.name}的对话`}>
        <div className="panel-head"><h3>{chatNode.name || (chatNode.type === 'task' ? '未命名 Agent' : '未命名')}</h3><button type="button" onClick={onCloseChat}>关闭</button></div>
        <p className="muted">{chatNode.type === 'checkpoint' ? '给这次人工复核补充指导。这些话会留在复核说明里。' : running ? '执行还在进行，也可以直接对话。这次执行不会中途改口，新的指导留给它之后的执行。' : '和这个 Agent 沟通。指导会留下来，它之后和下游 Agent 协作时也会带上。'}</p>
        {chatError ? <p className="alert">{chatError}</p> : null}
        <div className="node-chat-log" ref={chatRef}>
          {chatMessages.length ? chatMessages.map((message) => <ChatTurn message={message} fold={chatFold} key={message.id} />) : <p className="muted">{chatNode.type === 'checkpoint' ? '还没有指导。写下这次复核要特别看什么。' : '还没有对话。写下你希望这个 Agent 怎么做。'}</p>}
        </div>
        <ChatComposer key={chatNode.key} busy={chatMessages.some((item) => item.status === 'streaming' || item.status === 'pending')} placeholder={chatNode.type === 'checkpoint' ? '告诉这次复核要看什么，回车发送' : '指导这个 Agent，回车发送'} onSend={sendChat} />
      </aside> : null}
    </div>
    {editor ? <div className="node-dialog-backdrop" onMouseDown={() => setEditor(null)}>
      <form className="node-dialog panel form" role="dialog" aria-modal="true" aria-label={editor.type === 'task' ? (editor.key ? '编辑 Agent 节点' : '新建 Agent 节点') : roleTitle(editor.type)} onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void saveNode(event)}>
        <div className="panel-head"><h3>{editor.type === 'task' ? (editor.key ? '编辑 Agent 节点' : '新建 Agent 节点') : editor.type === 'checkpoint' ? (editor.key ? '编辑人工复核' : '新建人工复核') : roleTitle(editor.type)}</h3><button type="button" onClick={() => setEditor(null)}>关闭</button></div>
        {nodeError ? <p className="alert">{nodeError}</p> : null}
        <label>名称<input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder={editor.type === 'task' ? '这个 Agent 在协作里的名称' : '面板上显示的名称'} /></label>
        {editor.type === 'start' || editor.type === 'end' ? <p className="muted">{editor.type === 'start' ? '开始负责把这次的需求描述和文件交给后面的 Agent，本身不调用模型。' : '结束汇总整条流程的进度，并列出每个节点的产物文件。点结束节点可以查看，点文件名打开内容。本身不调用模型。'}</p> : <label>类型<select value={editor.type} onChange={(event) => setEditor({ ...editor, type: event.target.value === 'checkpoint' ? 'checkpoint' : 'task' })}><option value="task">Agent 节点</option><option value="checkpoint">人工复核</option></select></label>}
        {editor.type === 'start' ? <label>需求描述<textarea value={editor.requirement} onChange={(event) => setEditor({ ...editor, requirement: event.target.value })} placeholder="写下这次要分析的需求" /></label> : null}
        {editor.type === 'start' ? <label>需求文件<input type="file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void onUploadFile(file).then(() => onListFiles()).then((result) => { setInputFiles(result.files); setInputDirectory(result.directory); }).catch((cause) => setNodeError(cause instanceof Error ? cause.message : '上传失败')); }} /></label> : null}
        {editor.type === 'start' && inputDirectory ? <p className="muted">文件目录：{inputDirectory}</p> : null}
        {editor.type === 'start' && inputFiles.length ? <div className="picked-list">{inputFiles.map((file) => <div className="picked-item" key={file.name}><span>{file.name}</span><button type="button" onClick={() => void onDeleteFile(file.name).then(() => onListFiles()).then((result) => setInputFiles(result.files)).catch((cause) => setNodeError(cause instanceof Error ? cause.message : '删除失败'))}>移除</button></div>)}</div> : null}
        {editor.type === 'task' || editor.type === 'checkpoint' ? <CapabilityPicker label="能力" hint={editor.type === 'checkpoint' ? '从下拉里选择，至少一项。复核时按这些能力看上游 Agent 的产出。' : '从下拉里选择，至少一项。协作时按这些能力理解这个 Agent。'} options={capabilities} selected={editor.capabilities} onChange={(next) => setEditor({ ...editor, capabilities: next })} /> : null}
        {editor.type === 'task' || editor.type === 'checkpoint' ? <label>任务说明<textarea value={editor.instruction} onChange={(event) => setEditor({ ...editor, instruction: event.target.value })} placeholder={editor.type === 'checkpoint' ? '这次复核要确认的事' : '这个 Agent 每次要做的事，例如根据上游 Agent 的产出整理范围'} /></label> : null}
        {editor.type === 'task' || editor.type === 'checkpoint' ? <label>产出要求<textarea value={editor.outputRequirement} onChange={(event) => setEditor({ ...editor, outputRequirement: event.target.value })} placeholder={editor.type === 'checkpoint' ? '通过前要看到的产出，例如需求分析文档已包含验收标准' : '必须交出来的文件和结构，例如写成《需求分析文档》，包含背景、用户、功能范围、不做的事、验收标准'} /></label> : null}
        {editor.type === 'task' ? <div className="rule-list"><span>上游产物校验规则</span><small className="field-hint">点加号添加一条。每一条都是不合格条件，满足任意一条就不合格。一条都不加则视为合格。不合格会退回给出这份内容的节点，不用另配循环。</small>{editor.acceptanceRules.map((rule) => <div className="rule-row" key={rule.id}><input value={rule.text} onChange={(event) => setEditor({ ...editor, acceptanceRules: editor.acceptanceRules.map((item) => item.id === rule.id ? { ...item, text: event.target.value } : item) })} placeholder="例如缺少需求背景说明" /><button type="button" onClick={() => setEditor({ ...editor, acceptanceRules: editor.acceptanceRules.filter((item) => item.id !== rule.id) })}>移除</button></div>)}<button type="button" className="rule-add" onClick={() => setEditor({ ...editor, acceptanceRules: [...editor.acceptanceRules, { id: `new-${Date.now()}`, text: '' }] })}>+</button></div> : null}
        {editor.type === 'task' ? <label>最多退回次数<input type="number" min={1} value={editor.maxRedos} onChange={(event) => setEditor({ ...editor, maxRedos: event.target.value })} /><small className="field-hint">只有填写了上游产物校验规则才会计数，默认 3 次。</small></label> : null}
        {editor.type === 'checkpoint' ? <label>询问<input value={editor.question} onChange={(event) => setEditor({ ...editor, question: event.target.value })} placeholder="例如是否批准这次改动？" /></label> : null}
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
    {acceptanceView ? <div className="node-dialog-backdrop" onMouseDown={() => setAcceptanceView(null)}>
      <div className="node-dialog panel" role="dialog" aria-modal="true" aria-label="校验结果" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-head"><h3>校验结果 · {acceptanceView.label}</h3><button type="button" onClick={() => setAcceptanceView(null)}>关闭</button></div>
        <p className="prose">{acceptanceView.detail}</p>
      </div>
    </div> : null}
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
    <section className="board-log" style={{ height: logHeight }}>
      <div className="log-resize" role="separator" aria-orientation="horizontal" aria-label="调整日志高度" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} />
      <div className="panel-head">
        <h3>执行日志{runStatus ? ` · ${runStatus}` : ''}</h3>
        <div className="run-controls">
          <button type="button" onClick={onExecute}>执行</button>
          <button type="button" onClick={() => void onStop()}>停止</button>
        </div>
      </div>
      <LogText events={events} />
    </section>
  </div>;
}
