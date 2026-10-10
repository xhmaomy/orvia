'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { beijingDateTime } from '../lib/beijing-time';
import { WorkflowBoard, graphFromStored, type NodeCheck, type SummaryNode } from './WorkflowBoard';

type Id = number;
type Project = { id: Id; name: string; description?: string | null };
type Provider = { id: Id; name: string; type: string; baseUrl?: string | null };
type Model = { id: Id; providerId: Id; name: string; displayName: string };
type Agent = { id: Id; name: string; description?: string; capabilitiesJson?: unknown; workflowId?: number | null };
type CapabilityRow = { id: Id; projectId: Id; key: string; name: string; description?: string | null };
type WorkflowNodeDraft = { key: string; name: string; type: 'task' | 'checkpoint' | 'start' | 'end'; capabilities: string[]; question: string; instruction: string; outputRequirement: string; acceptanceRule: string; maxRedos: number; requirement: string; x: number; y: number; w: number; h: number };
type WorkflowLoop = { key: string; nodeKeys: string[]; maxIterations: number };
type AgentVersion = { id: Id; agentId: Id; modelId: Id; version: string; role: string; mission?: string };
type Workflow = { id: Id; name: string; version: string; status: string; runStatus?: string | null; definitionJson?: unknown };
type Run = { id: Id; workflowId: Id; status: string; currentPlanVersion?: number; startedAt?: string; completedAt?: string; errorJson?: unknown };
type EventRow = { id: Id; type: string; payloadJson?: unknown; payload?: unknown; createdAt?: string; occurredAt?: string; workflowRunId?: Id };
type Center = { counts: Record<string, number>; recentEvents: EventRow[] };
type Decision = { id: Id; workflowRunId?: Id; checkpointId?: Id; question: string; status: string; contextJson?: unknown; createdAt?: string };
type Checkpoint = { id: Id; workflowRunId: Id; title: string; instructions?: string; status: string; contextJson?: unknown };
type RunDetail = Run & { plans: AnyRow[]; tasks: AnyRow[]; sessions: AnyRow[]; checkpoints: Checkpoint[]; decisions: Decision[]; events: EventRow[] };
type AnyRow = Record<string, unknown> & { id: Id; status?: string; name?: string };
type View = 'overview' | 'models' | 'agents' | 'capabilities' | 'workflows';
type LoadState = 'loading' | 'ready' | 'error';
type TenantRow = { tenantId: number; name: string; slug?: string; role?: string };

const API_URL = process.env.NEXT_PUBLIC_ORVIA_API_URL ?? 'http://127.0.0.1:4100';
const PATHS: Record<View, string> = {
  overview: '/', models: '/models', agents: '/agents', capabilities: '/capabilities', workflows: '/workflows',
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
  { id: 'workflows', label: 'Workflow Builder', icon: '◇' },
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
const STATUS_LABELS: Record<string, string> = { pending: '待处理', running: '运行中', paused: '已暂停', awaiting_decision: '等待决策', completed: '已完成', failed: '失败', cancelled: '已停止', approved: '已批准', rejected: '已拒绝', changes_requested: '需修改' };
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
    if (key) latest.set(key, task);
  }
  if (nodes.some((node) => !latest.has(node.key))) return 'Agent 已经改过，不能从暂停处继续。点「从头开始」会按现在的 Agent 再跑一遍。';
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
    if (!task.status) continue;
    const input = task.inputJson;
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const key = typeof record.key === 'string' ? record.key : '';
    if (key) progress[key] = task.status;
  }
  return progress;
}
function nodeChecks(tasks: AnyRow[] | undefined): Record<string, NodeCheck> {
  const checks: Record<string, NodeCheck> = {};
  for (const task of [...(tasks ?? [])].sort((left, right) => left.id - right.id)) {
    const input = task.inputJson;
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const key = typeof record.key === 'string' ? record.key : '';
    if (!key) continue;
    const result = record.acceptanceResult;
    const saved = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    const verdict = saved.verdict === 'pass' || saved.verdict === 'reject' || saved.verdict === 'unclear' ? saved.verdict : null;
    const label = typeof saved.label === 'string' ? saved.label : '';
    const detail = typeof saved.detail === 'string' ? saved.detail : '';
    if (verdict && label) checks[key] = { verdict, label, detail };
    else delete checks[key];
  }
  return checks;
}
function taskRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function nodeDeliverables(tasks: AnyRow[] | undefined): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const task of [...(tasks ?? [])].sort((left, right) => left.id - right.id)) {
    const input = taskRecord(task.inputJson);
    const key = typeof input.key === 'string' ? input.key : '';
    if (!key) continue;
    const output = taskRecord(task.outputJson);
    const fromOutput = typeof output.workspacePath === 'string' ? output.workspacePath : '';
    const fromInput = typeof input.workspacePath === 'string' ? input.workspacePath : '';
    const directory = fromOutput || fromInput;
    if (directory) paths[key] = directory;
  }
  return paths;
}
function sameDeliverables(left: Record<string, string>, right: Record<string, string>) {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
function sameChecks(left: Record<string, NodeCheck>, right: Record<string, NodeCheck>) {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key]?.verdict === right[key]?.verdict && left[key]?.label === right[key]?.label && left[key]?.detail === right[key]?.detail);
}

