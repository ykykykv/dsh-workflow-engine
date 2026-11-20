# @deepseek-ai/dsh-workflow-engine

[English](README.md)

DeepSeek Harness 的声明式多 agent 工作流引擎。用**数据**（flow spec + agent 配置）描述工作流，由确定性、可断点续跑、可暂停续跑的引擎执行：串行 / 并行 / 条件 / 循环编排、schema 校验的决策 agent、每 agent 记忆、每 agent 动态提示词、按 run 隔离的工作目录。

- **引擎固定、配置可换**：一个 flow = `flow.spec.js` + `agents.js` 数据模块，换文件不改引擎。
- **可控可复现**：编排由数据解释（非模型生成代码）；loop 强制 `maxIter`；决策输出 schema 校验 + turn 内自我纠正。
- **断点/暂停/续跑**：每节点 checkpoint；run 级时限到点**暂停**（不杀）并按 `runId` 续跑；取消先 checkpoint。
- **每 agent 记忆**：`memory: 'session'`（run 内复用会话）/ `'none'`（每次全新）。
- **每 agent 动态提示词**：task 由 run-state 模板构造（`{state.x}`、`{item.y}`、读取器）。

## 安装

```sh
dsh plugin --profile web add github:ykykykv/dsh-workflow-engine#v0.0.19
dsh plugin --profile headless add github:ykykykv/dsh-workflow-engine#v0.0.19
# 本地 tarball：
npm pack
dsh plugin --profile web add ./deepseek-ai-dsh-workflow-engine-0.0.19.tgz
```

GitHub 安装会拉取**源码**并靠 `prepare` 构建；pnpm ≥10 默认拦截，第一次 `add` 会失败并打印 `allowBuilds` key——把它加进该 profile 的 `pnpm-workspace.yaml` 后重跑 `add` 即可。

验证：`dsh --profile web --dump-config | grep tool-workflow-engine`

## 使用

在 `dsh web` 会话中调用 `run_workflow` 工具：

```text
run_workflow flow: 'guess-number'
run_workflow flow: 'analysis-report' input: { subject: 'AI agents in 2026' }
run_workflow flow: 'analysis-report' input: { subject: '竞品分析', sourceDir: './materials' }
run_workflow flow: 'task-decomposition' input: { bigTask: 'ship a release' }
run_workflow flow: 'roundtable' input: { topic: '团队是否应该引入每日站会' }
run_workflow flow: 'file-inspect' input: { file: './docs/notes.md', dir: './docs' }
run_workflow flow: '/abs/path/to/my-flow'
run_workflow flow: './my-flow'                 # 相对当前会话工作区
run_workflow flow: './game' input: { subject: '@file:./docs/需求.md' }   # 导入 txt/md 文件作为提示词
```

- `flow` 解析顺序：内置名 → 绝对路径 → **相对当前会话工作区**的路径；找不到目录或 `agents.js`/`flow.spec.js` 时报错。**内置 flow 在插件包内**（`…/dsh-workflow-engine/examples/`），不在工作区（工作区只有物化参考快照）。用 `run_workflow flow: 'list'` 列出内置 flow 名。
- `input`：spec 中标记 `required: true` 的字段必须提供（如 `bigTask`、`subject`）；字符串值以 `@file:<路径>` 开头时，引擎把该 txt/markdown 文件内容读入（相对工作区或绝对，1 MiB 上限）。字符串字段声明 `path: true` 表示它是文件路径：加载时相对路径会按**会话工作区**解析成绝对路径，因为每个成员 agent 的 cwd 是各自隔离的运行工作区（`<工作区>/<flowId>/runs/<runId>/workspace/<agent>`）。
- `outputDir`：flow 声明的 `outputs` 复制到的目录（绝对或相对工作区；默认 `<工作区>/<flowId>/output`）
- `background`：true 时把这次 run 注册成 `ctx.jobs` 的后台 job，立即返回 `{ stopReason:'started', jobId, runId }`，不再占住父回合；必须有正的运行预算（flow 的 `defaults.runTimeoutMs` 或插件 `runTimeoutMs`）
- `autoResume`：仅后台有效，`paused` 时自动续跑的次数（`0`–`3`，默认 `0`）；每次续跑都花一个新预算窗口，因此也是 token 上限
- `takeover`：接管崩溃进程留下的过期租约（默认 false；租约还活着时会被拒绝）

