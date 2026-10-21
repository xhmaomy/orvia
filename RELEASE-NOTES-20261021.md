# Orvia 发布说明

- **版本**：v3.1
- **日期**：2026-10-21
- **分支**：`release-20261021`
- **范围**：Workflow 保存与发布分离、新建命名、节点模型选择体验、产物目录项目分组、版本号升级

---

## 摘要

本版本把 Workflow 的 **「保存」与「发布」拆成两个独立动作**，让草稿和版本历史各归其位；新建 Workflow 时可直接命名；节点弹窗的模型选择改为先选厂商再选模型并直接显示厂商名；产物目录按 **项目分组**，从 `~/.orvia/workflows/{工作流名}/` 变为 `~/.orvia/workflows/{项目名}/{工作流名}/`；产品版本号从 v3.0 升到 **v3.1**。

同时修复了仓库里几处导致 `pnpm typecheck` 与 `pnpm test` 失败的问题，本次发布前已全绿。

---

## 新功能

### 1. 保存与发布分离

- 画布顶栏从单一「发布」拆为 **「保存」/「保存草稿」** 与 **「发布」** 两个按钮。
- **保存** 只落当前工作副本：不写版本历史、不改版本号。
- **发布** 存草稿的同时生成版本快照（`v2-20261021` 形式），版本号按发布次数递增。
- 顶栏新增状态标记，一眼看出当前状态：
  - 黄色「有未发布的修改」—— 画布与已发布版本不一致
  - 绿色「与当前版本一致」—— 已发布且无改动
  - 灰色「尚未发布」—— 还没有任何版本
- 切换历史版本时的「发布并切换 / 直接切换」提示逻辑保持不变。

### 2. 新建 Workflow 可直接命名

- 新建弹窗新增「名称」输入框（必填，默认聚焦），示例「产品研发小组」。
- 不再统一叫「未命名 Workflow」，也不必建完再逐个改名。
- 名称同时用于画布标题和产物目录名。

### 3. 节点模型选择体验调整

- 节点弹窗里 **Provider 在上、Model 在下**，先选厂商，Model 下拉按厂商过滤。
- Model 选项统一显示为 `模型名 · 厂商名`，不再因已选厂商而省略厂商。
- 换厂商时，若当前模型不属于新厂商会自动清空 Model，避免留下不匹配的组合。

### 4. 产物目录按项目分组

- 目录约定改为 `~/.orvia/workflows/{项目名}/{工作流名}/`。
- 同名序号在所属项目目录内编号，例如 `产品研发小组-1`；不同项目下的同名工作流互不干扰。
- **老目录原地保留，不会被搬动**：目录靠 `.orvia-workflow` 标记文件认领，标记里的 workflowId 对得上就沿用原路径。
- 项目改名不会让目录失联 —— 认领靠标记，不靠目录名匹配。

### 5. 版本号升级到 v3.1

| 位置 | 改动 |
|---|---|
| 控制台首页 | `Overview(v3.0)` → `Overview(v3.1)` |
| 页面标题 / 描述 | `Orvia Revision 3` → `Orvia v3.1` |
| `GET /health` | `version` 字段 `0.1.0-revision3` → `0.1.0-v3.1` |
| 文档标题 | `STATUS.md`、`ENVIRONMENT.md`、`PROJECT_DESIGN.md`、`V0.1_ACCEPTANCE.md` 统一改为 v3.1 |

`Orvia_v0.1_Product_Technical_Specification_Revision_3.docx` 的引用保持不变 —— 那指的是 R3 规格基线文档本身，不是产品版本号。

---

## 问题修复

| 问题 | 处理 |
|------|------|
| `pnpm typecheck` 报错 | `seed.ts` 插入人工复核节点时缺必填 `capability` 字段，补空串 |
| `ensure-schema` 测试断言表数量不符 | 断言从 21 张改为实际的 22 张（新增 `ov_decisions`） |
| `budget-service` 测试正则不匹配 | `action === 'replan' \|\| action === 'request_changes'` 拆成两个独立断言 |
| 目录定位只扫一层 | 改为两层深度扫描，老结构（`base/{名}`）与新结构（`base/{项目}/{名}`）都能认领 |
| `next-env.d.ts` 反复变动 | 属 Next.js 在 dev / build 间自动改写（文件头已注明不应手改），非代码问题 |

---

## 行为说明（发布时需知）

1. **保存 ≠ 发布**：保存只存草稿，版本历史只在发布时产生。想留档就点发布。
2. **「有未发布的修改」的判断基准**是已发布版本，不是上次保存。保存后该标记仍会显示，这是预期行为。
3. **自动保存仍保留**：改节点、拖拽、拉连线都会即时落草稿。「保存」按钮提供的是显式落盘与反馈，不是唯一的保存通道。
4. **产物目录按项目分组，但老目录不动**：新旧 Workflow 的目录层级会不一致，属预期。老目录靠标记文件认领，不会被迁移。
5. **数据库**：本版本 **无需改表 / migration**，`ov_workflows` 没有新增字段。

---

## 主要改动文件

| 区域 | 文件 |
|------|------|
| 目录与工作区 | `src/application/workflow-workspace.ts` |
| API | `src/api/server.ts` |
| 画布 | `web/components/WorkflowBoard.tsx` |
| 控制台 | `web/components/ControlCenter.tsx`、`web/app/layout.tsx`、`web/app/globals.css` |
| 数据脚本 | `src/scripts/seed.ts` |
| 测试 | `test/workflow-workspace.test.ts`、`test/ensure-schema.test.ts`、`test/budget-service.test.ts` |
| 文档 | `README.md`、`docs/API.md`、`docs/STATUS.md`、`docs/ENVIRONMENT.md`、`docs/PROJECT_DESIGN.md`、`docs/V0.1_ACCEPTANCE.md` |
| 忽略规则 | `.gitignore`（新增 `.idea/`、`.cursor/`） |

---

## 建议测试清单

- [ ] 新建 Workflow：填名称 → 画布标题与列表都显示该名称
- [ ] 画布顶栏「保存」：版本号不变，仍显示「有未发布的修改」
- [ ] 画布顶栏「发布」：版本号递增为 `v2-20261021`，标记转为「与当前版本一致」
- [ ] 节点弹窗：先选 Provider，Model 下拉按厂商过滤，选项带厂商名；换厂商时模型被清空
- [ ] 新建 Workflow 的主目录显示 `~/.orvia/workflows/{项目名}/{工作流名}/`
- [ ] 同项目下建同名工作流，目录出现 `-1` 序号；不同项目下同名互不干扰
- [ ] 打开老 Workflow，主目录仍是原来的老路径，产物文件都在
- [ ] `GET /health` 返回 `version: 0.1.0-v3.1`
- [ ] 控制台首页显示 `Overview(v3.1)`，浏览器标签标题为 `Orvia v3.1 · Control Center`

---

## 升级注意

- 已部署环境：**库表可不动**，直接升级代码即可。
- 建议完整回归「保存 / 发布 / 切换历史版本」与「新建 → 建节点 → 发布 → 执行」两条主路径后再对外发布。
- 升级后老 Workflow 的产物目录不会自动归到项目名下，这是有意保留的；如需整理可手动移动，注意保留目录内的 `.orvia-workflow` 标记文件。