function Badge({ value }: { value: string }) { return <span className={`badge ${value}`}>{statusText(value)}</span>; }
function Empty({ children }: { children: React.ReactNode }) { return <div className="empty"><span>◇</span>{children}</div>; }
function Json({ value }: { value: unknown }) { return <pre className="json">{pretty(value)}</pre>; }
function SectionTitle({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <div className="section-title"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{action}</div>;
}
function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return <label>{label}{children}<small className="field-hint">{hint}</small></label>;
}
function capabilityKeysOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function CapabilityPicker({ label, hint, options, selected, onChange }: { label: string; hint: string; options: CapabilityRow[]; selected: string[]; onChange: (next: string[]) => void }) {
  const chosen = selected.map((key) => options.find((item) => item.key.toLowerCase() === key.toLowerCase()) ?? { key, name: key, description: null });
  const remaining = options.filter((item) => !selected.some((key) => key.toLowerCase() === item.key));
  return <div className="capability-picker">
    <label>{label}<select value="" onChange={(event) => { const key = event.target.value; if (key) onChange([...selected, key]); }}>
      <option value="">{options.length ? (remaining.length ? '请选择能力' : '目录里的能力都已选上') : '请先选择项目'}</option>
      {remaining.map((item) => <option value={item.key} key={item.key}>{item.name} · {item.key}</option>)}
    </select><small className="field-hint">{hint}</small></label>
    {chosen.length ? <div className="picked-list">{chosen.map((item) => <div className="picked-item" key={item.key}><span>{item.name}</span><small>{item.key}</small><button type="button" onClick={() => onChange(selected.filter((key) => key.toLowerCase() !== item.key.toLowerCase()))}>移除</button></div>)}</div> : null}
  </div>;
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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityRow[]>([]);
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState<Id | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<Id | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [liveProgress, setLiveProgress] = useState<Record<string, string> | null>(null);
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
  const [agentForm, setAgentForm] = useState({ name: '', capabilities: [] as string[], providerId: '', modelId: '', version: 'v1', role: '', mission: '' });
  const [versionForm, setVersionForm] = useState({ agentId: '', providerId: '', modelId: '', version: 'v1', role: '', mission: '' });
  const [catalogForm, setCatalogForm] = useState({ providerName: '', providerType: 'openai', baseUrl: '', modelName: '', displayName: '' });
  const [modelDraft, setModelDraft] = useState<{ id: Id; providerId: string; name: string; displayName: string; baseUrl: string } | null>(null);
  const [providerDraft, setProviderDraft] = useState<{ id: Id; name: string; type: string; baseUrl: string } | null>(null);
  const [agentDraft, setAgentDraft] = useState<{ id: Id; versionId: Id | null; name: string; capabilities: string[]; providerId: string; modelId: string; version: string; role: string; mission: string } | null>(null);
  const [createDialog, setCreateDialog] = useState<'provider' | 'model' | 'agent' | 'version' | null>(null);
  const [workflowForm, setWorkflowForm] = useState({ name: '', version: 'v1' });
  const [workflowNodesForm, setWorkflowNodesForm] = useState<WorkflowNodeDraft[]>([]);
  const [workflowEdgesForm, setWorkflowEdgesForm] = useState<{ source: string; target: string }[]>([]);
  const [workflowLoops, setWorkflowLoops] = useState<WorkflowLoop[]>([]);
  const [workflowDirectory, setWorkflowDirectory] = useState('');
  const [board, setBoard] = useState<'create' | 'view' | null>(null);
  const [capabilityForm, setCapabilityForm] = useState({ key: '', name: '', description: '' });
  const [capabilityDraft, setCapabilityDraft] = useState<{ id: Id; key: string; name: string; description: string } | null>(null);
  const [capabilityDialog, setCapabilityDialog] = useState(false);
  const [replanReason, setReplanReason] = useState('');
  const [replanJson, setReplanJson] = useState('');
  const [decisionText, setDecisionText] = useState<Record<number, string>>({});
  const [loginForm, setLoginForm] = useState({ email: 'admin@local.orvia', password: 'orvia-local' });
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenantId, setTenantId] = useState<Id | null>(null);

  const fail = useCallback((cause: unknown, fallback = '操作失败') => {
    setError(cause instanceof Error ? cause.message : fallback);
    setState('error');
  }, []);

  const loadGlobal = useCallback(async () => {
    const [projectRows, providerRows, modelRows, versionRows] = await Promise.all([
      list<Project>('/api/projects'), list<Provider>('/api/model-providers'), list<Model>('/api/models'), list<AgentVersion>('/api/agent-versions'),
    ]);
    setProjects(projectRows); setProviders(providerRows); setModels(modelRows); setVersions(versionRows);
  }, []);

  const loadProject = useCallback(async (id: Id) => {
    setState('loading'); setError('');
    try {
      const [agentRows, workflowRows, capabilityRows, dashboard, decisionRows] = await Promise.all([
        list<Agent>(`/api/agents?projectId=${id}`), list<Workflow>(`/api/workflows?projectId=${id}`), list<CapabilityRow>(`/api/capabilities?projectId=${id}`),
        request<Center>(`/api/control-center?projectId=${id}`), list<Decision>(`/api/decisions?projectId=${id}`),
      ]);
      setAgents(agentRows); setWorkflows(workflowRows); setCapabilities(capabilityRows); setCenter(dashboard); setDecisions(decisionRows);
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
    } catch (cause) { fail(cause, '运行详情加载失败'); }
  }, [fail]);
  useEffect(() => {
    const stored = window.sessionStorage.getItem('orvia.token') ?? '';
    const storedTenant = Number(window.sessionStorage.getItem('orvia.tenant') ?? '');
    apiToken = stored;
    apiTenantId = Number.isInteger(storedTenant) && storedTenant > 0 ? storedTenant : undefined;
    setToken(stored);
    setTenantId(apiTenantId ?? null);
  }, []);
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
  useEffect(() => { if (projectId) void loadProject(projectId); else setCapabilities([]); }, [projectId, loadProject]);
  const restoredProject = useRef(false);
  const restoredContext = useRef(false);
  const reopenStarted = useRef(false);
  useEffect(() => {
    if (restoredProject.current || !projects.length) return;
    restoredProject.current = true;
    const stored = Number(window.sessionStorage.getItem('orvia.project') ?? '');
    if (projects.some((item) => item.id === stored)) setProjectId(stored);
  }, [projects]);
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
  useEffect(() => {
    if (chatError !== '这个 Agent 正在回复，请稍候') return;
    const timer = window.setTimeout(() => setChatError((current) => (current === '这个 Agent 正在回复，请稍候' ? '' : current)), 3200);
    return () => window.clearTimeout(timer);
  }, [chatError]);
  useEffect(() => { setLiveProgress(null); setLiveChecks(null); setLiveDeliverables(null); progressSync.current = false; progressFloor.current = null; }, [runId]);
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
        const checks = nodeChecks(tasks);
        setLiveChecks((current) => {
          const baseline = current ?? nodeChecks(runDetail?.tasks);
          return sameChecks(baseline, checks) ? current : checks;
        });
        const deliverables = nodeDeliverables(tasks);
        setLiveDeliverables((current) => {
          const baseline = current ?? nodeDeliverables(runDetail?.tasks);
          return sameDeliverables(baseline, deliverables) ? current : deliverables;
        });
        const values = Object.values(next);
        const busy = values.some((status) => status === 'running' || status === 'pending' || status === 'paused');
        if (busy) {
          progressSync.current = false;
          setRunDetail((current) => current && current.status !== 'running' ? { ...current, status: 'running' } : current);
          return;
        }
        const settled = values.some((status) => status === 'failed' || status === 'awaiting_decision') || !values.some((status) => status === 'blocked');
        if (settled && !progressSync.current) {
          progressSync.current = true;
          void loadRun(runId);
        }
      } catch { /* 进度刷新失败时保留节点上一次的状态 */ }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [board, runId, loadRun, runDetail?.tasks]);

  useEffect(() => {
    if (!projectId) { setSse('idle'); return; }
    setSse('connecting');
    const tokenQuery = apiToken ? `&access_token=${encodeURIComponent(apiToken)}` : '';
    const remember = (event: EventRow) => {
      setLiveEvents((current) => current.some((item) => item.id === event.id) ? current : [event, ...current].slice(0, 100));
      const runEnded = event.type === 'workflow.completed' || event.type === 'workflow.stopped' || event.type === 'checkpoint.pending';
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

  const agentModels = agentForm.providerId ? models.filter((item) => item.providerId === Number(agentForm.providerId)) : models;
  const versionModels = versionForm.providerId ? models.filter((item) => item.providerId === Number(versionForm.providerId)) : models;
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
  function requireProject(): Id { if (!projectId) throw new Error('请先在顶部明确选择项目'); return projectId; }
  function parseJson(value: string, label: string): unknown { try { return JSON.parse(value); } catch { throw new Error(`${label} 不是有效 JSON`); } }

  async function createProvider(e: FormEvent) {
    e.preventDefault();
    await act('provider', async () => {
      if (!catalogForm.providerName.trim() || !catalogForm.providerType.trim()) throw new Error('请输入 Provider 名称与类型');
      const baseUrl = catalogForm.baseUrl.trim();
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('API 访问地址需要以 http:// 或 https:// 开头');
      const created = await request<{ id: Id }>('/api/model-providers', {
        name: catalogForm.providerName.trim(),
        type: catalogForm.providerType.trim(),
        baseUrl: catalogForm.baseUrl.trim() || undefined,
      });
      await loadGlobal(); setProviderChoice(String(created.id));
      setCatalogForm((value) => ({ ...value, providerName: '', baseUrl: '' }));
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
      await request(`/api/model-providers/${draft.id}`, { name: draft.name.trim(), type: draft.type.trim(), baseUrl }, 'PATCH');
      setProviderDraft(null);
      await loadGlobal();
    }, 'Provider 已更新');
  }
  async function createProject(e: FormEvent) {
    e.preventDefault();
    await act('project', async () => {
      if (!projectName.trim()) throw new Error('请输入项目名称');
      const created = await request<{ id: Id }>('/api/projects', { name: projectName.trim() });
      await loadGlobal(); setProjectId(created.id); setProjectName('');
    }, '项目已创建并选中');
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
  function requireCatalogModel(providerId: string, modelId: string) {
    if (!providers.length) throw new Error('还没有可用的 Provider，请先到「模型管理」创建');
    if (!providerId) throw new Error('请选择可用的 Provider');
    const provider = providers.find((item) => item.id === Number(providerId));
    if (!provider) throw new Error('所选 Provider 不存在，请到「模型管理」确认');
    const owned = models.filter((item) => item.providerId === provider.id);
    if (!modelId) throw new Error(owned.length ? '请选择该 Provider 下的 Model' : '这个 Provider 下还没有 Model，请先到「模型管理」创建');
    const model = models.find((item) => item.id === Number(modelId));
    if (!model || model.providerId !== provider.id) throw new Error('所选 Model 不属于所选 Provider');
    return model;
  }
  async function createAgentFrom(form: { name: string; capabilities: string[]; providerId: string; modelId: string; version: string; role: string; mission: string }) {
    return act('agent', async () => {
      const id = requireProject();
      if (!form.name.trim()) throw new Error('请输入 Agent 名称');
      const model = requireCatalogModel(form.providerId, form.modelId);
      const created = await request<{ id: Id }>('/api/agents', { projectId: id, name: form.name.trim(), capabilitiesJson: form.capabilities });
      await request('/api/agent-versions', { agentId: created.id, modelId: model.id, version: form.version.trim() || 'v1', role: form.role.trim() || form.name.trim(), mission: form.mission.trim() || undefined });
      await loadGlobal(); await loadProject(id);
      setAgentForm((value) => ({ ...value, name: '', capabilities: [], role: '', mission: '' }));
      setCreateDialog(null);
    }, 'Agent 已创建，并绑定了所选 Provider 的 Model');
  }
  async function createAgent(e: FormEvent) {
    e.preventDefault();
    await createAgentFrom(agentForm);
  }
  async function createVersion(e: FormEvent) {
    e.preventDefault();
    await act('version', async () => {
      if (!versionForm.agentId) throw new Error('请选择要增加版本的 Agent');
      const model = requireCatalogModel(versionForm.providerId, versionForm.modelId);
      const agent = agents.find((item) => item.id === Number(versionForm.agentId));
      await request('/api/agent-versions', { agentId: Number(versionForm.agentId), modelId: model.id, version: versionForm.version.trim() || 'v1', role: versionForm.role.trim() || agent?.name, mission: versionForm.mission.trim() || undefined });
      await loadGlobal(); setVersionForm((value) => ({ ...value, role: '', mission: '' }));
      setCreateDialog(null);
    }, 'Agent Version 已绑定');
  }
  async function saveAgentFrom(draft: { id: Id; versionId: Id | null; name: string; capabilities: string[]; providerId: string; modelId: string; version: string; role: string; mission: string }) {
    return act('agent-edit', async () => {
      if (!draft.name.trim()) throw new Error('请输入 Agent 名称');
      const model = requireCatalogModel(draft.providerId, draft.modelId);
      if (!draft.version.trim()) throw new Error('请填写版本号');
      if (!draft.role.trim()) throw new Error('请填写角色');
      await request(`/api/agents/${draft.id}`, { name: draft.name.trim(), capabilitiesJson: draft.capabilities }, 'PATCH');
      if (draft.versionId) {
        await request(`/api/agent-versions/${draft.versionId}`, { modelId: model.id, version: draft.version.trim(), role: draft.role.trim(), mission: draft.mission.trim() }, 'PATCH');
      } else {
        await request('/api/agent-versions', { agentId: draft.id, modelId: model.id, version: draft.version.trim(), role: draft.role.trim(), mission: draft.mission.trim() || undefined });
      }
      if (projectId) await loadProject(projectId);
      await loadGlobal();
      setAgentDraft(null);
    }, 'Agent 已更新');
  }
  async function saveAgent(e: FormEvent) {
    e.preventDefault();
    if (!agentDraft) return;
    await saveAgentFrom(agentDraft);
  }
  async function createCapability(e: FormEvent) {
    e.preventDefault();
    await act('capability', async () => {
      const id = requireProject();
      if (!capabilityForm.key.trim() || !capabilityForm.name.trim()) throw new Error('请填写能力标识和中文名称');
      await request('/api/capabilities', { projectId: id, key: capabilityForm.key.trim(), name: capabilityForm.name.trim(), description: capabilityForm.description.trim() });
      await loadProject(id);
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
      if (projectId) await loadProject(projectId);
      setCapabilityDraft(null);
    }, '能力已更新');
  }
  function capabilityName(key: string) {
    return capabilities.find((item) => item.key === key.toLowerCase())?.name ?? key;
  }
  function workflowDefinition(nextNodes = workflowNodesForm, nextEdges = workflowEdgesForm, nextLoops = workflowLoops) {
    return {
      nodes: nextNodes.map((node) => ({
        key: node.key,
        name: node.name.trim(),
        type: node.type,
        capabilities: node.type === 'start' || node.type === 'end' ? [] : node.capabilities,
        capability: node.capabilities[0] ?? '',
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
        ...(node.instruction.trim() ? { instruction: node.instruction.trim() } : {}),
        ...(node.type !== 'start' && node.type !== 'end' && node.outputRequirement.trim() ? { outputRequirement: node.outputRequirement.trim() } : {}),
        ...(node.type === 'task' && node.acceptanceRule.trim() ? { acceptanceRule: node.acceptanceRule.trim(), maxRedos: node.maxRedos >= 1 ? node.maxRedos : 3 } : {}),
        ...(node.type === 'start' ? { requirement: node.requirement } : {}),
        ...(node.type === 'checkpoint' && node.question.trim() ? { question: node.question.trim() } : {}),
      })),
      edges: nextEdges.filter((edge) => edge.source && edge.target),
      loops: nextLoops,
    };
  }
  async function persistBoard(nextNodes: WorkflowNodeDraft[], nextEdges: { source: string; target: string }[], silent = false, nextLoops = workflowLoops) {
    const save = async () => {
      if (!workflowId) throw new Error('请先新建 Workflow');
      if (runDetail?.workflowId === workflowId && runDetail.status === 'running') throw new Error('请先停止 Run，再编辑 Agent');
      const current = workflows.find((item) => item.id === workflowId);
      await request(`/api/workflows/${workflowId}`, {
        name: workflowForm.name.trim() || current?.name || '未命名 Workflow',
        version: workflowForm.version.trim() || current?.version || 'v1',
        status: current?.status === 'published' ? 'published' : 'draft',
        definitionJson: workflowDefinition(nextNodes, nextEdges, nextLoops),
      }, 'PATCH');
      setWorkflowNodesForm(nextNodes);
      setWorkflowEdgesForm(nextEdges);
      setWorkflowLoops(nextLoops);
    };
    if (silent) {
      if (inflight.current) return false;
      inflight.current = true;
      try { await save(); return true; } catch (cause) { fail(cause); return false; } finally { inflight.current = false; }
    }
    return act('save-node', save, 'Agent 已保存');
  }
  async function publishWorkflow() {
    await act('workflow', async () => {
      const id = requireProject();
      if (!workflowId) throw new Error('请先新建 Workflow');
      if (!workflowForm.name.trim()) throw new Error('请输入 Workflow 名称');
      if (!workflowNodesForm.some((node) => node.type === 'task')) throw new Error('请至少添加一个 Agent 节点');
      for (const node of workflowNodesForm) {
        if (!node.name.trim()) throw new Error('请填写每个名称');
        if (node.type !== 'start' && node.type !== 'end' && !node.capabilities.length) throw new Error(`请为 Agent「${node.name.trim() || '未命名 Agent'}」选择能力`);
      }
      await request(`/api/workflows/${workflowId}`, {
        name: workflowForm.name.trim(),
        version: workflowForm.version.trim() || 'v1',
        status: 'published',
        definitionJson: workflowDefinition(),
      }, 'PATCH');
      await loadProject(id);
      setWorkflowId(workflowId);
      setBoard('view');
    }, 'Workflow 已发布');
  }
  async function openWorkflowBoard(id: Id, preferredRunId?: Id | null) {
    try {
      requireProject();
      const workflow = workflows.find((item) => item.id === id);
      const result = await request<{ data: { id: Id; name: string; capability?: string | null; capabilitiesJson?: unknown; nodeType?: string; configJson?: unknown }[]; edges: { sourceNodeId: Id; targetNodeId: Id }[]; loops?: WorkflowLoop[]; root?: string }>(`/api/workflows/${id}/nodes`);
      const graph = graphFromStored(result.data, result.edges);
      setWorkflowLoops(result.loops ?? []);
      setWorkflowDirectory(result.root ?? '');
      setWorkflowId(id);
      setWorkflowForm({ name: workflow?.name ?? '', version: workflow?.version ?? 'v1' });
      setWorkflowNodesForm(graph.nodes);
      setWorkflowEdgesForm(graph.edges);
      setBoard(workflow?.status === 'draft' ? 'create' : 'view');
      const runRows = await list<Run>(`/api/workflow-runs?workflowId=${id}`);
      setRuns(runRows);
      setRunId(preferredRunId && runRows.some((item) => item.id === preferredRunId) ? preferredRunId : (runRows.at(-1)?.id ?? null));
      setError('');
    } catch (cause) { fail(cause, 'Workflow 打开失败'); }
  }
  async function closeBoard() {
    setChatNodeKey(null);
    setChatError('');
    if (board !== 'create' || !workflowId) {
      setBoard(null);
      return;
    }
    const id = workflowId;
    await act('save-draft', async () => {
      await request(`/api/workflows/${id}`, {
        name: workflowForm.name.trim() || '未命名 Workflow',
        version: workflowForm.version.trim() || 'v1',
        status: 'draft',
        definitionJson: workflowDefinition(),
      }, 'PATCH');
      setBoard(null);
      if (projectId) await loadProject(projectId);
      setWorkflowId(id);
    }, '草稿已留在列表中，可以稍后继续或删除');
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
      if (projectId) await loadProject(projectId);
    }, 'Workflow 已删除');
  }
  async function openNewWorkflow() {
    if (!projectId) { fail(new Error('请先在顶部明确选择项目')); return; }
    await act('workflow-draft', async () => {
      const id = projectId;
      const created = await request<{ id: Id }>('/api/workflows', {
        projectId: id,
        name: '未命名 Workflow',
        version: 'v1',
        status: 'draft',
        definitionJson: { nodes: [], edges: [] },
      });
      setWorkflowId(created.id);
      setWorkflowForm({ name: '未命名 Workflow', version: 'v1' });
      setWorkflowNodesForm([]);
      setWorkflowEdgesForm([]);
      setWorkflowDirectory('');
      setRuns([]);
      setRunId(null);
      setBoard('create');
      await loadProject(id);
      setWorkflowId(created.id);
      const folder = await request<{ root?: string }>(`/api/workflows/${created.id}/files`);
      setWorkflowDirectory(folder.root ?? '');
    }, '已创建草稿 Workflow');
  }
  async function ensureRun(): Promise<Id> {
    if (runId && runDetail?.status === 'running') throw new Error('当前 Run 正在运行，请先停止后再执行');
    if (runId) return runId;
    if (!workflowId) throw new Error('请先打开一个 Workflow');
    const created = await request<{ id: Id; status?: string }>('/api/workflow-runs', { workflowId });
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
          version: workflowForm.version.trim() || current?.version || 'v1',
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
          setLiveChecks({});
          setLiveDeliverables({});
          progressSync.current = false;
        }
        try {
          await request(`/api/workflow-runs/${id}/execute`, mode ? { mode } : {});
        } catch (error) {
          if (mode === 'restart') {
            progressFloor.current = null;
            setLiveProgress(null);
            setLiveChecks(null);
            setLiveDeliverables(null);
          }
          throw error;
        }
        setRunDetail((current) => current ? { ...current, status: 'running' } : current);
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
  async function resolveDecision(id: Id, action: 'approve' | 'request_changes' | 'reject' | 'override' | 'replan' | 'repeat') {
    await act(`decision-${id}`, async () => {
      const decision = decisionText[id]?.trim();
      if (!decision) throw new Error('请填写决策说明');
      await request(`/api/decisions/${id}/resolve`, { decision, action });
      await loadProject(requireProject());
      if (runId) await loadRun(runId);
      setLiveChecks(null);
      setLiveProgress(null);
    }, action === 'repeat' ? '将再做一次这一段' : action === 'request_changes' || action === 'replan' ? '决策已提交，新 Plan 将自动继续' : '决策已提交');
  }

  const overview = <div className="view-stack">
    <SectionTitle eyebrow="System pulse" title={`欢迎回来${project ? `，${project.name}` : ''}`} action={<span className={`connection ${sse}`}><i />SSE {sse === 'open' ? '已连接' : sse === 'connecting' ? '连接中' : sse === 'error' ? '重连中' : '未连接'}</span>} />
    {!projectId ? <section className="panel welcome-empty"><Empty>请从顶部选择一个项目以载入控制中心</Empty><form className="project-create" onSubmit={createProject}><label className="sr-only" htmlFor="project-name">新项目名称</label><input id="project-name" value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="或输入新项目名称" /><button>创建项目</button></form><form className="project-create" onSubmit={login}><input type="email" value={loginForm.email} onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })} placeholder="租户登录邮箱" /><input type="password" value={loginForm.password} onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })} placeholder="密码" /><button>登录租户</button></form><p className="muted">本机默认账号 admin@local.orvia / orvia-local；开发环境不登录也可使用默认 Local 租户。</p></section> : <>
      <div className="metrics">
        {[['Workflows', center?.counts.workflows ?? 0], ['待处理决策', center?.counts.decisions ?? 0], ['Events', center?.counts.events ?? 0]].map(([label, value]) => <article className="metric" key={label}><span>{label}</span><strong>{value}</strong></article>)}
      </div>
      <div className="two-columns">
        <section className="panel"><h3>需要关注</h3><p className="muted">待确认的人工复核。打开对应 Workflow 面板即可处理。</p>
          {pendingDecisions.length ? pendingDecisions.slice(0, 5).map((item) => <button className="item-button" key={item.id} onClick={() => setView('workflows')}><span>Decision #{item.id}</span><b>{item.question}</b><Badge value={item.status} /></button>) : <Empty>当前没有待处理决策</Empty>}
        </section>
        <section className="panel"><h3>实时事件</h3><p className="muted">完整 payload 实时流</p><EventList events={currentEvents.slice(0, 8)} /></section>
      </div>
    </>}
  </div>;

  const modelsView = <div className="view-stack">
    <SectionTitle eyebrow="Catalog" title="已添加的模型" action={<div className="run-controls"><button type="button" onClick={() => setCreateDialog('provider')}>创建 Provider</button><button type="button" onClick={() => setCreateDialog('model')}>创建模型</button></div>} />
    <section className="panel"><h3>模型列表</h3>{models.length ? models.map((item) => {
      const provider = providers.find((row) => row.id === item.providerId);
      return <div className="data-row" key={item.id}><span>#{item.id} {item.displayName}</span><small>{item.name} · {provider?.name ?? '未知 Provider'} · {provider?.baseUrl || '未填写 API 地址'}</small><button type="button" onClick={() => setModelDraft({ id: item.id, providerId: String(item.providerId), name: item.name, displayName: item.displayName, baseUrl: provider?.baseUrl ?? '' })}>编辑</button></div>;
    }) : <Empty>还没有模型。点击右上角「创建模型」添加。</Empty>}</section>
    <section className="panel"><h3>已有 Provider</h3>{providers.length ? providers.map((item) => <div className="data-row" key={item.id}><span>#{item.id} {item.name}</span><small>{item.type} · {item.baseUrl || '未填写 API 地址'}</small><button type="button" onClick={() => setProviderDraft({ id: item.id, name: item.name, type: item.type, baseUrl: item.baseUrl ?? '' })}>编辑</button></div>) : <Empty>还没有 Provider。点击右上角「创建 Provider」添加。</Empty>}</section>
    {createDialog === 'provider' ? <Modal title="新增 Provider" onClose={() => setCreateDialog(null)}>
      <form className="form" onSubmit={createProvider}>
        <Field label="名称" hint="自己起的名字，用来在列表里区分，例如 MiniMax。"><input value={catalogForm.providerName} onChange={(e) => setCatalogForm({ ...catalogForm, providerName: e.target.value })} placeholder="例如 MiniMax" /></Field>
        <Field label="类型" hint="模型厂商类型，要和 Pi 能识别的厂商一致，例如 openai、anthropic。"><input value={catalogForm.providerType} onChange={(e) => setCatalogForm({ ...catalogForm, providerType: e.target.value })} placeholder="例如 openai" /></Field>
        <Field label="API 访问地址" hint="该厂商接口的根地址，例如 https://api.minimaxi.com/v1。同一 Provider 下的模型共用这个地址。官方默认地址可以留空。"><input value={catalogForm.baseUrl} onChange={(e) => setCatalogForm({ ...catalogForm, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
        <div className="run-controls"><button>创建 Provider</button><button type="button" onClick={() => setCreateDialog(null)}>取消</button></div>
      </form>
    </Modal> : null}
    {providerDraft ? <Modal title="编辑 Provider" onClose={() => setProviderDraft(null)}>
      <form className="form" onSubmit={saveProvider}>
        <Field label="名称" hint="自己起的名字，用来在列表里区分，例如 MiniMax。"><input value={providerDraft.name} onChange={(e) => setProviderDraft({ ...providerDraft, name: e.target.value })} /></Field>
        <Field label="类型" hint="模型厂商类型，要和 Pi 能识别的厂商一致，例如 openai、anthropic。"><input value={providerDraft.type} onChange={(e) => setProviderDraft({ ...providerDraft, type: e.target.value })} /></Field>
        <Field label="API 访问地址" hint="该厂商接口的根地址。留空表示使用厂商默认地址。同一 Provider 下的模型共用这个地址。"><input value={providerDraft.baseUrl} onChange={(e) => setProviderDraft({ ...providerDraft, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
        <div className="run-controls"><button type="submit">保存</button><button type="button" onClick={() => setProviderDraft(null)}>取消</button></div>
      </form>
    </Modal> : null}
    {createDialog === 'model' ? <Modal title="新增模型" onClose={() => setCreateDialog(null)}>
      <form className="form" onSubmit={createModel}>
        <Field label="Provider" hint="这个模型属于哪个厂商。还没有的话，先创建 Provider。"><select value={providerChoice} onChange={(e) => { const nextProvider = e.target.value; const provider = providers.find((item) => String(item.id) === nextProvider); setProviderChoice(nextProvider); setCatalogForm((value) => ({ ...value, baseUrl: provider?.baseUrl ?? '' })); }}><option value="">请选择 Provider</option>{providers.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.type}</option>)}</select></Field>
        <Field label="模型标识" hint="调用时传给 Pi 的模型名，必须和厂商侧的模型 ID 一致，例如 MiniMax-M3。"><input value={catalogForm.modelName} onChange={(e) => setCatalogForm({ ...catalogForm, modelName: e.target.value })} placeholder="例如 MiniMax-M3" /></Field>
        <Field label="显示名称" hint="只在控制台里展示。留空时会直接用模型标识。"><input value={catalogForm.displayName} onChange={(e) => setCatalogForm({ ...catalogForm, displayName: e.target.value })} placeholder="例如 MiniMax M3" /></Field>
        <Field label="API 访问地址" hint="模型请求要发往的接口根地址，例如 https://api.minimaxi.com/v1。会保存到所选 Provider，同一 Provider 下的模型共用。官方默认地址可以留空。"><input value={catalogForm.baseUrl} onChange={(e) => setCatalogForm({ ...catalogForm, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
        <div className="run-controls"><button>创建模型</button><button type="button" onClick={() => setCreateDialog(null)}>取消</button></div>
      </form>
    </Modal> : null}
    {modelDraft ? <Modal title="编辑模型" onClose={() => setModelDraft(null)}>
      <form className="form" onSubmit={saveModel}>
        <Field label="模型标识" hint="调用时使用的模型 ID。"><input value={modelDraft.name} onChange={(e) => setModelDraft({ ...modelDraft, name: e.target.value })} /></Field>
        <Field label="显示名称" hint="只在控制台里展示。"><input value={modelDraft.displayName} onChange={(e) => setModelDraft({ ...modelDraft, displayName: e.target.value })} /></Field>
        <Field label="Provider" hint="更换后，API 地址会改写到新的 Provider。"><select value={modelDraft.providerId} onChange={(e) => { const providerId = e.target.value; const next = providers.find((row) => String(row.id) === providerId); setModelDraft({ ...modelDraft, providerId, baseUrl: next?.baseUrl ?? modelDraft.baseUrl }); }}>{providers.map((row) => <option value={row.id} key={row.id}>{row.name} · {row.type}</option>)}</select></Field>
        <Field label="API 访问地址" hint="留空表示使用厂商默认地址。同一 Provider 下的模型共用这个地址。"><input value={modelDraft.baseUrl} onChange={(e) => setModelDraft({ ...modelDraft, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
        <div className="run-controls"><button type="submit">保存</button><button type="button" onClick={() => setModelDraft(null)}>取消</button></div>
      </form>
    </Modal> : null}
  </div>;

  const agentsView = <div className="view-stack">
    <SectionTitle eyebrow="Registry" title="已创建的 Agent" action={<div className="run-controls"><button type="button" onClick={() => setCreateDialog('agent')}>创建 Agent</button><button type="button" onClick={() => setCreateDialog('version')}>增加版本</button></div>} />
    <section className="panel"><h3>Agent 列表</h3>{!projectId ? <Empty>请先在顶部选择项目，这里会列出该项目已经创建的 Agent。</Empty> : agents.length ? agents.map((agent) => {
      const agentVersions = versions.filter((version) => version.agentId === agent.id);
      const current = agentVersions.reduce<AgentVersion | undefined>((latest, version) => !latest || version.id > latest.id ? version : latest, undefined);
      const currentModel = models.find((item) => item.id === current?.modelId);
      const currentProvider = providers.find((item) => item.id === currentModel?.providerId);
      const capabilityText = capabilityKeysOf(agent.capabilitiesJson).map((key) => capabilityName(key)).join('、');
      return <div className="data-row" key={agent.id}><span>#{agent.id} {agent.name}</span><small>{current ? `${current.version} · ${currentProvider?.name ?? '未绑定 Provider'} / ${currentModel?.displayName ?? '未绑定 Model'} · ${current.role}` : '还没有版本'}{capabilityText ? ` · ${capabilityText}` : ''}{agent.workflowId ? ` · Workflow #${agent.workflowId}` : ''}</small><button type="button" onClick={() => setAgentDraft({ id: agent.id, versionId: current?.id ?? null, name: agent.name, capabilities: capabilityKeysOf(agent.capabilitiesJson), providerId: currentModel ? String(currentModel.providerId) : '', modelId: current ? String(current.modelId) : '', version: current?.version ?? 'v1', role: current?.role ?? agent.name, mission: current?.mission ?? '' })}>编辑</button></div>;
    }) : <Empty>此项目还没有 Agent。点击右上角「创建 Agent」添加。</Empty>}</section>
    {createDialog === 'agent' ? <Modal title="新增 Agent" onClose={() => setCreateDialog(null)}>
      <form className="form" onSubmit={createAgent}>
        <Field label="名称" hint="当前项目里这个 Agent 的名字，例如代码构建者。"><input value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} placeholder="例如代码构建者" /></Field>
        <CapabilityPicker label="能力" hint="从下拉里选择，可以选多项。Workflow 节点要求的每一项，这个 Agent 都要具备，任务才会派过来。可以不选，但不选时不会自动承接声明了能力的任务。" options={capabilities} selected={agentForm.capabilities} onChange={(capabilities) => setAgentForm({ ...agentForm, capabilities })} />
        <Field label="Provider" hint="选择模型管理里已经建好的厂商。"><select value={agentForm.providerId} onChange={(e) => { const providerId = e.target.value; const stillValid = models.some((item) => String(item.id) === agentForm.modelId && String(item.providerId) === providerId); setAgentForm({ ...agentForm, providerId, modelId: providerId && !stillValid ? '' : agentForm.modelId }); }}><option value="">请选择 Provider</option>{providers.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.type}</option>)}</select></Field>
        <Field label="Model" hint="选择该 Provider 下要实际调用的模型。"><select value={agentForm.modelId} onChange={(e) => { const modelId = e.target.value; const model = models.find((item) => String(item.id) === modelId); setAgentForm({ ...agentForm, modelId, providerId: model ? String(model.providerId) : agentForm.providerId }); }}><option value="">请选择 Model</option>{agentModels.map((item) => <option value={item.id} key={item.id}>{item.displayName}{agentForm.providerId ? '' : ` · ${providers.find((provider) => provider.id === item.providerId)?.name ?? ''}`}</option>)}</select></Field>
        <Field label="版本" hint="这次配置的版本号。留空会保存为 v1。"><input value={agentForm.version} onChange={(e) => setAgentForm({ ...agentForm, version: e.target.value })} placeholder="v1" /></Field>
        <Field label="角色" hint="这个版本担任的角色，例如构建者、审查者。留空会使用 Agent 名称。"><input value={agentForm.role} onChange={(e) => setAgentForm({ ...agentForm, role: e.target.value })} placeholder="例如构建者" /></Field>
        <Field label="使命" hint="给这个版本的任务说明，执行时会作为补充提示。可以留空。"><input value={agentForm.mission} onChange={(e) => setAgentForm({ ...agentForm, mission: e.target.value })} placeholder="例如产出可审查的代码改动" /></Field>
        <div className="run-controls"><button>创建 Agent</button><button type="button" onClick={() => setCreateDialog(null)}>取消</button></div>
      </form>
    </Modal> : null}
    {createDialog === 'version' ? <Modal title="为已有 Agent 增加版本" onClose={() => setCreateDialog(null)}>
      <form className="form" onSubmit={createVersion}>
        <Field label="Agent" hint="要追加版本的已有 Agent。能力标识仍属于 Agent 本身，这里不需要再填。"><select value={versionForm.agentId} onChange={(e) => setVersionForm({ ...versionForm, agentId: e.target.value })}><option value="">请选择 Agent</option>{agents.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>
        <Field label="Provider" hint="这个版本要使用的厂商，从模型管理里已有的 Provider 中选择。"><select value={versionForm.providerId} onChange={(e) => { const providerId = e.target.value; const stillValid = models.some((item) => String(item.id) === versionForm.modelId && String(item.providerId) === providerId); setVersionForm({ ...versionForm, providerId, modelId: providerId && !stillValid ? '' : versionForm.modelId }); }}><option value="">请选择 Provider</option>{providers.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.type}</option>)}</select></Field>
        <Field label="Model" hint="这个版本实际调用的模型。"><select value={versionForm.modelId} onChange={(e) => { const modelId = e.target.value; const model = models.find((item) => String(item.id) === modelId); setVersionForm({ ...versionForm, modelId, providerId: model ? String(model.providerId) : versionForm.providerId }); }}><option value="">请选择 Model</option>{versionModels.map((item) => <option value={item.id} key={item.id}>{item.displayName}{versionForm.providerId ? '' : ` · ${providers.find((provider) => provider.id === item.providerId)?.name ?? ''}`}</option>)}</select></Field>
        <Field label="版本" hint="新的版本号，需要和已有版本区分，例如 v2。留空会保存为 v1。"><input value={versionForm.version} onChange={(e) => setVersionForm({ ...versionForm, version: e.target.value })} placeholder="v2" /></Field>
        <Field label="角色" hint="这个版本担任的角色。留空会使用 Agent 名称。"><input value={versionForm.role} onChange={(e) => setVersionForm({ ...versionForm, role: e.target.value })} placeholder="例如审查者" /></Field>
        <Field label="使命" hint="这个版本的任务说明。可以留空。"><input value={versionForm.mission} onChange={(e) => setVersionForm({ ...versionForm, mission: e.target.value })} placeholder="例如检查改动是否可合并" /></Field>
        <div className="run-controls"><button>创建版本</button><button type="button" onClick={() => setCreateDialog(null)}>取消</button></div>
      </form>
    </Modal> : null}
    {agentDraft ? <Modal title="编辑 Agent" onClose={() => setAgentDraft(null)}>
      <form className="form" onSubmit={saveAgent}>
        <Field label="名称" hint="当前项目里这个 Agent 的名字。"><input value={agentDraft.name} onChange={(e) => setAgentDraft({ ...agentDraft, name: e.target.value })} /></Field>
        <CapabilityPicker label="能力" hint="从下拉里添加这个 Agent 能承接的能力。目录在「能力」页面维护。" options={capabilities} selected={agentDraft.capabilities} onChange={(next) => setAgentDraft({ ...agentDraft, capabilities: next })} />
        <Field label="Provider" hint="这个版本要使用的厂商。"><select value={agentDraft.providerId} onChange={(e) => { const providerId = e.target.value; const stillValid = models.some((item) => String(item.id) === agentDraft.modelId && String(item.providerId) === providerId); setAgentDraft({ ...agentDraft, providerId, modelId: providerId && !stillValid ? '' : agentDraft.modelId }); }}>{providers.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.type}</option>)}</select></Field>
        <Field label="Model" hint="这个版本实际调用的模型。"><select value={agentDraft.modelId} onChange={(e) => { const modelId = e.target.value; const model = models.find((item) => String(item.id) === modelId); setAgentDraft({ ...agentDraft, modelId, providerId: model ? String(model.providerId) : agentDraft.providerId }); }}><option value="">请选择 Model</option>{models.filter((item) => !agentDraft.providerId || String(item.providerId) === agentDraft.providerId).map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></Field>
        <Field label="版本" hint="正在修改的是最新一个版本。改版本号时不要和已有版本重复。"><input value={agentDraft.version} onChange={(e) => setAgentDraft({ ...agentDraft, version: e.target.value })} /></Field>
        <Field label="角色" hint="这个版本担任的角色。"><input value={agentDraft.role} onChange={(e) => setAgentDraft({ ...agentDraft, role: e.target.value })} /></Field>
        <Field label="使命" hint="执行时作为补充提示。可以留空。"><input value={agentDraft.mission} onChange={(e) => setAgentDraft({ ...agentDraft, mission: e.target.value })} /></Field>
        <div className="run-controls"><button type="submit">保存</button><button type="button" onClick={() => setAgentDraft(null)}>取消</button></div>
      </form>
    </Modal> : null}
  </div>;

  const capabilitiesView = <div className="view-stack">
    <SectionTitle eyebrow="Catalog" title="能力目录" action={<button type="button" onClick={() => { if (!projectId) { setError('请先在顶部明确选择项目'); setState('error'); return; } setCapabilityDialog(true); }}>新增能力</button>} />
    <p className="muted">这里维护当前项目的能力。Agent 和 Workflow 都从这份目录里选择。标识用来派发，创建后不再修改；中文名称和说明给人看。</p>
    <section className="panel"><h3>已有能力</h3>{!projectId ? <Empty>请先在顶部选择项目。</Empty> : capabilities.length ? capabilities.map((item) => <div className="data-row" key={item.id}><span>#{item.id} {item.name}</span><small>{item.key}{item.description ? ` · ${item.description}` : ''}</small><button type="button" onClick={() => setCapabilityDraft({ id: item.id, key: item.key, name: item.name, description: item.description ?? '' })}>编辑</button></div>) : <Empty>这个项目还没有能力。点击右上角「新增能力」。</Empty>}</section>
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
    const merged = [...(runDetail?.events ?? []), ...liveEvents.filter((event) => event.workflowRunId === runId)];
    return merged.filter((event, index, all) => all.findIndex((item) => item.id === event.id) === index).sort((left, right) => left.id - right.id);
  }, [runDetail?.events, liveEvents, runId]);
  const workflowsView = <div className="view-stack">
    <SectionTitle eyebrow="Orchestration" title="Workflow" action={<button type="button" onClick={openNewWorkflow}>新建 Workflow</button>} />
    <section className="panel"><h3>Workflow 列表</h3><p className="muted">新建会先保存一条空草稿。打开后，左侧是这个 Workflow 的 Agent 节点，它们按连线协作。删除后 Agent、连线、Run 和执行日志都无法恢复。</p>{!projectId ? <Empty>请先在顶部选择项目。</Empty> : workflows.length ? workflows.map((item) => <div className="data-row" key={item.id}><span>#{item.id} {item.name}</span><small>{item.version}</small><Badge value={item.status} /><small>{item.runStatus ? statusText(item.runStatus) : '未运行'}</small><button type="button" onClick={() => void openWorkflowBoard(item.id)}>打开</button><button type="button" className="danger" onClick={() => void deleteWorkflow(item)}>删除</button></div>) : <Empty>还没有 Workflow。点击右上角「新建 Workflow」。</Empty>}</section>
    {board && workflowId ? <WorkflowBoard key={workflowId} mode={board} name={workflowForm.name} version={workflowForm.version} nodes={workflowNodesForm} edges={workflowEdgesForm} loops={workflowLoops} capabilities={capabilities} events={boardEvents} progress={liveProgress ?? nodeProgress(runDetail?.tasks)} checks={liveChecks ?? nodeChecks(runDetail?.tasks)} deliverables={liveDeliverables ?? nodeDeliverables(runDetail?.tasks)} runStatus={runDetail ? statusText(runDetail.status) : '未运行'} runStatusCode={runDetail?.status} onClose={() => void closeBoard()} onName={(name) => setWorkflowForm({ ...workflowForm, name })} onVersion={(version) => setWorkflowForm({ ...workflowForm, version })} onNodes={setWorkflowNodesForm} onEdges={setWorkflowEdgesForm} onLoops={setWorkflowLoops} onPersist={persistBoard} onPublish={() => void publishWorkflow()} onExecute={() => void runAction('execute')} onStop={stopRun} directory={workflowDirectory} decisions={pendingDecisions.filter((item) => item.workflowRunId === runId)} decisionNotes={decisionText} onDecisionNote={(id, text) => setDecisionText({ ...decisionText, [id]: text })} onResolveDecision={(id, action) => void resolveDecision(id, action)} onOpenDirectory={async () => { if (!workflowId) return; try { const opened = await request<{ root: string }>(`/api/workflows/${workflowId}/open`, {}); setWorkflowDirectory(opened.root); setNotice('已在访达中打开主目录'); } catch (cause) { fail(cause, '目录打开失败'); } }} onOpenDeliverable={async (directory) => { if (!workflowId) return; try { await request(`/api/workflows/${workflowId}/open`, { directory }); setNotice('已在访达中打开交付物目录'); } catch (cause) { fail(cause, '目录打开失败'); } }} onLoadSummary={async () => { if (!runId) throw new Error('还没有执行记录'); return request<{ nodes: SummaryNode[] }>(`/api/workflow-runs/${runId}/summary`); }} onReadFile={async (filePath) => { if (!workflowId) throw new Error('请先打开 Workflow'); return request<{ name: string; text?: string; binary?: boolean; path?: string }>(`/api/workflows/${workflowId}/file?path=${encodeURIComponent(filePath)}`); }} onListFiles={() => request<{ directory: string; files: { name: string; size: number }[] }>(`/api/workflows/${workflowId}/files`)} onUploadFile={async (file) => { const response = await fetch(`${API_URL}/api/workflows/${workflowId}/files`, { method: 'POST', headers: { ...authHeaders(), 'x-orvia-filename': encodeURIComponent(file.name) }, body: file }); if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; throw new Error(data.error ?? '上传失败'); } }} onDeleteFile={(name) => request(`/api/workflows/${workflowId}/files?name=${encodeURIComponent(name)}`, undefined, 'DELETE').then(() => undefined)} chatNode={chatNodeKey ? workflowNodesForm.find((node) => node.key === chatNodeKey) ?? null : null} chatMessages={nodeMessages} chatError={chatError} onOpenChat={(key) => { setChatError(''); setChatNodeKey(key); }} onCloseChat={() => { setChatNodeKey(null); setChatError(''); }} onSendChat={sendNodeChat} /> : null}
  </div>;

  const views: Record<View, React.ReactNode> = { overview, models: modelsView, agents: agentsView, capabilities: capabilitiesView, workflows: workflowsView };

  return <main className="app-shell">
    <aside className="sidebar"><div className="brand"><span>O</span><div><strong>ORVIA</strong><small>CONTROL CENTER · R3</small></div></div><nav aria-label="主导航">{NAV.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><i>{item.icon}</i>{item.label}{item.id === 'workflows' && pendingDecisions.length > 0 && <em>{pendingDecisions.length}</em>}</button>)}</nav><div className="sidebar-foot"><span className={`connection ${sse}`}><i />{sse === 'open' ? 'Event stream online' : 'Event stream offline'}</span><small>API {API_URL.replace(/^https?:\/\//, '')}</small></div></aside>
    <div className="workspace"><header className="topbar"><div><p className="eyebrow">Revision 3</p><h1>{NAV.find((item) => item.id === view)?.label}</h1></div><div className="toolbar"><label className="sr-only" htmlFor="api-token">API Token</label><input id="api-token" type="password" value={token} placeholder="API Token / 登录后自动填入" autoComplete="off" onChange={(e) => { apiToken = e.target.value; window.sessionStorage.setItem('orvia.token', e.target.value); setToken(e.target.value); }} /><label className="sr-only" htmlFor="tenant">当前租户</label><select id="tenant" value={tenantId ?? ''} onChange={(e) => { const value = Number(e.target.value) || undefined; apiTenantId = value; setTenantId(value ?? null); if (value) window.sessionStorage.setItem('orvia.tenant', String(value)); setProjectId(null); window.sessionStorage.removeItem('orvia.project'); window.sessionStorage.removeItem('orvia.workflow'); window.sessionStorage.removeItem('orvia.run'); void loadGlobal(); }}><option value="">租户</option>{tenants.map((item) => <option value={item.tenantId} key={item.tenantId}>{item.name}</option>)}</select><label className="sr-only" htmlFor="project">当前项目</label><select id="project" value={projectId ?? ''} onChange={(e) => { const id = Number(e.target.value) || null; setProjectId(id); if (id) window.sessionStorage.setItem('orvia.project', String(id)); else window.sessionStorage.removeItem('orvia.project'); }}><option value="">明确选择项目</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="icon-button" onClick={() => void act('refresh', refresh, '数据已刷新')} aria-label="刷新">↻</button></div></header>
      <div className="feedback" aria-live="polite">{state === 'loading' && <div className="loading"><i />正在载入数据…</div>}{error && <div className="alert"><b>请求失败</b><span>{error}</span><button onClick={() => setError('')} aria-label="关闭">×</button></div>}{notice && <div className="notice">{notice}<button onClick={() => setNotice('')} aria-label="关闭">×</button></div>}</div>
      <div className="view">{views[view]}</div>
    </div>
    {executePrompt ? <div className="modal-backdrop execute-prompt" onMouseDown={() => setExecutePrompt(false)}>
      <div className="modal panel" role="dialog" aria-modal="true" aria-label="再次执行" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-head"><h3>再次执行</h3><button type="button" onClick={() => setExecutePrompt(false)}>关闭</button></div>
        <p>这个 Workflow 已经执行过。可以从头再跑一遍，也可以从当前停下的 Agent 接着做。</p>
        <p className="muted">{continuationSummary(workflowNodesForm, workflowEdgesForm, runDetail?.tasks)}</p>
        <div className="run-controls">
          <button type="button" onClick={() => void runAction('execute', 'restart')}>从头开始</button>
          <button type="button" onClick={() => void runAction('execute', 'resume')}>从当前暂停的 Agent 继续</button>
        </div>
      </div>
    </div> : null}
  </main>;
}

function EventList({ events }: { events: EventRow[] }) {
  if (!events.length) return <Empty>暂无事件</Empty>;
  return <div className="events">{events.map((event, index) => <details key={`${event.id}-${index}`}><summary><span className="event-dot" /><b>{event.type}</b><small>{date(event.occurredAt ?? event.createdAt)}</small></summary><Json value={event.payload ?? event.payloadJson} /></details>)}</div>;
}