返回：`{ stopReason, runId, result?, outputs?, error?, message?, checkpointPath? }`；`outputs` 为 `[{from, to}]` 报告文件映射；长任务到 `runTimeoutMs` 返回 `paused` + `runId`，`message` 给出续跑命令，再用同一 `flow` + `resumeRunId` 续跑。

### 后台运行

`background: true` 后：调用立即返回 jobId，run 在回合结束后继续跑；用 `job_output` 看进度/结果、`job_kill` 停止。phase 变化写进 job 进度行，`tool-workflow/*` 日志进 job 输出环。job 完成后结果与前台调用同一份 JSON。

- **必须给预算**：没有正 `runTimeoutMs` 的后台 run 会被拒绝（无人看管的无界运行会烧 token）。
- **`paused` 结算为 job 的 `failed`**，detail 形如 `paused: … (runId=…)`——job 词汇里没有 paused。需要自动接续就传 `autoResume`（≤3）。
- **一个 run 只有一个写者**：每次运行持有 `runs/<runId>/lease.json`（5s 心跳 / 30s TTL）。后台 job 持有期间手动 `resumeRunId` 会被明确拒绝；崩溃留下的过期租约需要 `takeover: true`。

## 编写 flow

每个 flow 是一个目录，含 `agents.js`、`flow.spec.js` 两个 JS 数据模块，以及可选的 bundle 文件：`personas/<name>.md`（供 `personaRef` 引用）与 `code/<name>.mjs`（供 code 节点引用）。节点：`agent/decision/code/branch/sequence/parallel/map/loop/set/push/emit/break/fail`。模板只做取值（支持 `{flowId}`/`{runId}`/裸路径 `{splitResult.tasks}`），逻辑放谓词（`branch.if`、`loop.until`）。每个 `loop` 必须带 `maxIter`（`break` 须位于循环内，引擎校验）；`fail` 节点令运行以 `stopReason:'failed'` 结束。`decision` 节点可用 `routeField` 指定结构化输出中用于路由的字段，按 `cases`（键为字段值的字符串）跳转，`default` 兜底。spec 级 `defaults: { timeoutMs, runTimeoutMs }` 可覆盖插件配置的默认超时；spec 的 `timeoutMs` 被 clamp 到 `[defaultTimeoutMs, maxTimeoutMs]`（config），可调高、不可低于全局下限。续跑（resumeRunId）会恢复流程 state/stack **并恢复** session-mode agent 的会话记忆（其持久化会话被 resume；缺失则回退新建）。`runTimeoutMs` 到点会**打断在跑的 agent**（暂停优先于重试/报错）。`flowId`/`agentId`/`runId` 仅允许 `[a-zA-Z0-9_-]`（防目录穿越）。

**bundle 与哈希**：加载时解析 `personaRef` 与所有 code 模块，按内容把每个文件记入 flow bundle，并计入 `specHash`——改 persona/code 会让旧 checkpoint 无法静默续跑（混跑新旧代码）。

### 让成员会话不出现在侧边栏

每个成员 agent 都跑在真实 DSH 会话上，因此对话会进会话存储（`~/.dsh/sessions/…`），默认还会出现在 Web 侧边栏的「未分组」里（成员跑在各自的隔离工作区）。两个 per-agent 开关控制这件事：

