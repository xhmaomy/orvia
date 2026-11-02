# @单个节点不回复 - 完整诊断报告

## 问题现象
- @all (多个节点) 时：✅ 部分节点能正常回复
- @单个节点时：❌ 没有返回消息

## 已排查的项目
✅ TypeScript 编译错误 - 已修复 (safeWrite 作用域)
✅ MiniMax Provider 配置 - 正常 (status=active, API Key 已配置)
✅ 模型配置 - 正常 (MiniMax-M3)
✅ 数据库连接 - 正常
✅ 后端服务器 - 运行中 (端口 4100)
✅ 没有卡住的会话

## 可能的原因（按可能性排序）

### 1️⃣ 快速连续触发导致锁冲突 (⭐⭐⭐⭐⭐ 最可能)
**现象**: 
- 第一次 @节点 → 开始处理
- 在处理完成前再次 @同一节点 → 获取锁失败 → 跳过

**解决方案**:
- 等待第一个请求完成后再发第二个
- 观察后端日志: `[SSE] Node xxx busy, retrying...`

### 2️⃣ replyToNode 执行失败 (⭐⭐⭐⭐)
**现象**:
- 后端日志显示: `[SSE] replyToNode error for xxx: ...`
- 收到 SSE 事件: `stream_error`

**可能原因**:
- AI 模型 API 调用超时
- API Key 无效或配额用完
- 模型服务不可用

### 3️⃣ SSE 连接中断 (⭐⭐⭐)
**现象**:
- 前端日志: `[Chat] Stream read error: ...`
- 或: `[Chat] No stream response, status: xxx`

**可能原因**:
- 网络不稳定
- 浏览器标签页切换
- 代理/防火墙中断长连接

### 4️⃣ 前端未正确刷新消息列表 (⭐⭐)
**现象**:
- 后端显示回复成功
- 但前端 UI 没更新

**检查方法**:
- 打开 F12 → Network → 刷新页面
- 查看 GET /api/workflows/{id}/messages 的响应

## 立即测试步骤

### 步骤 1: 准备环境
1. 打开浏览器开发者工具 (F12)
2. 切换到 **Console** 标签
3. 再切换到 **Network** 标签
4. 勾选 **Preserve log** (保留日志)

### 步骤 2: 清除状态
1. **重启后端服务器** (在运行 server.ts 的终端按 Ctrl+C，然后 pnpm dev)
2. **刷新浏览器页面** (Cmd+Shift+R 强制刷新)

### 步骤 3: 执行测试
1. 在聊天框输入: `@需求调研人员 1 你好` (只 @一个节点)
2. 点击发送
3. **不要重复点击！等待回复**
4. 观察:

#### 在 Network 标签中查找:
```
Request: POST /api/workflows/2/messages
Status: 应该是 200
Response Headers:
  Content-Type: text/event-stream  ← 必须是这个！

Events (点击请求 → EventStream 标签):
  event: accepted
  event: stream_start
  event: stream_chunk (可能多个)
  event: stream_done  ← 最后应该是这个，不是 stream_error
  event: done
```

#### 在 Console 标签中查看:
```javascript
// 应该看到这些日志 (如果没有说明有问题):
[Chat] Fetch 成功...
// 不应该看到:
[Chat] Fetch failed: ...
[Chat] Stream read error: ...
[Chat] No stream response, status: ...
```

#### 在后端终端中查看:
```bash
# 应该看到完整的日志流程:
[SSE] Starting to process 1 nodes: ["node-xxx"]
[SSE] [1/1] Processing node: node-xxx
[SSE] Lock acquired for node-xxx, creating transaction...
[SSE] Transaction done for node-xxx, chatMessageId=xxx
[SSE] Calling replyToNode for node-xxx...     ← 等待几秒
[SSE] replyToNode completed for node-xxx      ← ✅ 成功！
[SSE] All nodes processed, sending done event
[SSE] Ending response

# 如果看到这个，说明失败了:
[SSE] replyToNode error for node-xxx: ...     ← ❌ 失败原因
```

### 步骤 4: 记录结果
请告诉我：
1. ✅ 还是 ❌？是否收到了节点的回复？
2. Network 请求的 Status Code 是多少？
3. Response Content-Type 是什么？
4. EventStream 中有哪些事件？（特别是最后一个）
5. Console 中是否有红色错误？
6. 后端终端的完整日志（从 [SSE] Starting 到 [SSE] Ending）

## 临时解决方案

如果测试仍然失败，可以尝试：

### 方案 A: 使用 @all 代替 @单个节点
输入: `@all 你好`
这会触发所有节点回复，至少能确认基本功能正常。

### 方案 B: 手动轮询检查回复
在浏览器 Console 中执行：
```javascript
// 每 3 秒检查一次新消息
setInterval(async () => {
  const res = await fetch('http://127.0.0.1:4100/api/workflows/2/messages', {
    headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('orvia.token') }
  });
  const data = await res.json();
  const lastMsg = data.data[data.data.length - 1];
  if (lastMsg) {
    console.log(`最新消息 (${new Date(lastMsg.createdAt).toLocaleTimeString()}):`, 
      lastMsg.nodeKey ? `[${lastMsg.nodeKey}]` : '[我]', 
      lastMsg.content.slice(0, 50));
  }
}, 3000);
```

### 方案 C: 检查数据库直接
在后端运行：
```bash
npx tsx test_single_node.ts
```
查看最新的会话状态。

## 下一步
请按照上面的步骤测试，并将结果反馈给我。
根据具体的错误信息，我可以提供更精准的修复方案。
