'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { beijingDateTime } from '../lib/beijing-time';
import { useAutoDismiss } from '../lib/use-auto-dismiss';
import { WorkflowBoard, graphFromStored, type NodeCheck, type SummaryNode, type WorkflowVersionOption } from './WorkflowBoard';

type Id = number;
type Project = { id: Id; name: string; description?: string | null; createdAt?: string; workflowCount?: number };
type Provider = { id: Id; name: string; type: string; baseUrl?: string | null; apiKeySet?: boolean; apiKeyMasked?: string };
type Model = { id: Id; providerId: Id; name: string; displayName: string };
type CapabilityRow = { id: Id; key: string; name: string; description?: string | null; tenantId?: Id };
type SkillRow = { id: Id; key: string; name: string; description?: string | null; kind?: 'builtin' | 'custom'; toolsJson?: unknown; contentMd?: string | null; configJson?: unknown; tenantId?: Id };
type WorkflowNodeDraft = { key: string; name: string; type: 'task' | 'checkpoint' | 'start' | 'end'; capabilities: string[]; skills: string[]; modelId: number | null; question: string; instruction: string; outputRequirement: string; acceptanceRule: string; maxRedos: number; requirement: string; x: number; y: number; w: number; h: number };
type WorkflowLoop = { key: string; nodeKeys: string[]; maxIterations: number };
type Workflow = { id: Id; name: string; version: string; status: string; runStatus?: string | null; definitionJson?: unknown; projectId?: Id; projectName?: string; createdAt?: string; updatedAt?: string };
type Run = { id: Id; workflowId: Id; status: string; currentPlanVersion?: number; startedAt?: string; completedAt?: string; errorJson?: unknown };
type EventRow = { id: Id; type: string; payloadJson?: unknown; payload?: unknown; createdAt?: string; occurredAt?: string; workflowRunId?: Id; taskId?: Id | null };
type Center = { counts: Record<string, number>; recentEvents: EventRow[] };
type Decision = {
  id: Id;
  workflowRunId?: Id;
  checkpointId?: Id;
  question: string;
  decision?: string | null;
  action?: string | null;
  status: string;
  contextJson?: unknown;
  createdAt?: string;
  resolvedAt?: string | null;
};
type Checkpoint = { id: Id; workflowRunId: Id; title: string; instructions?: string; status: string; contextJson?: unknown };
type RunDetail = Run & { plans: AnyRow[]; tasks: AnyRow[]; sessions: AnyRow[]; checkpoints: Checkpoint[]; decisions: Decision[]; events: EventRow[] };
type AnyRow = Record<string, unknown> & { id: Id; status?: string; name?: string };
type View = 'overview' | 'models' | 'capabilities' | 'skills' | 'workflows' | 'settings';
type LoadState = 'loading' | 'ready' | 'error';
type TenantRow = { tenantId: number; name: string; slug?: string; role?: string };
type SystemSettings = {
  note?: string;
  pi: { command: string; status: 'ok' | 'error'; version?: string; message: string };
  mysql: { host: string; port: string; user: string; database: string; passwordSet: boolean; passwordMasked: string; status: 'ok' | 'error'; message: string; latencyMs?: number };
  redis: { host: string; port: string; passwordSet: boolean; passwordMasked: string; displayUrl?: string; status: 'ok' | 'error'; message: string; latencyMs?: number };
};

const API_URL = process.env.NEXT_PUBLIC_ORVIA_API_URL ?? 'http://127.0.0.1:4100';
const PATHS: Record<View, string> = {
  overview: '/', models: '/models', capabilities: '/capabilities', skills: '/skills', workflows: '/workflows', settings: '/settings',
};
let apiToken = '';
let apiTenantId: number | undefined;
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  if (apiTenantId) headers['x-orvia-tenant-id'] = String(apiTenantId);
  return headers;
}
function viewFromPath(pathname: string): View {
  const match = (Object.entries(PATHS) as [View, string][]).find(([, path]) => path !== '/' && pathname === path);
  return match?.[0] ?? 'overview';
}
const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: '⌂' }, { id: 'models', label: '模型管理', icon: '◎' },
  { id: 'capabilities', label: '能力', icon: '✦' },
  { id: 'skills', label: 'Skill 管理', icon: '⚡' },
  { id: 'workflows', label: 'Workflow Builder', icon: '◇' },
  { id: 'settings', label: '系统设置', icon: '⚙' },
];

async function request<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const response = await fetch(`${API_URL}${path}`, verb === 'GET' ? { cache: 'no-store', headers: authHeaders() } : {
    method: verb, headers: { 'content-type': 'application/json', ...authHeaders() }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { const data = await response.json() as { error?: string }; message = data.error ?? message; } catch { /* keep HTTP error */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
const list = <T,>(path: string) => request<{ data: T[] }>(path).then((result) => result.data);
const pretty = (value: unknown) => JSON.stringify(value ?? null, null, 2);
const date = (value?: string) => beijingDateTime(value);
const STATUS_LABELS: Record<string, string> = { pending: '待处理', running: '运行中', paused: '已暂停', awaiting_decision: '等待决策', completed: '已完成', failed: '失败', cancelled: '已停止', approved: '已批准', rejected: '已拒绝', changes_requested: '需修改', ok: '正常', error: '异常', draft: '草稿', published: '已发布', idle: '未运行' };
const statusText = (value: string) => STATUS_LABELS[value] ?? value;
function sameProgress(left: Record<string, string>, right: Record<string, string>) {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => left[key] === right[key]);
}
function continuationSummary(nodes: WorkflowNodeDraft[], edges: { source: string; target: string }[], tasks: AnyRow[] | undefined): string {
  if (nodes.length === 0) return '接着做会保留已经完成的 Agent，从停下的地方继续。';
  const latest = new Map<string, AnyRow>();
  for (const task of [...(tasks ?? [])].sort((left, right) => left.id - right.id)) {
    const input = task.inputJson;
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const key = typeof record.key === 'string' ? record.key : '';
    if (!key) continue;
    const previous = latest.get(key);
    // 与后端 resume 一致：同 key 时优先用非 cancelled 的任务，保留已完成进度
    if (!previous) latest.set(key, task);
    else if (previous.status === 'cancelled' && task.status !== 'cancelled') latest.set(key, task);
    else if (!(previous.status !== 'cancelled' && task.status === 'cancelled')) latest.set(key, task);
  }
  if (nodes.some((node) => !latest.has(node.key))) return 'Agent 已经改过，不能从暂停处继续。点「从头开始」会按现在的 Agent 再跑一遍。';
  if ([...latest.values()].some((task) => task.status === 'awaiting_decision')) {
    return '当前在等待确认。请先在面板上处理待确认，或选择从头开始。';
  }
  const frontier = nodes.filter((node) => {
    const task = latest.get(node.key);
    if (!task || task.status === 'completed') return false;
    const depends = edges.filter((edge) => edge.target === node.key).map((edge) => edge.source);
    return depends.every((source) => latest.get(source)?.status === 'completed');
  });
  if (frontier.length === 0) return '当前没有停下的 Agent，这次已经全部完成。点「从头开始」会再跑一遍。';
  return `接着做会从「${frontier.map((node) => node.name || '未命名 Agent').join('、')}」继续，已经完成的 Agent 保持原样。`;
}
function nodeProgress(tasks: AnyRow[] | undefined): Record<string, string> {
  const progress: Record<string, string> = {};
  for (const task of [...(tasks ?? [])].sort((left, right) => left.id - right.id)) {
    // 从头开始后旧任务会标成 cancelled，展示时忽略，避免旧进度/待确认残留
    if (!task.status || task.status === 'cancelled') continue;
    const input = task.inputJson;
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const key = typeof record.key === 'string' ? record.key : '';
    if (key) progress[key] = task.status;
  }
  return progress;
}
function taskFailureReason(output: unknown): string {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '';
  const record = output as Record<string, unknown>;
  for (const key of ['error', 'message']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
function nodeFailures(tasks: AnyRow[] | undefined): Record<string, string> {
  const failures: Record<string, string> = {};
  for (const task of [...(tasks ?? [])].sort((left, right) => left.id - right.id)) {
    if (!task.status || task.status === 'cancelled') continue;
    const input = task.inputJson;
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const key = typeof record.key === 'string' ? record.key : '';
    if (!key) continue;
    if (task.status === 'failed') {
      const reason = taskFailureReason(task.outputJson);
      if (reason) failures[key] = reason;
      else delete failures[key];
    } else {
      delete failures[key];
    }
  }
  return failures;
}
function sameFailures(left: Record<string, string>, right: Record<string, string>) {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
function acceptanceEntry(value: unknown): NodeCheck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const verdict = saved.verdict === 'pass' || saved.verdict === 'reject' || saved.verdict === 'unclear' ? saved.verdict : null;
  const label = typeof saved.label === 'string' ? saved.label : '';
  const detail = typeof saved.detail === 'string' ? saved.detail : '';
  if (!verdict || !label) return null;
  const at = typeof saved.at === 'string' ? saved.at : undefined;
  return { verdict, label, detail, ...(at ? { at } : {}) };
}
function acceptanceHistory(value: unknown): NonNullable<NodeCheck['history']> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = acceptanceEntry(item);
    return entry ? [entry] : [];
  });
}
function eventPayloadMessage(event: EventRow): string {
  const payload = event.payload ?? event.payloadJson;
  if (typeof payload === 'string') return payload.trim();
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message.trim();
  }
  return '';
}
function nodeChecks(tasks: AnyRow[] | undefined, events?: EventRow[]): Record<string, NodeCheck> {
  const checks: Record<string, NodeCheck> = {};
  const keyByTaskId = new Map<number, string>();
  const storedRejectKeys = new Set<string>();
  for (const task of [...(tasks ?? [])].sort((left, right) => left.id - right.id)) {
    const input = task.inputJson;
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const key = typeof record.key === 'string' ? record.key : '';
    if (key && typeof task.id === 'number') keyByTaskId.set(task.id, key);
    if (task.status === 'cancelled') {
      if (key) delete checks[key];
      continue;
    }
    if (!key) continue;
    const current = acceptanceEntry(record.acceptanceResult);
    const history = acceptanceHistory(record.acceptanceHistory);
    if (history.some((item) => item.verdict === 'reject')) storedRejectKeys.add(key);
    // 只有当前仍有 acceptanceResult 才显示合格/不合格角标；历史单独挂在 history，避免退回重做后只剩「不合格」却没有继续按钮
    if (current) checks[key] = { ...current, history: history.length ? history : current.verdict === 'reject' ? [current] : [] };
    else delete checks[key];
  }
  // 旧数据没有 acceptanceHistory 时，从退回事件补到已有结果的 history（不凭空造角标）
  for (const event of events ?? []) {
    if (event.type !== 'acceptance.returned') continue;
    const key = typeof event.taskId === 'number' ? keyByTaskId.get(event.taskId) : undefined;
    if (!key || storedRejectKeys.has(key)) continue;
    const check = checks[key];
    if (!check) continue;
    const message = eventPayloadMessage(event);
    if (!message) continue;
    const history = [...(check.history ?? [])];
    if (history.some((item) => item.detail === message)) continue;
    history.push({ verdict: 'reject', label: '不合格', detail: message, at: event.occurredAt ?? event.createdAt });
    checks[key] = { ...check, history };
  }
  return checks;
}
function taskRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** 人工复核任务上按上游节点保存的历史：checkpointKey -> upstreamKey -> entries */
function nodeReviewHistories(tasks: AnyRow[] | undefined): Record<string, Record<string, Array<{ action: string; note: string; name: string; at?: string }>>> {
  const result: Record<string, Record<string, Array<{ action: string; note: string; name: string; at?: string }>>> = {};
  for (const task of [...(tasks ?? [])].sort((left, right) => left.id - right.id)) {
    if (task.status === 'cancelled') continue;
    const input = taskRecord(task.inputJson);
    if (input.nodeType !== 'checkpoint') continue;
    const checkpointKey = typeof input.key === 'string' ? input.key : '';
    if (!checkpointKey) continue;
    const raw = input.reviewHistoryByNode;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const byUpstream: Record<string, Array<{ action: string; note: string; name: string; at?: string }>> = {};
    for (const [upstreamKey, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      byUpstream[upstreamKey] = value.flatMap((entry) => {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        const note = typeof record.note === 'string' ? record.note : '';
        const action = typeof record.action === 'string' ? record.action : '';
        if (!note && !action) return [];
        return [{
          action,
          note,
          name: typeof record.name === 'string' ? record.name : upstreamKey,
          at: typeof record.at === 'string' ? record.at : undefined,
        }];
      });
    }
    result[checkpointKey] = byUpstream;
  }
  return result;
}
function nodeDeliverables(tasks: AnyRow[] | undefined): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const task of [...(tasks ?? [])].sort((left, right) => left.id - right.id)) {
    if (task.status === 'cancelled') {
      const key = typeof taskRecord(task.inputJson).key === 'string' ? String(taskRecord(task.inputJson).key) : '';
      if (key) delete paths[key];
      continue;
    }
    const input = taskRecord(task.inputJson);
    const key = typeof input.key === 'string' ? input.key : '';
    if (!key) continue;
    const output = taskRecord(task.outputJson);
    const fromOutput = typeof output.workspacePath === 'string' ? output.workspacePath : '';
    const fromInput = typeof input.workspacePath === 'string' ? input.workspacePath : '';
    const directory = fromOutput || fromInput;
    if (directory) paths[key] = directory;
    else delete paths[key];
  }
  return paths;
}
function sameDeliverables(left: Record<string, string>, right: Record<string, string>) {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
function sameChecks(left: Record<string, NodeCheck>, right: Record<string, NodeCheck>) {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => {
    const a = left[key];
    const b = right[key];
    if (!a || !b || a.verdict !== b.verdict || a.label !== b.label || a.detail !== b.detail) return false;
    const ah = a.history ?? [];
    const bh = b.history ?? [];
    return ah.length === bh.length && ah.every((item, index) => item.verdict === bh[index]?.verdict && item.detail === bh[index]?.detail);
  });
}