- `visibility?: 'listed' | 'hidden'`（或 flow 级 `defaults.visibility`）——`hidden` 用 DSH 唯一的子会话标记 `origin: 'subagent'`（附带 `parentSession` 血统与 `delegationDepth: 1`）创建会话；Web 客户端会把 `origin === 'subagent'` 从所有工作区分组中过滤掉，成员就不再出现在侧边栏。注意这只是**可见性**：DSH 仍会持久化会话与投影缓存，没有“这个会话不要落盘”的开关。
- `transcript?: 'none' | 'run'`——`run` 会在会话销毁前把对话以 JSONL（首行 header + 每个事件）写到 `runs/<runId>/agents/<agentId>.jsonl`，并把路径放进运行结果的 `transcripts` 映射。这是与 run 绑定的持久审计副本。

```js
// agents.js
worker: { id: 'worker', persona: '…', visibility: 'hidden', transcript: 'run', … }
```

隐藏会话无法从 Web UI 打开（不在父会话的 subagent catalog 里）；续跑不受影响（`resumeRunId` 走 agent registry 恢复，不走 session API）。

### code 节点（确定性步骤）

code 节点是与 agent 同级的一等节点：把“确定性计算”（解析/校验/变换 JSON、过滤排序去重、算术、哈希）从 LLM 手里拿回来。它不是“用代码写流程”——控制流、重试、checkpoint 仍归引擎。

```js
// flow.spec.js
normalize: { kind: 'code', run: { module: './code/normalize.mjs' }, store: 'tasks' },
count:     { kind: 'code', run: 'return { value: state.tasks.length }', store: 'taskCount' },
guard:     { kind: 'code', run: { module: './code/guard.mjs' }, timeoutMs: 5000, onError: { kind: 'goto', node: 'repair' } },
```

```js
// code/normalize.mjs —— 默认导出函数
export default ({ state, get, fail }) => {
  const raw = get('splitResult.tasks')
  if (!Array.isArray(raw)) fail('splitResult.tasks is not an array')
  return { patch: { tasks: raw.map(t => String(t).trim()).filter(Boolean) } }
}
```

契约：

- 入参 `{ state, item?, loopIndex?, get(path), render(template), now(), log(msg), fail(msg), signal }`；**没有** `ctx`、不能调 agent。
- 返回 `{ patch?, value?, signal?: 'break' }` 或空：`patch` 合并进 state，`value` 写入节点的 `store`，`signal:'break'` 退出最近循环。
- `fail(msg)` → `stopReason:'failed'`（同 `fail` 节点，绕过 `onError`）；抛异常是普通节点错误，走 `onError`（retry/continue/goto/abort）。
- **必须是纯函数**：resume 会重放 code 节点，I/O 会执行两次。`timeoutMs`（默认 5s）是协作式超时，只对 async body 生效，在 await 边界检查。
- code body 是宿主进程里的可信代码（与 `flow.spec.js` 同级信任）；它拿不到 `ctx`，也不能启动 agent。
- 内联 body 适合一行表达式；更长的逻辑用模块，便于测试与 review。

**单 agent 工具与技能（按文件/文件夹绝对路径加载）**：`AgentConfig.tools` 为**绝对路径**的 ESM 插件模块文件（`.js/.mjs/.ts`，导出 Cordis 插件 `apply(ctx)`，内部 `ctx.tools.register`），加载到该 agent 作用域（仅该 agent 可见）；缺失/非法文件在创建 agent 时 fail-loud。`AgentConfig.skills` 为**直接含 `SKILL.md` 的技能文件夹**（绝对路径）——引擎以其父目录为隔离技能根（`includeDefaultRoots:false`），该 agent 只见这些技能。加载任意代码属 shell 级信任。

`file-inspect` 示例：`run_workflow flow: 'file-inspect' input: { file: './x.md', dir: './docs' }` 读取指定文件与目录内容并产出报告（经 `outputs` 收集）。`file`/`dir` 均声明为 `path: true`，相对路径会按会话工作区解析成绝对路径后再交给 agent。

**报告/文件输出**：flow 顶部声明 `outputs: ['<路径模板>']`（模板可用 `{state,flowId,runId}`），引擎 run 结束后把文件复制到 `outputDir/<runId>/`（默认 `<工作区>/<flowId>/output/<runId>/`），结果返回 `outputs` 映射。推荐写法：写报告的 agent 把文件写进自己的工作区（写权限天然），flow 把该文件声明为 output，引擎搬运到稳定位置。

## 已知局限

- 内置 workflow-run UI 的成员"点开子会话"导航受限（我们的 agent 是顶层会话，非 subagent origin），但 run/阶段/成员状态树正常显示。
- 前台 `run_workflow` 占用父轮次（靠 `runTimeoutMs` 分段）；需要不占用就用 `background: true`。后台 job 的生命周期等于进程生命周期——进程重启后 checkpoint 还在，可用 `resumeRunId` 手动接续。
- `autoResume` 上限 3 且必须有正预算；不存在无界的自动续跑。
- 崩溃的 `parallel` 恢复时会整体重跑。
- spec 变更阻断续跑（除非 `resumeStrict=true`）。
- 物化的 `agent.cordis.yml` 是配置参考快照（模型路由/记忆/工具选择属引擎），非可独立运行的完整预设。
- Windows：示例用纯 LLM 推理；用 shell 工具的 flow 经挂载预设走平台分支。

## 兼容性

- 已对 dsh **0.2.1-rc.2** 实测（seam 包 `@deepseek-ai/dsh-{agent,llm,session,tools,skill-filesystem}`）；manifest 声明 `engines.dsh: "^0.2.0 || ^0.2.1-rc.2"`，同一范围也写在可选的 seam peer 上，安装时的兼容性门禁会直接拒绝不匹配的运行时。
- 预发布注意：单独写 `^0.2.0` **不匹配** `0.2.1-rc.2`（semver 默认排除预发布，除非比较器带同一版本元组），所以范围里要加 `^0.2.1-rc.2`。硬 pin 的包可用 `dsh plugin allow-version` 按精确版本豁免。
- setup 通过第二个参数拿到 agent；`agentCtx.agent` 保留为 0.1.x 兜底。子会话会记录 `agentPreset` 与 `parentSession`，父预设优先用 `agentPresets.composedPreset()` 解析，再回退 `session.header.agentPreset`。
- 与平台 delegation 对齐：成员会话写入 `sandbox/mode`（来自 `AgentConfig.sandbox`，否则继承父会话的显式覆盖）与 `approval/policy: 'never'`，都带 `source: 'delegation'` —— 后台成员不会卡在交互式审批上。
- 预设 id 跨版本别名：dsh 0.2.x 把内置预设 `code` 更名为 `ptc`；`AgentConfig.presetId` 写 `code` 或 `ptc` 都会自动回退到对方（仅在"未知预设"错误时回退一次）。
- 0.2.x 的内置预设默认带 `web_search`/`web_fetch`（静态页可直接抓取）；需要 JS 渲染或浏览器自动化的场景仍建议用 `playwright-cli` 技能 + `sandbox: 'danger-full-access'`。

## 信任模型

加载 `flow.spec.js` / `agents.js` **会执行任意代码**——请像对待 bash 脚本一样对待 flow 目录（shell 级信任）。spawn 出的 agent 继承部署默认预设（可能含 shell 工具），受会话权限预设约束（默认 `workspace-write`）。

`agents.js` 支持可选 **`sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'`** 逐 agent 覆盖：未设置时走部署/会话默认策略；设为 `danger-full-access` 会让该 agent 的 shell 工具**绕过沙箱**（无受限 token）——需要派生 piped 子进程的工具（如 `playwright-cli` 的 daemon 用 `stdio:'pipe'`，受限 token 下会 EPERM）必须用此模式。逐 agent 显式开启，等同 shell 级信任。

## 开发

```sh
npm install            # 用 --legacy-peer-deps；seam 包来自 dsh 安装
npm run check          # typecheck + typecheck:dsh + vitest + build
```

`npm run typecheck:dsh` 用**已安装的 dsh** 的 seam 类型做检查（`$DSH_SEAMS_DIR`，默认 `~/.dsh/profiles/node_modules/@deepseek-ai`），是 dsh 升级后的漂移探测器。