function Badge({ value }: { value: string }) { return <span className={`badge ${value}`}>{statusText(value)}</span>; }
function Empty({ children }: { children: React.ReactNode }) { return <div className="empty"><span>◇</span>{children}</div>; }
function Json({ value }: { value: unknown }) { return <pre className="json">{pretty(value)}</pre>; }
function SectionTitle({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: React.ReactNode }) {
  return <div className="section-title"><div>{eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}<h2>{title}</h2></div>{action}</div>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label>{label}{children}{hint ? <small className="field-hint">{hint}</small> : null}</label>;
}
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return <div className="modal-backdrop" onMouseDown={() => closeRef.current()}>
    <div className="modal panel" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
      <div className="panel-head"><h3>{title}</h3><button type="button" onClick={() => closeRef.current()}>关闭</button></div>
      {children}
    </div>
  </div>;
}

export default function ControlCenter() {
  const pathname = usePathname();
  const router = useRouter();
  const view = viewFromPath(pathname);
  const setView = (next: View) => router.push(PATHS[next]);
  const [token, setToken] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<Id | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState<Id | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<Id | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [liveProgress, setLiveProgress] = useState<Record<string, string> | null>(null);
  const [liveFailures, setLiveFailures] = useState<Record<string, string> | null>(null);
  const [liveChecks, setLiveChecks] = useState<Record<string, NodeCheck> | null>(null);
  const [liveDeliverables, setLiveDeliverables] = useState<Record<string, string> | null>(null);
  const [center, setCenter] = useState<Center | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [liveEvents, setLiveEvents] = useState<EventRow[]>([]);
  const [sse, setSse] = useState<'idle' | 'connecting' | 'open' | 'error'>('idle');
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [executePrompt, setExecutePrompt] = useState(false);
  const [chatNodeKey, setChatNodeKey] = useState<string | null>(null);
  const [nodeMessages, setNodeMessages] = useState<Array<{ id: Id; role: string; content: string; thinking?: string | null; status: string }>>([]);
  const [chatError, setChatError] = useState('');
  const [chatTick, setChatTick] = useState(0);
  const inflight = useRef(false);
  const boardOpen = useRef(false);
  const progressSync = useRef(false);
  const progressFloor = useRef<number | null>(null);

  const [providerChoice, setProviderChoice] = useState('');
  const [projectName, setProjectName] = useState('');
  const [catalogForm, setCatalogForm] = useState({ providerName: '', providerType: 'openai', baseUrl: '', apiKey: '', modelName: '', displayName: '' });
  const [modelDraft, setModelDraft] = useState<{ id: Id; providerId: string; name: string; displayName: string; baseUrl: string } | null>(null);
  const [providerDraft, setProviderDraft] = useState<{ id: Id; name: string; type: string; baseUrl: string; apiKey: string; apiKeySet: boolean; apiKeyMasked: string } | null>(null);
  const [createDialog, setCreateDialog] = useState<'provider' | 'model' | 'project' | 'workflow' | null>(null);
  const [projectDraft, setProjectDraft] = useState<{ id: Id; name: string } | null>(null);
  const [newWorkflowProjectId, setNewWorkflowProjectId] = useState('');
  const [workflowProjectFilter, setWorkflowProjectFilter] = useState('');
  const [workflowForm, setWorkflowForm] = useState({ name: '', version: 'v1' });
  const [workflowNodesForm, setWorkflowNodesForm] = useState<WorkflowNodeDraft[]>([]);
  const [workflowEdgesForm, setWorkflowEdgesForm] = useState<{ source: string; target: string }[]>([]);
  const [workflowLoops, setWorkflowLoops] = useState<WorkflowLoop[]>([]);
  const [workflowDirectory, setWorkflowDirectory] = useState('');
  const [workflowVersions, setWorkflowVersions] = useState<WorkflowVersionOption[]>([]);
  const [currentVersionId, setCurrentVersionId] = useState<Id | null>(null);
  const [baselineDefinition, setBaselineDefinition] = useState('');
  const [versionSwitchPrompt, setVersionSwitchPrompt] = useState<Id | null>(null);
  const [board, setBoard] = useState<'create' | 'view' | null>(null);
  const [capabilityForm, setCapabilityForm] = useState({ key: '', name: '', description: '' });
  const [capabilityDraft, setCapabilityDraft] = useState<{ id: Id; key: string; name: string; description: string } | null>(null);
  const [capabilityDialog, setCapabilityDialog] = useState(false);
  const [skillForm, setSkillForm] = useState({ key: '', name: '', description: '', contentMd: '', toolsAllow: 'bash', source: 'markdown' as 'markdown' | 'upload' });
  const [skillUpload, setSkillUpload] = useState<File | null>(null);
  const [skillDraft, setSkillDraft] = useState<{ id: Id; key: string; name: string; description: string; kind: 'builtin' | 'custom'; contentMd: string; toolsAllow: string; files: string[]; source?: string } | null>(null);
  const [skillDraftUpload, setSkillDraftUpload] = useState<File | null>(null);
  const [skillDialog, setSkillDialog] = useState(false);
  const [replanReason, setReplanReason] = useState('');
  const [replanJson, setReplanJson] = useState('');
  const [decisionText, setDecisionText] = useState<Record<number, string>>({});
  const [loginForm, setLoginForm] = useState({ email: 'admin@local.orvia', password: 'orvia-local' });
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenantId, setTenantId] = useState<Id | null>(null);
  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState({
    piCommand: 'pi',
    mysqlHost: '127.0.0.1',
    mysqlPort: '3306',
    mysqlUser: 'root',
    mysqlPassword: '',
    mysqlDatabase: 'orvia',
    redisHost: '127.0.0.1',
    redisPort: '6379',
    redisPassword: '',
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const fail = useCallback((cause: unknown, fallback = '操作失败') => {
    setError(cause instanceof Error ? cause.message : fallback);
    setState('error');
  }, []);

  const loadGlobal = useCallback(async () => {
    const [projectRows, providerRows, modelRows, workflowRows, capabilityRows, skillRows] = await Promise.all([
      list<Project>('/api/projects'),
      list<Provider>('/api/model-providers'),
      list<Model>('/api/models'),
      list<Workflow>('/api/workflows'),
      list<CapabilityRow>('/api/capabilities'),
      list<SkillRow>('/api/skills'),
    ]);
    setProjects(projectRows);
    setProviders(providerRows);
    setModels(modelRows);
    setWorkflows(workflowRows);
    setCapabilities(capabilityRows);
    setSkills(skillRows);
  }, []);

  const loadProject = useCallback(async (id: Id) => {
    setState('loading'); setError('');
    try {
      const [dashboard, decisionRows, workflowRows, capabilityRows, skillRows] = await Promise.all([
        request<Center>(`/api/control-center?projectId=${id}`),
        list<Decision>(`/api/decisions?projectId=${id}`),
        list<Workflow>('/api/workflows'),
        list<CapabilityRow>('/api/capabilities'),
        list<SkillRow>('/api/skills'),
      ]);
      setCenter(dashboard);
      setDecisions(decisionRows);
      setWorkflows(workflowRows);
      setSkills(skillRows);
      setCapabilities(capabilityRows);
      setWorkflowId((current) => current && workflowRows.some((item) => item.id === current) ? current : null);
      setState('ready');
    } catch (cause) { fail(cause, '项目数据加载失败'); }
  }, [fail]);

  const loadRuns = useCallback(async (id: Id) => {
    try {
      const rows = await list<Run>(`/api/workflow-runs?workflowId=${id}`);
      setRuns(rows);
      setRunId((current) => (current && rows.some((item) => item.id === current) ? current : (rows[0]?.id ?? null)));
    } catch (cause) { fail(cause, '运行记录加载失败'); }
  }, [fail]);
  const loadRun = useCallback(async (id: Id) => {
    try {
      const result = await request<{ data: RunDetail }>(`/api/workflow-runs/${id}`);
      setRunDetail(result.data);
      setWorkflows((current) => current.map((item) => item.id === result.data.workflowId ? { ...item, runStatus: result.data.status } : item));
      // 面板上的「待确认」来自 decisions 列表；Run 详情刷新时同步，否则等人工复核时入口出不来
      const runDecisions = result.data.decisions ?? [];
      setDecisions((current) => {
        const others = current.filter((item) => item.workflowRunId !== id);
        return [...others, ...runDecisions];
      });
    } catch (cause) { fail(cause, '运行详情加载失败'); }
  }, [fail]);
  const loadSystemSettings = useCallback(async () => {
    const result = await request<SystemSettings>('/api/system/settings');
    setSystemSettings(result);
    setSettingsForm({
      piCommand: result.pi.command || 'pi',
      mysqlHost: result.mysql.host,
      mysqlPort: result.mysql.port,
      mysqlUser: result.mysql.user,
      mysqlPassword: '',
      mysqlDatabase: result.mysql.database,
      redisHost: result.redis.host,
      redisPort: result.redis.port,
      redisPassword: '',
    });
    setSettingsLoaded(true);
  }, []);
  useEffect(() => {
    const stored = window.sessionStorage.getItem('orvia.token') ?? '';
    const storedTenant = Number(window.sessionStorage.getItem('orvia.tenant') ?? '');
    apiToken = stored;
    apiTenantId = Number.isInteger(storedTenant) && storedTenant > 0 ? storedTenant : undefined;
    setToken(stored);
    setTenantId(apiTenantId ?? null);
  }, []);
  useEffect(() => {
    if (view !== 'settings') return;
    void loadSystemSettings().catch((cause) => fail(cause, '系统状态加载失败'));
  }, [view, loadSystemSettings, fail]);
  useEffect(() => {
    void (async () => {
      try {
        const me = await request<{ mode: string; tenantId: number; tenants: TenantRow[] }>('/api/auth/me');
        setTenants(me.tenants ?? []);
        const nextTenant = apiTenantId ?? me.tenantId;
        apiTenantId = nextTenant;
        setTenantId(nextTenant);
        window.sessionStorage.setItem('orvia.tenant', String(nextTenant));
      } catch {
        /* 未登录时继续使用默认租户 */
      }
    })();
  }, [token]);
  useEffect(() => {
    void loadGlobal().then(() => setState('ready')).catch((cause) => fail(cause, '基础数据加载失败'));
  }, [loadGlobal, fail, token]);
  useEffect(() => { if (projectId) void loadProject(projectId); }, [projectId, loadProject]);
  const restoredContext = useRef(false);
  const reopenStarted = useRef(false);
  useEffect(() => {
    if (!projects.length) return;
    if (projectId && projects.some((item) => item.id === projectId)) return;
    const stored = Number(window.sessionStorage.getItem('orvia.project') ?? '');
    const next = projects.some((item) => item.id === stored) ? stored : projects[0]!.id;
    setProjectId(next);
    window.sessionStorage.setItem('orvia.project', String(next));
  }, [projects, projectId]);
  useEffect(() => {
    if (restoredContext.current || !workflows.length) return;
    restoredContext.current = true;
    const storedWorkflow = Number(window.sessionStorage.getItem('orvia.workflow') ?? '');
    const storedRun = Number(window.sessionStorage.getItem('orvia.run') ?? '');
    if (!storedWorkflow || !workflows.some((item) => item.id === storedWorkflow)) return;
    setWorkflowId(storedWorkflow);
    if (storedRun) setRunId(storedRun);
  }, [workflows]);
  useEffect(() => {
    if (view !== 'workflows' || reopenStarted.current || !workflows.length) return;
    if (window.sessionStorage.getItem('orvia.reopenBoard') !== '1') return;
    const id = Number(window.sessionStorage.getItem('orvia.workflow') ?? '');
    if (!id || !workflows.some((item) => item.id === id)) return;
    reopenStarted.current = true;
    window.sessionStorage.removeItem('orvia.reopenBoard');
    const storedRun = Number(window.sessionStorage.getItem('orvia.run') ?? '') || null;
    void openWorkflowBoard(id, storedRun);
  }, [view, workflows]);
  useEffect(() => {
    if (!workflowId) { setRuns([]); setRunId(null); return; }
    void loadRuns(workflowId);
  }, [workflowId, loadRuns]);
  useEffect(() => { if (runId) void loadRun(runId); else setRunDetail(null); }, [runId, loadRun]);
  useEffect(() => {
    if (!workflowId || !chatNodeKey) { setNodeMessages([]); return; }
    let stopped = false;
    let timer = 0;
    let waiting = true;
    const load = async () => {
      try {
        const result = await request<{ data: Array<{ id: Id; role: string; content: string; thinking?: string | null; status: string }> }>(`/api/workflows/${workflowId}/nodes/${encodeURIComponent(chatNodeKey)}/messages`);
        if (stopped) return;
        setNodeMessages(result.data);
        waiting = result.data.some((item) => item.status === 'streaming' || item.status === 'pending');
        if (!waiting) setChatError((current) => (current === '这个 Agent 正在回复，请稍候' ? '' : current));
      } catch (cause) {
        if (!stopped) setChatError(cause instanceof Error ? cause.message : '对话加载失败');
      }
      if (!stopped && waiting) timer = window.setTimeout(() => { void load(); }, 160);
    };
    void load();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [workflowId, chatNodeKey, chatTick]);
  useAutoDismiss(error, setError);
  useAutoDismiss(notice, setNotice);
  useAutoDismiss(chatError, setChatError);
  useEffect(() => { setLiveProgress(null); setLiveFailures(null); setLiveChecks(null); setLiveDeliverables(null); progressSync.current = false; progressFloor.current = null; }, [runId]);
  useEffect(() => {
    boardOpen.current = board !== null;
    if (!board || !runId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const tasks = await list<AnyRow>(`/api/tasks?workflowRunId=${runId}`);
        if (stopped) return;
        const floor = progressFloor.current;
        if (floor != null && !tasks.some((task) => task.id > floor)) {
          setLiveProgress({});
          setLiveFailures({});
          setLiveChecks({});
          setLiveDeliverables({});
          return;
        }
        if (floor != null) progressFloor.current = null;
        const next = nodeProgress(tasks);
        setLiveProgress((current) => {
          const baseline = current ?? nodeProgress(runDetail?.tasks);
          return sameProgress(baseline, next) ? current : next;
        });
        const failures = nodeFailures(tasks);
        setLiveFailures((current) => {
          const baseline = current ?? nodeFailures(runDetail?.tasks);
          return sameFailures(baseline, failures) ? current : failures;
        });
        const eventRows = [...(runDetail?.events ?? []), ...liveEvents.filter((event) => event.workflowRunId === runId)];
        const checks = nodeChecks(tasks, eventRows);
        setLiveChecks((current) => {
          const baseline = current ?? nodeChecks(runDetail?.tasks, eventRows);
          return sameChecks(baseline, checks) ? current : checks;
        });
        const deliverables = nodeDeliverables(tasks);
        setLiveDeliverables((current) => {
          const baseline = current ?? nodeDeliverables(runDetail?.tasks);
          return sameDeliverables(baseline, deliverables) ? current : deliverables;
        });
        const values = Object.values(next);
        const anyRunning = values.some((status) => status === 'running');
        const anyFailed = values.some((status) => status === 'failed');
        // 已有失败节点时，剩下的 pending/blocked 不能把整次 Run 伪装成「运行中」，否则失败后要点停止才能再执行
        const busy = anyRunning || (!anyFailed && values.some((status) => status === 'pending' || status === 'paused'));
        if (busy) {
          progressSync.current = false;
          setRunDetail((current) => {
            if (!current) return current;
            if (['failed', 'completed', 'cancelled'].includes(current.status) && !anyRunning) return current;
            return current.status !== 'running' ? { ...current, status: 'running' } : current;
          });
          return;
        }
        const settled = anyFailed || values.some((status) => status === 'awaiting_decision') || !values.some((status) => status === 'blocked');
        if (settled && !progressSync.current) {
          progressSync.current = true;
          void loadRun(runId);
        }
      } catch { /* 进度刷新失败时保留节点上一次的状态 */ }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [board, runId, loadRun, runDetail?.tasks, runDetail?.events, liveEvents]);

  useEffect(() => {
    if (!projectId) { setSse('idle'); return; }
    setSse('connecting');
    const tokenQuery = apiToken ? `&access_token=${encodeURIComponent(apiToken)}` : '';
    const remember = (event: EventRow) => {
      // 流式执行日志只在内存/Redis，不落库；窗口加大以免长跑时面板日志被冲掉
      setLiveEvents((current) => current.some((item) => item.id === event.id) ? current : [event, ...current].slice(0, 2000));
      const runEnded = event.type === 'workflow.completed'
        || event.type === 'workflow.failed'
        || event.type === 'workflow.stopped'
        || event.type === 'checkpoint.pending'
        || event.type === 'acceptance.pending'
        || event.type === 'task.failed';
      if (runId && event.workflowRunId === runId && (!boardOpen.current || runEnded)) void loadRun(runId);
    };
    const source = new EventSource(`${API_URL}/api/events/stream?projectId=${projectId}${tokenQuery}`);
    source.addEventListener('ready', () => setSse('open'));
    source.addEventListener('orvia.event', (raw) => {
      try { remember(JSON.parse((raw as MessageEvent).data) as EventRow); } catch { /* malformed external event */ }
    });
    source.onerror = () => setSse('error');
    source.onopen = () => setSse('open');
    const socketUrl = `${API_URL.replace(/^http/, 'ws')}/api/events/ws?projectId=${projectId}${tokenQuery}`;
    const socket = new WebSocket(socketUrl);
    socket.onmessage = (raw) => {
      try {
        const event = JSON.parse(raw.data) as EventRow & { type: string };
        if (event.type === 'ready' || event.type === 'heartbeat') return;
        remember(event);
      } catch { /* malformed websocket frame */ }
    };
    return () => { source.close(); socket.close(); setSse('idle'); };
  }, [projectId, runId, loadRun, token]);

  const project = projects.find((item) => item.id === projectId);
  const pendingDecisions = decisions.filter((item) => item.status === 'pending');
  const currentEvents = liveEvents.length ? liveEvents : center?.recentEvents ?? [];

  async function act(_key: string, task: () => Promise<void>, success: string) {
    if (inflight.current) {
      setNotice('');
      setError('上一个操作还在进行，请稍候');
      return false;
    }
    inflight.current = true;
    setError(''); setNotice('');
    try { await task(); setNotice(success); setState('ready'); return true; } catch (cause) { fail(cause); return false; } finally { inflight.current = false; }
  }
  async function refresh() {
    await loadGlobal();
    if (projectId) await loadProject(projectId);
    if (workflowId) await loadRuns(workflowId);
    if (runId) await loadRun(runId);
  }
  function requireProject(): Id { if (!projectId) throw new Error('请先选择项目'); return projectId; }
  function parseJson(value: string, label: string): unknown { try { return JSON.parse(value); } catch { throw new Error(`${label} 不是有效 JSON`); } }

  function providerBaseUrl(providerId: string | number | null | undefined): string {
    if (providerId === null || providerId === undefined || providerId === '') return '';
    const provider = providers.find((item) => String(item.id) === String(providerId));
    return provider?.baseUrl?.trim() || '';
  }
  function openCreateModel() {
    const nextProvider = providerChoice || (providers[0] ? String(providers[0].id) : '');
    setProviderChoice(nextProvider);
    setCatalogForm((value) => ({
      ...value,
      modelName: '',
      displayName: '',
      baseUrl: providerBaseUrl(nextProvider),
    }));
    setCreateDialog('model');
  }
  async function createProvider(e: FormEvent) {
    e.preventDefault();
    await act('provider', async () => {
      if (!catalogForm.providerName.trim() || !catalogForm.providerType.trim()) throw new Error('请输入 Provider 名称与类型');
      const baseUrl = catalogForm.baseUrl.trim();
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('API 访问地址需要以 http:// 或 https:// 开头');
      const apiKey = catalogForm.apiKey.trim();
      if (!apiKey) throw new Error('请填写 API Key，执行时会传给 Pi');
      const created = await request<{ id: Id }>('/api/model-providers', {
        name: catalogForm.providerName.trim(),
        type: catalogForm.providerType.trim(),
        baseUrl: catalogForm.baseUrl.trim() || undefined,
        apiKey,
      });
      await loadGlobal();
      setProviderChoice(String(created.id));
      setCatalogForm((value) => ({ ...value, providerName: '', providerType: 'openai', baseUrl, apiKey: '' }));
      setCreateDialog(null);
    }, 'Provider 已创建并选中');
  }
  async function saveProvider(e: FormEvent) {
    e.preventDefault();
    if (!providerDraft) return;
    const draft = providerDraft;
    await act('provider-edit', async () => {
      if (!draft.name.trim() || !draft.type.trim()) throw new Error('请输入 Provider 名称与类型');
      const baseUrl = draft.baseUrl.trim();
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('API 访问地址需要以 http:// 或 https:// 开头');
      const nextKey = draft.apiKey.trim();
      if (!draft.apiKeySet && !nextKey) throw new Error('请填写 API Key，执行时会传给 Pi');
      await request(`/api/model-providers/${draft.id}`, {
        name: draft.name.trim(),
        type: draft.type.trim(),
        baseUrl,
        ...(nextKey ? { apiKey: nextKey } : {}),
      }, 'PATCH');
      setProviderDraft(null);
      await loadGlobal();
    }, 'Provider 已更新');
  }
  async function createProject(e: FormEvent) {
    e.preventDefault();
    await act('project', async () => {
      if (!projectName.trim()) throw new Error('请输入项目名称');
      const created = await request<{ id: Id }>('/api/projects', { name: projectName.trim() });
      await loadGlobal();
      setProjectId(created.id);
      window.sessionStorage.setItem('orvia.project', String(created.id));
      setProjectName('');
      setCreateDialog(null);
    }, '项目已创建');
  }
  async function saveProject(e: FormEvent) {
    e.preventDefault();
    await act('project-edit', async () => {
      if (!projectDraft) return;
      if (!projectDraft.name.trim()) throw new Error('请输入项目名称');
      await request(`/api/projects/${projectDraft.id}`, { name: projectDraft.name.trim() }, 'PATCH');
      setProjectDraft(null);
      await loadGlobal();
    }, '项目名称已更新');
  }
  function openProjectWorkflows(item: Project) {
    setProjectId(item.id);
    window.sessionStorage.setItem('orvia.project', String(item.id));
    setWorkflowProjectFilter(String(item.id));
    setView('workflows');
  }
  async function login(e: FormEvent) {
    e.preventDefault();
    await act('login', async () => {
      const result = await request<{ token: string; tenants: TenantRow[] }>('/api/auth/login', { email: loginForm.email.trim(), password: loginForm.password });
      apiToken = result.token;
      window.sessionStorage.setItem('orvia.token', result.token);
      setToken(result.token);
      setTenants(result.tenants);
      const nextTenant = result.tenants[0]?.tenantId;
      if (nextTenant) {
        apiTenantId = nextTenant;
        setTenantId(nextTenant);
        window.sessionStorage.setItem('orvia.tenant', String(nextTenant));
      }
      await loadGlobal();
    }, '已登录');
  }
  async function createModel(e: FormEvent) {
    e.preventDefault();
    await act('model', async () => {
      if (!providers.length) throw new Error('还没有 Provider，请先创建 Provider');
      if (!providerChoice) throw new Error('请选择要绑定的 Provider');
      if (!catalogForm.modelName.trim()) throw new Error('请输入模型标识');
      const baseUrl = catalogForm.baseUrl.trim();
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('API 访问地址需要以 http:// 或 https:// 开头');
      const created = await request<{ id: Id }>('/api/models', { providerId: Number(providerChoice), name: catalogForm.modelName.trim(), displayName: catalogForm.displayName.trim() || catalogForm.modelName.trim() });
      await request(`/api/model-providers/${providerChoice}`, { baseUrl }, 'PATCH');
      await loadGlobal();
      setCatalogForm((value) => ({ ...value, modelName: '', displayName: '' }));
      setCreateDialog(null);
    }, 'Model 已创建');
  }
  async function saveModel(e: FormEvent) {
    e.preventDefault();
    const draft = modelDraft;
    if (!draft) return;
    await act('model-edit', async () => {
      if (!draft.providerId) throw new Error('请选择 Provider');
      if (!draft.name.trim() || !draft.displayName.trim()) throw new Error('请填写模型标识和显示名称');
      const baseUrl = draft.baseUrl.trim();
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('API 访问地址需要以 http:// 或 https:// 开头');
      await request(`/api/models/${draft.id}`, { providerId: Number(draft.providerId), name: draft.name.trim(), displayName: draft.displayName.trim() }, 'PATCH');
      await request(`/api/model-providers/${draft.providerId}`, { baseUrl }, 'PATCH');
      setModelDraft(null);
      await loadGlobal();
    }, '模型已更新');
  }
  async function createCapability(e: FormEvent) {
    e.preventDefault();
    await act('capability', async () => {
      if (!capabilityForm.key.trim() || !capabilityForm.name.trim()) throw new Error('请填写能力标识和中文名称');
      await request('/api/capabilities', { key: capabilityForm.key.trim(), name: capabilityForm.name.trim(), description: capabilityForm.description.trim() });
      await loadGlobal();
      setCapabilityForm({ key: '', name: '', description: '' });
      setCapabilityDialog(false);
    }, '能力已加入目录');
  }
  async function saveCapability(e: FormEvent) {
    e.preventDefault();
    if (!capabilityDraft) return;
    const draft = capabilityDraft;
    await act('capability-edit', async () => {
      if (!draft.name.trim()) throw new Error('请填写中文名称');
      await request(`/api/capabilities/${draft.id}`, { name: draft.name.trim(), description: draft.description.trim() }, 'PATCH');
      await loadGlobal();
      setCapabilityDraft(null);
    }, '能力已更新');
  }
  function toolsAllowText(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const allow = (value as { allow?: unknown }).allow;
    return Array.isArray(allow) ? allow.filter((item): item is string => typeof item === 'string').join(', ') : '';
  }
  function skillPackageMeta(value: unknown): { source?: string; files: string[] } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { files: [] };
    const record = value as { source?: unknown; files?: unknown };
    const files = Array.isArray(record.files) ? record.files.filter((item): item is string => typeof item === 'string') : [];
    return { source: typeof record.source === 'string' ? record.source : undefined, files };
  }
  async function uploadSkillPackage(path: string, file: File, meta: { key: string; name: string; description: string; toolsAllow: string }) {
    const response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'content-type': file.type || 'application/octet-stream',
        'x-orvia-filename': encodeURIComponent(file.name),
        'x-orvia-skill-key': meta.key,
        'x-orvia-skill-name': encodeURIComponent(meta.name),
        'x-orvia-skill-description': encodeURIComponent(meta.description),
        'x-orvia-skill-tools': meta.toolsAllow,
      },
      body: file,
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try { const data = await response.json() as { error?: string }; message = data.error ?? message; } catch { /* keep */ }
      throw new Error(message);
    }
    return response.json();
  }
  async function createSkill(e: FormEvent) {
    e.preventDefault();
    await act('skill', async () => {
      if (!skillForm.key.trim()) throw new Error('请填写 Skill 标识');
      const toolsAllow = skillForm.toolsAllow.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean).join(',');
      if (skillForm.source === 'upload') {
        if (!skillUpload) throw new Error('请选择要导入的 Skill 包（.zip）或 SKILL.md 文件');
        await uploadSkillPackage('/api/skills/import', skillUpload, {
          key: skillForm.key.trim(),
          name: skillForm.name.trim() || skillForm.key.trim(),
          description: skillForm.description.trim(),
          toolsAllow: toolsAllow || 'bash',
        });
      } else {
        if (!skillForm.name.trim()) throw new Error('请填写中文名称');
        if (!skillForm.contentMd.trim()) throw new Error('请填写 SKILL.md 内容，或改为导入 Skill 包');
        await request('/api/skills', {
          key: skillForm.key.trim(),
          name: skillForm.name.trim(),
          description: skillForm.description.trim(),
          contentMd: skillForm.contentMd.trim(),
          toolsJson: { allow: toolsAllow ? toolsAllow.split(',') : ['bash'] },
        });
      }
      await loadGlobal();
      setSkillForm({ key: '', name: '', description: '', contentMd: '', toolsAllow: 'bash', source: 'markdown' });
      setSkillUpload(null);
      setSkillDialog(false);
    }, '自定义 Skill 已加入目录');
  }
  async function saveSkill(e: FormEvent) {
    e.preventDefault();
    if (!skillDraft) return;
    const draft = skillDraft;
    await act('skill-edit', async () => {
      if (draft.kind === 'builtin') {
        await request(`/api/skills/${draft.id}`, { description: draft.description.trim() }, 'PATCH');
      } else {
        if (!draft.name.trim()) throw new Error('请填写中文名称');
        if (skillDraftUpload) {
          await uploadSkillPackage(`/api/skills/${draft.id}/import`, skillDraftUpload, {
            key: draft.key,
            name: draft.name.trim(),
            description: draft.description.trim(),
            toolsAllow: draft.toolsAllow || 'bash',
          });
        }
        const toolsAllow = draft.toolsAllow.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
        await request(`/api/skills/${draft.id}`, {
          name: draft.name.trim(),
          description: draft.description.trim(),
          contentMd: draft.contentMd,
          toolsJson: { allow: toolsAllow },
        }, 'PATCH');
      }
      await loadGlobal();
      setSkillDraft(null);
      setSkillDraftUpload(null);
    }, 'Skill 已更新');
  }
  async function deleteSkill(id: Id) {
    const item = skills.find((skill) => skill.id === id);
    if (!item || item.kind === 'builtin') throw new Error('系统内置 Skill 不能删除');
    const confirmed = window.confirm(`删除自定义 Skill「${item.name}」？\n\n删除后无法恢复。`);
    if (!confirmed) return;
    await act('skill-delete', async () => {
      await request(`/api/skills/${id}`, undefined, 'DELETE');
      await loadGlobal();
    }, '自定义 Skill 已删除');
  }
  function workflowDefinition(nextNodes = workflowNodesForm, nextEdges = workflowEdgesForm, nextLoops = workflowLoops) {
    return {
      nodes: nextNodes.map((node) => ({
        key: node.key,
        name: node.name.trim(),
        type: node.type,
        capabilities: node.type === 'task' ? node.capabilities : [],
        capability: node.type === 'task' ? (node.capabilities[0] ?? '') : '',
        skills: node.type === 'task' ? (node.skills ?? []) : [],
        ...(node.type === 'task' && node.modelId ? { modelId: node.modelId } : {}),
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
        ...(node.type === 'task' && node.instruction.trim() ? { instruction: node.instruction.trim() } : {}),
        ...(node.type === 'task' && node.outputRequirement.trim() ? { outputRequirement: node.outputRequirement.trim() } : {}),
        ...(node.type === 'task' && node.acceptanceRule.trim() ? { acceptanceRule: node.acceptanceRule.trim(), maxRedos: node.maxRedos >= 1 ? node.maxRedos : 3 } : {}),
        ...(node.type === 'start' ? { requirement: node.requirement } : {}),
        ...(node.type === 'checkpoint' && node.question.trim() && !/^Approve checkpoint:/i.test(node.question.trim()) ? { question: node.question.trim() } : {}),
      })),
      edges: nextEdges.filter((edge) => edge.source && edge.target),
      loops: nextLoops,
    };
  }
  function definitionSnapshot(nodes = workflowNodesForm, edges = workflowEdgesForm, loops = workflowLoops, name = workflowForm.name) {
    return JSON.stringify({ name: name.trim() || '未命名 Workflow', definition: workflowDefinition(nodes, edges, loops) });
  }
  function hasUnpublishedChanges() {
    if (!baselineDefinition) return false;
    return definitionSnapshot() !== baselineDefinition;
  }
  async function loadWorkflowVersions(id: Id) {
    const result = await request<{ data: WorkflowVersionOption[]; currentVersionId: number | null; currentVersion: string }>(`/api/workflows/${id}/versions`);
    setWorkflowVersions(result.data);
    setCurrentVersionId(result.currentVersionId);
    setWorkflowForm((current) => ({ ...current, version: result.currentVersion || current.version }));
    return result;
  }
  async function persistBoard(nextNodes: WorkflowNodeDraft[], nextEdges: { source: string; target: string }[], silent = false, nextLoops = workflowLoops) {
    const save = async () => {
      if (!workflowId) throw new Error('请先新建 Workflow');
      if (runDetail?.workflowId === workflowId && runDetail.status === 'running') throw new Error('请先停止 Run，再编辑 Agent');
      const current = workflows.find((item) => item.id === workflowId);
      const definitionJson = workflowDefinition(nextNodes, nextEdges, nextLoops);
      await request(`/api/workflows/${workflowId}`, {
        name: workflowForm.name.trim() || current?.name || '未命名 Workflow',
        status: current?.status === 'published' ? 'published' : 'draft',
        definitionJson,
      }, 'PATCH');
      setWorkflowNodesForm(nextNodes);
      setWorkflowEdgesForm(nextEdges);
      setWorkflowLoops(nextLoops);
    };
    if (silent) {
      // 布局拖动可能连续触发；等前一次完成后再存，避免丢掉最终大小
      for (let attempt = 0; attempt < 20 && inflight.current; attempt += 1) {
        await new Promise<void>((resolve) => { window.setTimeout(resolve, 50); });
      }
      if (inflight.current) return false;
      inflight.current = true;
      try { await save(); return true; } catch (cause) { fail(cause); return false; } finally { inflight.current = false; }
    }
    return act('save-node', save, 'Agent 已保存');
  }
  async function publishWorkflow(silentNotice?: string) {
    const ok = await act('workflow', async () => {
      const id = requireProject();
      if (!workflowId) throw new Error('请先新建 Workflow');
      if (!workflowForm.name.trim()) throw new Error('请输入 Workflow 名称');
      if (!workflowNodesForm.some((node) => node.type === 'task')) throw new Error('请至少添加一个 Agent 节点');
      for (const node of workflowNodesForm) {
        if (!node.name.trim()) throw new Error('请填写每个名称');
        if (node.type === 'task' && !node.capabilities.length) throw new Error(`请为 Agent「${node.name.trim() || '未命名 Agent'}」选择能力`);
        if (node.type === 'task' && !node.modelId) throw new Error(`请为 Agent「${node.name.trim() || '未命名 Agent'}」选择模型`);
        if (node.type === 'task' && node.modelId && !models.some((item) => item.id === node.modelId)) {
          throw new Error(`Agent「${node.name.trim() || '未命名 Agent'}」所选模型不可用，请到「模型管理」检查后再选`);
        }
      }
      const published = await request<{ version: string; versionId: number }>(`/api/workflows/${workflowId}/publish`, {
        name: workflowForm.name.trim(),
        definitionJson: workflowDefinition(),
      });
      await loadProject(id);
      setWorkflowId(workflowId);
      setWorkflowForm((current) => ({ ...current, version: published.version }));
      setCurrentVersionId(published.versionId);
      await loadWorkflowVersions(workflowId);
      setBaselineDefinition(definitionSnapshot(workflowNodesForm, workflowEdgesForm, workflowLoops, workflowForm.name));
      setBoard('view');
    }, silentNotice ?? 'Workflow 已发布');
    return ok;
  }
  async function applyVersionSwitch(versionId: Id) {
    if (!workflowId) throw new Error('请先打开 Workflow');
    if (runDetail && ['running', 'paused', 'awaiting_decision'].includes(runDetail.status)) {
      throw new Error('请先停止 Run，才能切换历史版本');
    }
    await request(`/api/workflows/${workflowId}/versions/${versionId}/activate`, {});
    const result = await request<{ data: { id: Id; name: string; capability?: string | null; capabilitiesJson?: unknown; nodeType?: string; configJson?: unknown }[]; edges: { sourceNodeId: Id; targetNodeId: Id }[]; loops?: WorkflowLoop[]; root?: string }>(`/api/workflows/${workflowId}/nodes`);
    const graph = graphFromStored(result.data, result.edges);
    const versions = await loadWorkflowVersions(workflowId);
    const selected = versions.data.find((item) => item.id === versionId);
    setWorkflowLoops(result.loops ?? []);
    setWorkflowDirectory(result.root ?? '');
    setWorkflowNodesForm(graph.nodes);
    setWorkflowEdgesForm(graph.edges);
    setWorkflowForm({ name: selected?.name ?? workflowForm.name, version: selected?.version ?? versions.currentVersion });
    setCurrentVersionId(versionId);
    setBaselineDefinition(definitionSnapshot(graph.nodes, graph.edges, result.loops ?? [], selected?.name ?? workflowForm.name));
    setBoard('view');
    if (projectId) await loadProject(projectId);
  }
  async function requestVersionSwitch(versionId: Id) {
    if (!workflowId || versionId === currentVersionId) return;
    if (runDetail && ['running', 'paused', 'awaiting_decision'].includes(runDetail.status)) {
      setError('请先停止 Run，才能切换历史版本');
      setState('error');
      return;
    }
    if (hasUnpublishedChanges()) {
      setVersionSwitchPrompt(versionId);
      return;
    }
    await act('version-switch', async () => {
      await applyVersionSwitch(versionId);
    }, '已切换到历史版本');
  }
  async function openWorkflowBoard(id: Id, preferredRunId?: Id | null) {
    try {
      const workflow = workflows.find((item) => item.id === id);
      const ownerProjectId = workflow?.projectId ?? projectId;
      if (!ownerProjectId) throw new Error('请先创建项目');
      if (ownerProjectId !== projectId) {
        setProjectId(ownerProjectId);
        window.sessionStorage.setItem('orvia.project', String(ownerProjectId));
        await loadProject(ownerProjectId);
      }
      const result = await request<{ data: { id: Id; name: string; capability?: string | null; capabilitiesJson?: unknown; nodeType?: string; configJson?: unknown }[]; edges: { sourceNodeId: Id; targetNodeId: Id }[]; loops?: WorkflowLoop[]; root?: string }>(`/api/workflows/${id}/nodes`);
      const graph = graphFromStored(result.data, result.edges);
      setWorkflowLoops(result.loops ?? []);
      setWorkflowDirectory(result.root ?? '');
      setWorkflowId(id);
      setWorkflowForm({ name: workflow?.name ?? '', version: workflow?.version ?? 'v1' });
      setWorkflowNodesForm(graph.nodes);
      setWorkflowEdgesForm(graph.edges);
      const versions = await loadWorkflowVersions(id);
      setBaselineDefinition(definitionSnapshot(graph.nodes, graph.edges, result.loops ?? [], workflow?.name ?? ''));
      setBoard(workflow?.status === 'draft' && !versions.data.length ? 'create' : 'view');
      const runRows = await list<Run>(`/api/workflow-runs?workflowId=${id}`);
      setRuns(runRows);
      setRunId(preferredRunId && runRows.some((item) => item.id === preferredRunId) ? preferredRunId : (runRows.at(-1)?.id ?? null));
      setError('');
    } catch (cause) { fail(cause, 'Workflow 打开失败'); }
  }
  async function closeBoard() {
    setChatNodeKey(null);
    setChatError('');
    const wasCreate = board === 'create';
    const id = workflowId;
    setBoard(null);
    setVersionSwitchPrompt(null);
    if (projectId) {
      try { await loadProject(projectId); } catch { /* 列表刷新失败不挡返回 */ }
    }
    if (id) setWorkflowId(id);
    if (wasCreate) setNotice('草稿已留在列表中，可以稍后继续或删除');
  }
  async function deleteWorkflow(item: Workflow) {
    const confirmed = window.confirm(`删除 Workflow「${item.name}」？\n\n删除后无法恢复。这个 Workflow 的 Agent 节点、连线、Run、执行日志都会被删除。`);
    if (!confirmed) return;
    await act(`delete-workflow-${item.id}`, async () => {
      await request(`/api/workflows/${item.id}`, undefined, 'DELETE');
      if (workflowId === item.id) {
        setWorkflowId(null);
        setRunId(null);
        setBoard(null);
      }
      await loadGlobal();
      if (projectId) await loadProject(projectId);
    }, 'Workflow 已删除');
  }
  function openNewWorkflowDialog() {
    if (!projects.length) {
      fail(new Error('请先创建项目，再新建 Workflow'));
      return;
    }
    setNewWorkflowProjectId(projectId ? String(projectId) : String(projects[0]!.id));
    setCreateDialog('workflow');
  }
  async function createWorkflowDraft(e: FormEvent) {
    e.preventDefault();
    await act('workflow-draft', async () => {
      const id = Number(newWorkflowProjectId);
      if (!Number.isInteger(id) || id < 1) throw new Error('请选择所属项目');
      if (!projects.some((item) => item.id === id)) throw new Error('所选项目不存在');
      const created = await request<{ id: Id }>('/api/workflows', {
        projectId: id,
        name: '未命名 Workflow',
        version: 'v1',
        status: 'draft',
        definitionJson: { nodes: [], edges: [] },
      });
      // GET /nodes 会补齐开始/结束节点；新建不能直接塞空图打开面板
      const result = await request<{ data: { id: Id; name: string; capability?: string | null; capabilitiesJson?: unknown; nodeType?: string; configJson?: unknown }[]; edges: { sourceNodeId: Id; targetNodeId: Id }[]; loops?: WorkflowLoop[]; root?: string }>(`/api/workflows/${created.id}/nodes`);
      const graph = graphFromStored(result.data, result.edges);
      setProjectId(id);
      window.sessionStorage.setItem('orvia.project', String(id));
      setWorkflowId(created.id);
      setWorkflowForm({ name: '未命名 Workflow', version: '未发布' });
      setWorkflowNodesForm(graph.nodes);
      setWorkflowEdgesForm(graph.edges);
      setWorkflowLoops(result.loops ?? []);
      setWorkflowDirectory(result.root ?? '');
      setWorkflowVersions([]);
      setCurrentVersionId(null);
      setBaselineDefinition(definitionSnapshot(graph.nodes, graph.edges, result.loops ?? [], '未命名 Workflow'));
      setRuns([]);
      setRunId(null);
      setBoard('create');
      setCreateDialog(null);
      await loadGlobal();
      await loadProject(id);
      setWorkflowId(created.id);
    }, '已创建草稿 Workflow');
  }
  async function ensureRun(): Promise<Id> {
    if (runId && runDetail?.status === 'running') throw new Error('当前 Run 正在运行，请先停止后再执行');
    if (runId) return runId;
    if (!workflowId) throw new Error('请先打开一个 Workflow');
    const created = await request<{ id: Id; status?: string }>('/api/workflow-runs', { workflowId });
    // 复用已有 Run 时，失败/完成/已停止都可以直接再执行；只有真正运行中才需要先停
    if (created.status === 'running') throw new Error('当前 Run 正在运行，请先停止后再执行');
    await loadRuns(workflowId);
    setRunId(created.id);
    return created.id;
  }
  async function stopRun() {
    return act('stop-run', async () => {
      if (!runId || !runDetail) throw new Error('请先执行这个 Workflow');
      if (!['pending', 'running', 'paused', 'awaiting_decision'].includes(runDetail.status)) throw new Error(`当前 Run 是「${statusText(runDetail.status)}」，只有待处理、运行中、已暂停或等待决策时可以停止`);
      await request(`/api/workflow-runs/${runId}/stop`, {});
      if (workflowId) {
        const current = workflows.find((item) => item.id === workflowId);
        await request(`/api/workflows/${workflowId}`, {
          name: workflowForm.name.trim() || current?.name || '未命名 Workflow',
          status: current?.status === 'published' ? 'published' : 'draft',
          definitionJson: workflowDefinition(),
        }, 'PATCH');
      }
      await loadRun(runId);
      if (workflowId) await loadRuns(workflowId);
    }, 'Run 已停止，现在可以编辑 Agent');
  }
  async function runAction(action: 'execute' | 'pause' | 'resume' | 'replan', mode?: 'restart' | 'resume') {
    if (action === 'execute') {
      if (runId && runDetail?.status === 'running') {
        setError('当前 Run 正在运行，请先停止后再执行');
        setState('error');
        return;
      }
      const start = workflowNodesForm.find((node) => node.type === 'start');
      if (start && board && workflowId) {
        try {
          const files = await request<{ files: { name: string }[] }>(`/api/workflows/${workflowId}/files`);
          if (!start.requirement.trim() && files.files.length === 0) {
            setError('请在开始里填写需求描述或上传文件，交给后面的 Agent');
            setState('error');
            return;
          }
        } catch (cause) {
          fail(cause, '需求文件读取失败');
          return;
        }
      }
      if (!mode && runDetail && runDetail.status !== 'pending') {
        setExecutePrompt(true);
        return;
      }
      setExecutePrompt(false);
    }
    await act(`run-${action}`, async () => {
      if (action === 'execute') {
        const id = await ensureRun();
        if (mode === 'restart') {
          const known = runDetail?.tasks ?? [];
          const existing = known.length ? known : await list<AnyRow>(`/api/tasks?workflowRunId=${id}`);
          progressFloor.current = existing.reduce((max, task) => Math.max(max, task.id), 0);
          setLiveProgress({});
          setLiveFailures({});
          setLiveChecks({});
          setLiveDeliverables({});
          progressSync.current = false;
          // 从头开始：立刻清掉本 Run 全部复核/决策状态，避免人工节点仍显示待确认或旧结果
          setDecisions((rows) => rows.map((item) => item.workflowRunId === id && item.status !== 'superseded'
            ? { ...item, status: 'superseded' }
            : item));
          setDecisionText({});
          setRunDetail((current) => current ? {
            ...current,
            status: 'running',
            tasks: (current.tasks ?? []).map((task) => ({ ...task, status: 'cancelled' })),
            checkpoints: (current.checkpoints ?? []).map((item) => item.status !== 'superseded' ? { ...item, status: 'superseded' } : item),
            decisions: (current.decisions ?? []).map((item) => item.status !== 'superseded' ? { ...item, status: 'superseded' } : item),
          } : current);
        }
        try {
          await request(`/api/workflow-runs/${id}/execute`, mode ? { mode } : {});
        } catch (error) {
          if (mode === 'restart') {
            progressFloor.current = null;
            setLiveProgress(null);
            setLiveFailures(null);
            setLiveChecks(null);
            setLiveDeliverables(null);
          }
          throw error;
        }
        setRunDetail((current) => current ? { ...current, status: 'running' } : current);
        if (mode === 'restart' && projectId) {
          // 后端已同步作废旧复核；再拉一次，确保进度/决策与库一致
          await loadRun(id);
          await loadProject(projectId);
          setLiveProgress({});
          setLiveFailures({});
          setLiveChecks({});
        }
        return;
      }
      if (!runId || !runDetail) throw new Error('请先执行这个 Workflow');
      const status = runDetail.status;
      if (action === 'pause' && status !== 'running') throw new Error(`当前 Run 是「${statusText(status)}」，只有运行中可以暂停`);
      if (action === 'resume' && status !== 'paused') throw new Error(`当前 Run 是「${statusText(status)}」，只有已暂停可以恢复`);
      const definitionJson = action === 'replan' && replanJson.trim() ? parseJson(replanJson, 'Replan 定义') : undefined;
      await request(`/api/workflow-runs/${runId}/${action}`, action === 'replan' ? { reason: replanReason.trim() || 'Human requested replan', definitionJson, resume: true } : {});
      await loadRun(runId); if (workflowId) await loadRuns(workflowId);
    }, action === 'execute' ? (mode === 'resume' ? '已从停下的 Agent 继续' : '已开始执行') : action === 'replan' ? 'Replan 已提交，Run 将自动继续' : `${action} 操作已提交`);
  }
  async function sendNodeChat(content: string) {
    const text = content.trim();
    if (!workflowId || !chatNodeKey) return false;
    if (!text) { setChatError('请先写一句指导'); return false; }
    setChatError('');
    try {
      await request(`/api/workflows/${workflowId}/nodes/${encodeURIComponent(chatNodeKey)}/messages`, { content: text });
      setChatTick((value) => value + 1);
      return true;
    } catch (cause) {
      setChatError(cause instanceof Error ? cause.message : '发送失败');
      return false;
    }
  }
  async function stopNodeChat() {
    if (!workflowId || !chatNodeKey) return;
    setChatError('');
    try {
      await request(`/api/workflows/${workflowId}/nodes/${encodeURIComponent(chatNodeKey)}/messages/stop`, {});
      setChatTick((value) => value + 1);
    } catch (cause) {
      setChatError(cause instanceof Error ? cause.message : '打断失败');
    }
  }
  async function resolveDecision(
    id: Id,
    action: 'approve' | 'return' | 'reject',
    options?: {
      decision?: string;
      reviews?: Array<{ key: string; name: string; note: string; action?: string }>;
      targetKey?: string;
    },
  ) {
    await act(`decision-${id}`, async () => {
      const current = decisions.find((item) => item.id === id);
      const context = current?.contextJson && typeof current.contextJson === 'object' ? current.contextJson as Record<string, unknown> : {};
      const acceptance = context.kind === 'acceptance';
      const reviews = options?.reviews?.filter((item) => item.key && item.note.trim()) ?? [];
      const typed = (options?.decision ?? decisionText[id] ?? '').trim()
        || reviews.map((item) => `【${item.name || item.key}】${item.note.trim()}`).join('\n');
      // 不合格待确认：系统已有判定原因；批准继续可不填，退回默认用原判定说明
      const acceptanceFallback = acceptance
        ? (typeof current?.question === 'string' && current.question.trim()
          ? current.question.trim()
          : action === 'approve' ? '人工批准：同意继续。' : action === 'return' ? '按原判定退回重做。' : '人工拒绝。')
        : '';
      const decision = typed
        || acceptanceFallback
        || (action === 'approve' && !acceptance ? '批准' : '');
      if (!acceptance && action === 'return' && decision.length < 2) throw new Error('退回时请写清楚哪里有问题、怎么改');
      if (action === 'return' && !acceptance && reviews.length === 0) throw new Error('请选择要退回的上游节点并填写说明');
      if (!acceptance && action === 'reject' && decision.length < 2) throw new Error('拒绝时请填写说明');
      if (!acceptance && action === 'approve' && !decision) throw new Error('批准失败，请重试');
      const nodeKey = typeof context.checkerKey === 'string' ? context.checkerKey : typeof context.key === 'string' ? context.key : '';
      // 先清掉面板上的「待确认」，并把说明写入本地历史，再等服务端续跑
      setDecisions((rows) => rows.map((item) => item.id === id ? {
        ...item,
        decision,
        action: action === 'return' ? 'request_changes' : action,
        status: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'changes_requested',
        resolvedAt: new Date().toISOString(),
        contextJson: {
          ...context,
          ...(reviews.length ? { reviews } : {}),
          ...(options?.targetKey ? { targetKey: options.targetKey } : {}),
        },
      } : item));
      if (nodeKey) {
        setLiveProgress((value) => {
          const next = { ...(value ?? nodeProgress(runDetail?.tasks)) };
          if (next[nodeKey] === 'awaiting_decision') {
            next[nodeKey] = action === 'reject' ? 'failed' : action === 'return' ? 'blocked' : 'pending';
          }
          return next;
        });
      }
      if (acceptance && nodeKey) {
        setLiveChecks((value) => {
          const next = { ...(value ?? nodeChecks(runDetail?.tasks, runDetail?.events)) };
          if (action === 'approve') {
            const previous = next[nodeKey];
            const history = [...(previous?.history ?? [])];
            if (previous?.verdict === 'reject') history.push({ verdict: previous.verdict, label: previous.label, detail: previous.detail, at: previous.at });
            next[nodeKey] = { verdict: 'pass', label: '合格', detail: decision, history };
          } else delete next[nodeKey];
          return next;
        });
      }
      await request(`/api/decisions/${id}/resolve`, {
        decision,
        action,
        ...(reviews.length ? { reviews } : {}),
      });
      await loadProject(requireProject());
      if (runId) await loadRun(runId);
      setLiveChecks(null);
      setLiveProgress(null);
      setLiveFailures(null);
    }, action === 'approve' ? '已批准，继续执行' : action === 'return' ? '已退回指定上游，说明已交给对应 Agent' : '已拒绝，流程停止');
  }

  const overview = <div className="view-stack">
    <SectionTitle eyebrow="Projects" title="项目列表" action={<button type="button" onClick={() => { setProjectName(''); setCreateDialog('project'); }}>创建项目</button>} />
    <section className="panel">
      {projects.length ? <>
        <div className="project-table-head"><span>项目名称</span><span>Workflow</span><span>创建时间</span><span>操作</span></div>
        {projects.map((item) => <div className="project-table-row" key={item.id}>
          <span>{item.name}</span>
          <button type="button" className="linkish" onClick={() => openProjectWorkflows(item)}>{item.workflowCount ?? 0}</button>
          <small>{date(item.createdAt)}</small>
          <button type="button" onClick={() => setProjectDraft({ id: item.id, name: item.name })}>编辑</button>
        </div>)}
      </> : <div className="welcome-empty"><Empty>请先创建项目</Empty><p className="muted">还没有项目。点击右上角「创建项目」后，这里会列出全部项目。</p></div>}
    </section>
    {createDialog === 'project' ? <Modal title="创建项目" onClose={() => setCreateDialog(null)}>
      <form className="form" onSubmit={createProject}>
        <Field label="项目名称" hint="用于区分不同业务空间。"><input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="例如 产品调研" autoFocus /></Field>
        <div className="run-controls"><button type="submit">创建</button><button type="button" onClick={() => setCreateDialog(null)}>取消</button></div>
      </form>
    </Modal> : null}
    {projectDraft ? <Modal title="编辑项目" onClose={() => setProjectDraft(null)}>
      <form className="form" onSubmit={saveProject}>
        <Field label="项目名称" hint="修改后只影响显示名称。"><input value={projectDraft.name} onChange={(e) => setProjectDraft({ ...projectDraft, name: e.target.value })} autoFocus /></Field>
        <div className="run-controls"><button type="submit">保存</button><button type="button" onClick={() => setProjectDraft(null)}>取消</button></div>
      </form>
    </Modal> : null}
  </div>;

  const modelsView = <div className="view-stack">
    <SectionTitle title="模型管理" action={<div className="run-controls"><button type="button" onClick={() => { setCatalogForm((value) => ({ ...value, providerName: '', providerType: 'openai', baseUrl: '', apiKey: '' })); setCreateDialog('provider'); }}>创建 Provider</button><button type="button" onClick={openCreateModel}>创建模型</button></div>} />
    <section className="panel"><h3>已有 Provider</h3>{providers.length ? providers.map((item) => <div className="data-row" key={item.id}><span>#{item.id} {item.name}</span><small>{item.type} · {item.baseUrl || '未填写 API 地址'} · {item.apiKeySet ? `API Key ${item.apiKeyMasked || '已配置'}` : '未配置 API Key'}</small><button type="button" onClick={() => setProviderDraft({ id: item.id, name: item.name, type: item.type, baseUrl: item.baseUrl ?? '', apiKey: '', apiKeySet: Boolean(item.apiKeySet), apiKeyMasked: item.apiKeyMasked ?? '' })}>编辑</button></div>) : <Empty>还没有 Provider。点击右上角「创建 Provider」添加。</Empty>}</section>
    <section className="panel"><h3>模型列表</h3>{models.length ? models.map((item) => {
      const provider = providers.find((row) => row.id === item.providerId);
      return <div className="data-row" key={item.id}><span>#{item.id} {item.displayName}</span><small>{item.name} · {provider?.name ?? '未知 Provider'} · {provider?.baseUrl || '未填写 API 地址'}</small><button type="button" onClick={() => setModelDraft({ id: item.id, providerId: String(item.providerId), name: item.name, displayName: item.displayName, baseUrl: provider?.baseUrl ?? '' })}>编辑</button></div>;
    }) : <Empty>还没有模型。点击右上角「创建模型」添加。</Empty>}</section>
    {createDialog === 'provider' ? <Modal title="新增 Provider" onClose={() => setCreateDialog(null)}>
      <form className="form" onSubmit={createProvider}>
        <Field label="名称" hint="自己起的名字，用来在列表里区分，例如 MiniMax。"><input value={catalogForm.providerName} onChange={(e) => setCatalogForm({ ...catalogForm, providerName: e.target.value })} placeholder="例如 MiniMax" /></Field>
        <Field label="类型" hint="模型厂商类型，要和 Pi 能识别的厂商一致，例如 openai、anthropic、minimax。"><input value={catalogForm.providerType} onChange={(e) => setCatalogForm({ ...catalogForm, providerType: e.target.value })} placeholder="例如 openai" /></Field>
        <Field label="API 访问地址" hint="该厂商接口的根地址，例如 https://api.minimaxi.com/v1。同一 Provider 下的模型共用这个地址。官方默认地址可以留空。"><input value={catalogForm.baseUrl} onChange={(e) => setCatalogForm({ ...catalogForm, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
        <Field label="API Key" hint="必填。执行时会作为 --api-key 传给 Pi，同一 Provider 下的模型共用。"><input type="password" autoComplete="off" value={catalogForm.apiKey} onChange={(e) => setCatalogForm({ ...catalogForm, apiKey: e.target.value })} placeholder="粘贴厂商发放的 API Key" /></Field>
        <div className="run-controls"><button>创建 Provider</button><button type="button" onClick={() => setCreateDialog(null)}>取消</button></div>
      </form>
    </Modal> : null}
    {providerDraft ? <Modal title="编辑 Provider" onClose={() => setProviderDraft(null)}>
      <form className="form" onSubmit={saveProvider}>
        <Field label="名称" hint="自己起的名字，用来在列表里区分，例如 MiniMax。"><input value={providerDraft.name} onChange={(e) => setProviderDraft({ ...providerDraft, name: e.target.value })} /></Field>
        <Field label="类型" hint="模型厂商类型，要和 Pi 能识别的厂商一致，例如 openai、anthropic、minimax。"><input value={providerDraft.type} onChange={(e) => setProviderDraft({ ...providerDraft, type: e.target.value })} /></Field>
        <Field label="API 访问地址" hint="该厂商接口的根地址。留空表示使用厂商默认地址。同一 Provider 下的模型共用这个地址。"><input value={providerDraft.baseUrl} onChange={(e) => setProviderDraft({ ...providerDraft, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
        <Field label="API Key" hint={providerDraft.apiKeySet ? `已配置：${providerDraft.apiKeyMasked || '********'}。留空表示保持不变；填写新值则覆盖。` : '必填。执行时会作为 --api-key 传给 Pi。'}><input type="password" autoComplete="off" value={providerDraft.apiKey} onChange={(e) => setProviderDraft({ ...providerDraft, apiKey: e.target.value })} placeholder={providerDraft.apiKeySet ? '留空保持原 Key，或粘贴新 Key' : '粘贴厂商发放的 API Key'} /></Field>
        <div className="run-controls"><button type="submit">保存</button><button type="button" onClick={() => setProviderDraft(null)}>取消</button></div>
      </form>
    </Modal> : null}
    {createDialog === 'model' ? <Modal title="新增模型" onClose={() => setCreateDialog(null)}>
      <form className="form" onSubmit={createModel}>
        <Field label="Provider" hint="这个模型属于哪个厂商。还没有的话，先创建 Provider。"><select value={providerChoice} onChange={(e) => { const nextProvider = e.target.value; setProviderChoice(nextProvider); setCatalogForm((value) => ({ ...value, baseUrl: providerBaseUrl(nextProvider) })); }}><option value="">请选择 Provider</option>{providers.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.type}</option>)}</select></Field>
        <Field label="API 访问地址" hint="选择 Provider 后会自动带入其 API 地址，可再修改。会保存到所选 Provider，同一 Provider 下的模型共用。官方默认地址可以留空。"><input value={catalogForm.baseUrl} onChange={(e) => setCatalogForm({ ...catalogForm, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
        <Field label="模型标识" hint="调用时传给 Pi 的模型名，必须和厂商侧的模型 ID 一致，例如 MiniMax-M3。"><input value={catalogForm.modelName} onChange={(e) => setCatalogForm({ ...catalogForm, modelName: e.target.value })} placeholder="例如 MiniMax-M3" /></Field>
        <Field label="显示名称" hint="只在控制台里展示。留空时会直接用模型标识。"><input value={catalogForm.displayName} onChange={(e) => setCatalogForm({ ...catalogForm, displayName: e.target.value })} placeholder="例如 MiniMax M3" /></Field>
        <div className="run-controls"><button>创建模型</button><button type="button" onClick={() => setCreateDialog(null)}>取消</button></div>
      </form>
    </Modal> : null}
    {modelDraft ? <Modal title="编辑模型" onClose={() => setModelDraft(null)}>
      <form className="form" onSubmit={saveModel}>
        <Field label="Provider" hint="更换后，API 地址会改写到新的 Provider。"><select value={modelDraft.providerId} onChange={(e) => { const providerId = e.target.value; setModelDraft({ ...modelDraft, providerId, baseUrl: providerBaseUrl(providerId) }); }}>{providers.map((row) => <option value={row.id} key={row.id}>{row.name} · {row.type}</option>)}</select></Field>
        <Field label="API 访问地址" hint="留空表示使用厂商默认地址。同一 Provider 下的模型共用这个地址。"><input value={modelDraft.baseUrl} onChange={(e) => setModelDraft({ ...modelDraft, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
        <Field label="模型标识" hint="调用时使用的模型 ID。"><input value={modelDraft.name} onChange={(e) => setModelDraft({ ...modelDraft, name: e.target.value })} /></Field>
        <Field label="显示名称" hint="只在控制台里展示。"><input value={modelDraft.displayName} onChange={(e) => setModelDraft({ ...modelDraft, displayName: e.target.value })} /></Field>
        <div className="run-controls"><button type="submit">保存</button><button type="button" onClick={() => setModelDraft(null)}>取消</button></div>
      </form>
    </Modal> : null}
  </div>;

  const skillsView = <div className="view-stack">
    <SectionTitle title="Skill 目录" action={<button type="button" onClick={() => { setSkillUpload(null); setSkillDialog(true); }}>新增自定义 Skill</button>} />
    <p className="muted">租户级 Skill，Workflow 节点可勾选。支持粘贴 SKILL.md，或导入含 scripts 的 zip Skill 包。自定义包统一放在本机 ~/.orvia/skills/ 下，按标识分目录，方便查找维护。系统内置不可删除。</p>
    <section className="panel"><h3>已有 Skill</h3>{skills.length ? skills.map((item) => {
      const tools = toolsAllowText(item.toolsJson);
      const isBuiltin = item.kind === 'builtin';
      const kindLabel = isBuiltin ? '系统内置' : '自定义';
      const pkg = skillPackageMeta(item.configJson);
      return <div className="data-row" key={item.id}><span><strong>{item.name}</strong><small>类型：{kindLabel} · {item.key}{pkg.source === 'package' ? ` · 包 ${pkg.files.length} 个文件` : ''}{tools ? ` · tools ${tools}` : ''}{item.description ? ` · ${item.description}` : ''}</small></span><div className="run-controls"><span className={`badge ${isBuiltin ? 'published' : 'draft'}`}>{kindLabel}</span><button type="button" onClick={() => { setSkillDraftUpload(null); setSkillDraft({ id: item.id, key: item.key, name: item.name, description: item.description ?? '', kind: isBuiltin ? 'builtin' : 'custom', contentMd: item.contentMd ?? '', toolsAllow: tools, files: pkg.files, source: pkg.source }); }}>编辑</button>{isBuiltin ? null : <button type="button" className="danger" onClick={() => void deleteSkill(item.id)}>删除</button>}</div></div>;
    }) : <Empty>还没有 Skill。启动后会自动写入系统内置「网络访问」。</Empty>}</section>
    {skillDialog ? <Modal title="新增自定义 Skill" onClose={() => { setSkillDialog(false); setSkillUpload(null); }}>
      <form className="form" onSubmit={createSkill}>
        <Field label="类型"><input value="自定义" disabled /></Field>
        <Field label="导入方式" hint="可手写 SKILL.md，也可上传单个 Markdown，或导入包含 scripts/references 的 zip 包。">
          <select value={skillForm.source} onChange={(e) => { const source = e.target.value === 'upload' ? 'upload' : 'markdown'; setSkillForm({ ...skillForm, source }); if (source === 'markdown') setSkillUpload(null); }}>
            <option value="markdown">粘贴 / 编写 SKILL.md</option>
            <option value="upload">导入 Skill 包或 MD 文件</option>
          </select>
        </Field>
        <Field label="标识" hint="小写英文、数字和下划线，例如 my_research。创建后不能改。"><input value={skillForm.key} onChange={(e) => setSkillForm({ ...skillForm, key: e.target.value })} placeholder="例如 my_research" /></Field>
        <Field label="中文名称" hint="在 Agent 勾选列表里显示的名字。导入包时可先填，也可留空后用 frontmatter 的 name。"><input value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} placeholder="例如 调研助手" /></Field>
        <Field label="说明" hint="给人看的一句话。"><input value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} placeholder="例如按步骤做公开资料调研" /></Field>
        <Field label="开启的工具" hint="逗号分隔的 Pi 工具名。含脚本的包通常需要 bash。"><input value={skillForm.toolsAllow} onChange={(e) => setSkillForm({ ...skillForm, toolsAllow: e.target.value })} placeholder="bash" /></Field>
        {skillForm.source === 'upload' ? <Field label="Skill 包 / MD 文件" hint="推荐 zip：内含 SKILL.md，以及 scripts、references、assets 等。也支持只上传 SKILL.md。"><input type="file" accept=".zip,.md,.markdown,application/zip,text/markdown" onChange={(e) => setSkillUpload(e.target.files?.[0] ?? null)} />{skillUpload ? <small className="field-hint">已选：{skillUpload.name}</small> : null}</Field> : <Field label="SKILL.md 内容" hint="符合 Agent Skills 规范的 Markdown，会通过 Pi 的 --skill 加载。"><textarea value={skillForm.contentMd} onChange={(e) => setSkillForm({ ...skillForm, contentMd: e.target.value })} rows={10} placeholder={'---\nname: my-research\ndescription: ...\n---\n\n# 说明\n'} /></Field>}
        <div className="run-controls"><button>保存</button><button type="button" onClick={() => { setSkillDialog(false); setSkillUpload(null); }}>取消</button></div>
      </form>
    </Modal> : null}
    {skillDraft ? <Modal title="编辑 Skill" onClose={() => { setSkillDraft(null); setSkillDraftUpload(null); }}>
      <form className="form" onSubmit={saveSkill}>
        <Field label="类型"><input value={skillDraft.kind === 'builtin' ? '系统内置' : '自定义'} disabled /></Field>
        <Field label="标识"><input value={skillDraft.key} disabled /></Field>
        {skillDraft.kind === 'builtin' ? <Field label="说明"><input value={skillDraft.description} onChange={(e) => setSkillDraft({ ...skillDraft, description: e.target.value })} /></Field> : <>
          <Field label="中文名称"><input value={skillDraft.name} onChange={(e) => setSkillDraft({ ...skillDraft, name: e.target.value })} /></Field>
          <Field label="说明"><input value={skillDraft.description} onChange={(e) => setSkillDraft({ ...skillDraft, description: e.target.value })} /></Field>
          <Field label="开启的工具"><input value={skillDraft.toolsAllow} onChange={(e) => setSkillDraft({ ...skillDraft, toolsAllow: e.target.value })} /></Field>
          {skillDraft.files.length ? <Field label="包内文件"><input value={skillDraft.files.join(', ')} disabled /></Field> : null}
          <Field label="重新导入包" hint="可选。上传新的 zip / md 会替换本地包（含脚本）。"><input type="file" accept=".zip,.md,.markdown,application/zip,text/markdown" onChange={(e) => setSkillDraftUpload(e.target.files?.[0] ?? null)} />{skillDraftUpload ? <small className="field-hint">已选：{skillDraftUpload.name}</small> : null}</Field>
          <Field label="SKILL.md 内容"><textarea value={skillDraft.contentMd} onChange={(e) => setSkillDraft({ ...skillDraft, contentMd: e.target.value })} rows={10} /></Field>
        </>}
        <div className="run-controls"><button type="submit">保存</button><button type="button" onClick={() => { setSkillDraft(null); setSkillDraftUpload(null); }}>取消</button></div>
      </form>
    </Modal> : null}
  </div>;

  const capabilitiesView = <div className="view-stack">
    <SectionTitle title="能力目录" action={<button type="button" onClick={() => setCapabilityDialog(true)}>新增能力</button>} />
    <p className="muted">Agent 能力管理，所有项目共用</p>
    <section className="panel"><h3>能力名称</h3>{capabilities.length ? capabilities.map((item) => <div className="data-row" key={item.id}><span>{item.name}</span><small>{item.key}{item.description ? ` · ${item.description}` : ''}</small><button type="button" onClick={() => setCapabilityDraft({ id: item.id, key: item.key, name: item.name, description: item.description ?? '' })}>编辑</button></div>) : <Empty>还没有能力。点击右上角「新增能力」。</Empty>}</section>
    {capabilityDialog ? <Modal title="新增能力" onClose={() => setCapabilityDialog(false)}>
      <form className="form" onSubmit={createCapability}>
        <Field label="标识" hint="稳定标识，只用小写英文、数字和下划线，并以字母开头。例如 code_review。创建后不能修改。"><input value={capabilityForm.key} onChange={(e) => setCapabilityForm({ ...capabilityForm, key: e.target.value })} placeholder="例如 code_review" /></Field>
        <Field label="中文名称" hint="在下拉里显示的名字，例如代码审查。"><input value={capabilityForm.name} onChange={(e) => setCapabilityForm({ ...capabilityForm, name: e.target.value })} placeholder="例如代码审查" /></Field>
        <Field label="说明" hint="给人读的一句话，不参与派发。可以留空。"><input value={capabilityForm.description} onChange={(e) => setCapabilityForm({ ...capabilityForm, description: e.target.value })} placeholder="例如检查改动是否可合并" /></Field>
        <div className="run-controls"><button>保存</button><button type="button" onClick={() => setCapabilityDialog(false)}>取消</button></div>
      </form>
    </Modal> : null}
    {capabilityDraft ? <Modal title="编辑能力" onClose={() => setCapabilityDraft(null)}>
      <form className="form" onSubmit={saveCapability}>
        <Field label="标识" hint="派发使用这个标识，创建后不能修改。"><input value={capabilityDraft.key} readOnly /></Field>
        <Field label="中文名称" hint="在下拉里显示的名字。"><input value={capabilityDraft.name} onChange={(e) => setCapabilityDraft({ ...capabilityDraft, name: e.target.value })} /></Field>
        <Field label="说明" hint="给人读的一句话，不参与派发。可以留空。"><input value={capabilityDraft.description} onChange={(e) => setCapabilityDraft({ ...capabilityDraft, description: e.target.value })} /></Field>
        <div className="run-controls"><button type="submit">保存</button><button type="button" onClick={() => setCapabilityDraft(null)}>取消</button></div>
      </form>
    </Modal> : null}
  </div>;

  const boardEvents = useMemo(() => {
    const persisted = runDetail?.events ?? [];
    const live = liveEvents.filter((event) => event.workflowRunId === runId);
    const byId = new Map<number, EventRow>();
    for (const event of persisted) byId.set(event.id, event);
    for (const event of live) byId.set(event.id, event);
    return [...byId.values()].sort((left, right) => {
      const leftTime = Date.parse(String(left.occurredAt ?? left.createdAt ?? '')) || 0;
      const rightTime = Date.parse(String(right.occurredAt ?? right.createdAt ?? '')) || 0;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return left.id - right.id;
    });
  }, [runDetail?.events, liveEvents, runId]);
  async function saveSystemSettings(event: FormEvent) {
    event.preventDefault();
    await act('system-settings-save', async () => {
      const body: Record<string, string> = {
        piCommand: settingsForm.piCommand.trim() || 'pi',
        mysqlHost: settingsForm.mysqlHost.trim(),
        mysqlPort: settingsForm.mysqlPort.trim(),
        mysqlUser: settingsForm.mysqlUser.trim(),
        mysqlDatabase: settingsForm.mysqlDatabase.trim(),
        redisHost: settingsForm.redisHost.trim(),
        redisPort: settingsForm.redisPort.trim(),
      };
      if (settingsForm.mysqlPassword.trim()) body.mysqlPassword = settingsForm.mysqlPassword;
      if (settingsForm.redisPassword.trim()) body.redisPassword = settingsForm.redisPassword;
      await request('/api/system/settings', body, 'PUT');
      await loadSystemSettings();
      setSettingsForm((current) => ({ ...current, mysqlPassword: '', redisPassword: '' }));
    }, '已保存到本机 .env；MySQL / Redis 请重启 API 后完全生效');
  }

  const settingsView = <div className="view-stack">
    <SectionTitle eyebrow="Local runtime" title="系统设置" action={<button type="button" onClick={() => void act('system-settings', async () => { await loadSystemSettings(); }, '系统状态已刷新')}>刷新状态</button>} />
    <p className="muted">连接地址和密钥只写入本机仓库根目录的 <code>.env</code>，不会进数据库，也不要提交到 Git。</p>
    {!settingsLoaded && !systemSettings ? <Empty>正在读取本机运行状态…</Empty> : <form className="settings-grid" onSubmit={(event) => void saveSystemSettings(event)}>
      <section className="panel">
        <div className="panel-head"><h3>Pi 运行状态</h3><Badge value={systemSettings?.pi.status === 'ok' ? 'ok' : 'error'} /></div>
        <p className="muted">{systemSettings?.pi.message || '尚未检测'}{systemSettings?.pi.version ? ` · ${systemSettings.pi.version}` : ''}</p>
        <Field label="Pi 命令" hint="API 启动 Pi 时使用的命令或绝对路径，默认 pi。"><input value={settingsForm.piCommand} onChange={(e) => setSettingsForm({ ...settingsForm, piCommand: e.target.value })} placeholder="pi" /></Field>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>MySQL 连接</h3><Badge value={systemSettings?.mysql.status === 'ok' ? 'ok' : 'error'} /></div>
        <p className="muted">{systemSettings?.mysql.message || '尚未检测'}{typeof systemSettings?.mysql.latencyMs === 'number' ? ` · ${systemSettings.mysql.latencyMs}ms` : ''}</p>
        <div className="form-grid-2">
          <Field label="地址" hint="本机或 Docker 映射的主机。"><input value={settingsForm.mysqlHost} onChange={(e) => setSettingsForm({ ...settingsForm, mysqlHost: e.target.value })} placeholder="127.0.0.1" /></Field>
          <Field label="端口"><input value={settingsForm.mysqlPort} onChange={(e) => setSettingsForm({ ...settingsForm, mysqlPort: e.target.value })} placeholder="3306" /></Field>
          <Field label="用户名"><input value={settingsForm.mysqlUser} onChange={(e) => setSettingsForm({ ...settingsForm, mysqlUser: e.target.value })} placeholder="root" /></Field>
          <Field label="数据库"><input value={settingsForm.mysqlDatabase} onChange={(e) => setSettingsForm({ ...settingsForm, mysqlDatabase: e.target.value })} placeholder="orvia" /></Field>
        </div>
        <Field label="密码 / 密钥" hint={systemSettings?.mysql.passwordSet ? `已保存（${systemSettings.mysql.passwordMasked}）。留空表示不改。` : '写入本机 .env 的 DATABASE_URL。'}><input type="password" value={settingsForm.mysqlPassword} onChange={(e) => setSettingsForm({ ...settingsForm, mysqlPassword: e.target.value })} placeholder={systemSettings?.mysql.passwordSet ? '已保存，留空不改' : 'MySQL 密码'} autoComplete="off" /></Field>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>Redis 连接</h3><Badge value={systemSettings?.redis.status === 'ok' ? 'ok' : 'error'} /></div>
        <p className="muted">{systemSettings?.redis.message || '尚未检测'}{typeof systemSettings?.redis.latencyMs === 'number' ? ` · ${systemSettings.redis.latencyMs}ms` : ''}{systemSettings?.redis.displayUrl ? ` · ${systemSettings.redis.displayUrl}` : ''}</p>
        <div className="form-grid-2">
          <Field label="地址" hint="本机或 Docker 映射的主机。"><input value={settingsForm.redisHost} onChange={(e) => setSettingsForm({ ...settingsForm, redisHost: e.target.value })} placeholder="127.0.0.1" /></Field>
          <Field label="端口"><input value={settingsForm.redisPort} onChange={(e) => setSettingsForm({ ...settingsForm, redisPort: e.target.value })} placeholder="6379" /></Field>
        </div>
        <Field label="密码 / 密钥" hint={systemSettings?.redis.passwordSet ? `已保存（${systemSettings.redis.passwordMasked}）。留空表示不改。` : '写入本机 .env 的 REDIS_URL。'}><input type="password" value={settingsForm.redisPassword} onChange={(e) => setSettingsForm({ ...settingsForm, redisPassword: e.target.value })} placeholder={systemSettings?.redis.passwordSet ? '已保存，留空不改' : 'Redis 密码'} autoComplete="off" /></Field>
      </section>
      <div className="run-controls"><button type="submit">保存到本机 .env</button></div>
    </form>}
  </div>;

  const filteredWorkflows = workflowProjectFilter
    ? workflows.filter((item) => String(item.projectId) === workflowProjectFilter)
    : workflows;

  const workflowsView = <div className="view-stack">
    <SectionTitle title="Workflow" action={<button type="button" onClick={openNewWorkflowDialog}>新建 Workflow</button>} />
    <section className="panel">
      <div className="panel-head">
        <h3>Workflow 列表</h3>
        {projects.length ? <label className="list-filter">项目<select value={workflowProjectFilter} onChange={(e) => setWorkflowProjectFilter(e.target.value)}><option value="">全部项目</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label> : null}
      </div>
      {!projects.length ? <Empty>请先创建项目，再新建 Workflow。</Empty> : filteredWorkflows.length ? <div className="workflow-table">
        <div className="workflow-table-head">
          <span>名称</span>
          <span>所属项目</span>
          <span>版本</span>
          <span>状态</span>
          <span>运行</span>
          <span>创建时间</span>
          <span>修改时间</span>
          <span>操作</span>
        </div>
        {filteredWorkflows.map((item) => <div className="workflow-table-row" key={item.id}>
          <span className="wf-col-name">{item.name}</span>
          <span className="wf-col-project">{item.projectName || projects.find((row) => row.id === item.projectId)?.name || '—'}</span>
          <span className="wf-col-version">{item.version}</span>
          <span className="wf-col-status"><Badge value={item.status} /></span>
          <span className="wf-col-run"><Badge value={item.runStatus || 'idle'} /></span>
          <span className="wf-col-time">{date(item.createdAt)}</span>
          <span className="wf-col-time">{date(item.updatedAt)}</span>
          <span className="wf-col-actions"><button type="button" onClick={() => void openWorkflowBoard(item.id)}>打开</button><button type="button" className="danger" onClick={() => void deleteWorkflow(item)}>删除</button></span>
        </div>)}
      </div> : <Empty>{workflows.length ? '当前项目下还没有 Workflow。' : '还没有 Workflow。点击右上角「新建 Workflow」。'}</Empty>}
    </section>
    {createDialog === 'workflow' ? <Modal title="新建 Workflow" onClose={() => setCreateDialog(null)}>
      <form className="form" onSubmit={(event) => void createWorkflowDraft(event)}>
        <Field label="所属项目" hint="这个 Workflow 会归到所选项目下，Overview 的项目列表也会按此统计。"><select value={newWorkflowProjectId} onChange={(e) => setNewWorkflowProjectId(e.target.value)} required><option value="">请选择项目</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>
        <div className="run-controls"><button type="submit">创建并打开</button><button type="button" onClick={() => setCreateDialog(null)}>取消</button></div>
      </form>
    </Modal> : null}
    {board && workflowId ? <WorkflowBoard key={workflowId} mode={board} name={workflowForm.name} version={workflowForm.version} versions={workflowVersions} currentVersionId={currentVersionId} nodes={workflowNodesForm} edges={workflowEdgesForm} loops={workflowLoops} capabilities={capabilities} skills={skills} providers={providers} models={models} events={boardEvents} progress={liveProgress ?? nodeProgress(runDetail?.tasks)} failures={liveFailures ?? nodeFailures(runDetail?.tasks)} checks={liveChecks ?? nodeChecks(runDetail?.tasks, boardEvents)} deliverables={liveDeliverables ?? nodeDeliverables(runDetail?.tasks)} reviewHistories={nodeReviewHistories(runDetail?.tasks)} runStatus={runDetail ? statusText(runDetail.status) : '未运行'} runStatusCode={runDetail?.status} onClose={() => void closeBoard()} onName={(name) => setWorkflowForm({ ...workflowForm, name })} onSelectVersion={(versionId) => void requestVersionSwitch(versionId)} onNodes={setWorkflowNodesForm} onEdges={setWorkflowEdgesForm} onLoops={setWorkflowLoops} onPersist={persistBoard} onPublish={() => void publishWorkflow()} onExecute={() => void runAction('execute')} onStop={stopRun} directory={workflowDirectory} decisions={decisions.filter((item) => item.workflowRunId === runId && item.status !== 'superseded')} decisionNotes={decisionText} onDecisionNote={(id, text) => setDecisionText({ ...decisionText, [id]: text })} onResolveDecision={(id, action, options) => void resolveDecision(id, action, options)} onOpenDirectory={async () => { if (!workflowId) return; try { const opened = await request<{ root: string }>(`/api/workflows/${workflowId}/open`, {}); setWorkflowDirectory(opened.root); setNotice('已在访达中打开主目录'); } catch (cause) { fail(cause, '目录打开失败'); } }} onOpenDeliverable={async (directory) => { if (!workflowId) return; try { await request(`/api/workflows/${workflowId}/open`, { directory }); setNotice('已在访达中打开交付物目录'); } catch (cause) { fail(cause, '目录打开失败'); } }} onLoadSummary={async () => { if (!runId) throw new Error('还没有执行记录'); return request<{ nodes: SummaryNode[] }>(`/api/workflow-runs/${runId}/summary`); }} onReadFile={async (filePath) => { if (!workflowId) throw new Error('请先打开 Workflow'); return request<{ name: string; text?: string; binary?: boolean; path?: string }>(`/api/workflows/${workflowId}/file?path=${encodeURIComponent(filePath)}`); }} onListFiles={() => request<{ directory: string; files: { name: string; size: number }[] }>(`/api/workflows/${workflowId}/files`)} onUploadFile={async (file) => { const response = await fetch(`${API_URL}/api/workflows/${workflowId}/files`, { method: 'POST', headers: { ...authHeaders(), 'x-orvia-filename': encodeURIComponent(file.name) }, body: file }); if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; throw new Error(data.error ?? '上传失败'); } }} onDeleteFile={(name) => request(`/api/workflows/${workflowId}/files?name=${encodeURIComponent(name)}`, undefined, 'DELETE').then(() => undefined)} chatNode={chatNodeKey ? workflowNodesForm.find((node) => node.key === chatNodeKey) ?? null : null} chatMessages={nodeMessages} chatError={chatError} onOpenChat={(key) => { setChatError(''); setChatNodeKey(key); }} onCloseChat={() => { setChatNodeKey(null); setChatError(''); }} onSendChat={sendNodeChat} onStopChat={stopNodeChat} /> : null}
  </div>;

  const views: Record<View, React.ReactNode> = { overview, models: modelsView, capabilities: capabilitiesView, skills: skillsView, workflows: workflowsView, settings: settingsView };

  return <main className="app-shell">
    <aside className="sidebar"><div className="brand"><span>O</span><div><strong>ORVIA</strong></div></div><nav aria-label="主导航">{NAV.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><i>{item.icon}</i>{item.label}{item.id === 'workflows' && pendingDecisions.length > 0 && <em>{pendingDecisions.length}</em>}</button>)}</nav></aside>
    <div className="workspace"><header className="topbar"><div className="topbar-title">{view === 'overview' ? <><h1>Overview(v3.0)</h1><p className="topbar-desc">Orvia 是多 Agent 协作编排平台，让复杂任务可拆、可并行、可把控。</p></> : <h1>{NAV.find((item) => item.id === view)?.label}</h1>}</div><div className="toolbar"><button className="icon-button" onClick={() => void act('refresh', refresh, '数据已刷新')} aria-label="刷新">↻</button></div></header>
      <div className="feedback" aria-live="polite">{state === 'loading' && <div className="loading"><i />正在载入数据…</div>}{error && <div className="alert"><b>请求失败</b><span>{error}</span><button onClick={() => setError('')} aria-label="关闭">×</button></div>}{notice && <div className="notice">{notice}<button onClick={() => setNotice('')} aria-label="关闭">×</button></div>}</div>
      <div className="view">{views[view]}</div>
    </div>
    {versionSwitchPrompt ? <div className="modal-backdrop" onMouseDown={() => setVersionSwitchPrompt(null)}>
      <div className="modal panel" role="dialog" aria-modal="true" aria-label="切换历史版本" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-head"><h3>切换历史版本</h3><button type="button" onClick={() => setVersionSwitchPrompt(null)}>关闭</button></div>
        <p>当前有未发布的修改。直接切换到 {workflowVersions.find((item) => item.id === versionSwitchPrompt)?.version ?? '历史版本'} 会丢失这些改动；也可以先发布成新版本再切换。</p>
        <div className="run-controls">
          <button type="button" onClick={() => void (async () => {
            const target = versionSwitchPrompt;
            setVersionSwitchPrompt(null);
            if (!target) return;
            const published = await publishWorkflow('已发布当前修改');
            if (!published) return;
            await act('version-switch', async () => { await applyVersionSwitch(target); }, '已发布并切换版本');
          })()}>发布并切换</button>
          <button type="button" className="danger" onClick={() => void act('version-switch-direct', async () => {
            const target = versionSwitchPrompt;
            setVersionSwitchPrompt(null);
            if (!target) return;
            await applyVersionSwitch(target);
          }, '已直接切换，未发布的修改已丢弃')}>直接切换</button>
          <button type="button" onClick={() => setVersionSwitchPrompt(null)}>取消</button>
        </div>
      </div>
    </div> : null}
    {executePrompt ? <div className="modal-backdrop execute-prompt" onMouseDown={() => setExecutePrompt(false)}>
      <div className="modal panel" role="dialog" aria-modal="true" aria-label="再次执行" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-head"><h3>再次执行</h3><button type="button" onClick={() => setExecutePrompt(false)}>关闭</button></div>
        <p>这个 Workflow 已经执行过。可以从头再跑一遍，也可以从当前停下的 Agent 接着做。</p>
        <p className="muted">{continuationSummary(workflowNodesForm, workflowEdgesForm, runDetail?.tasks)}</p>
        <div className="run-controls">
          <button type="button" onClick={() => void runAction('execute', 'restart')}>从头开始</button>
          <button
            type="button"
            disabled={Boolean(runDetail?.tasks?.some((task) => task.status === 'awaiting_decision')) || pendingDecisions.some((item) => item.workflowRunId === runId)}
            onClick={() => void runAction('execute', 'resume')}
          >从当前暂停的 Agent 继续</button>
        </div>
      </div>
    </div> : null}
  </main>;
}

function EventList({ events }: { events: EventRow[] }) {
  if (!events.length) return <Empty>暂无事件</Empty>;
  return <div className="events">{events.map((event, index) => <details key={`${event.id}-${index}`}><summary><span className="event-dot" /><b>{event.type}</b><small>{date(event.occurredAt ?? event.createdAt)}</small></summary><Json value={event.payload ?? event.payloadJson} /></details>)}</div>;
}
