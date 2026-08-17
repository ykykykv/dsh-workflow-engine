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
dsh plugin --profile web add @deepseek-ai/dsh-workflow-engine
dsh plugin --profile headless add @deepseek-ai/dsh-workflow-engine
# 本地 tarball：
npm pack
dsh plugin --profile web add ./deepseek-ai-dsh-workflow-engine-0.0.1.tgz
```

验证：`dsh --profile web --dump-config | grep tool-workflow-engine`

## 使用

在 `dsh web` 会话中调用 `run_workflow` 工具：

```text
run_workflow flow: 'guess-number'
run_workflow flow: 'department-flow' input: { taskText: 'prepare the quarterly budget' }
run_workflow flow: '/abs/path/to/my-flow'
run_workflow flow: './my-flow'                 # 相对当前会话工作区
run_workflow flow: './game' input: { subject: '@file:./docs/需求.md' }   # 导入 txt/md 文件作为提示词
```

- `flow` 解析顺序：内置名 → 绝对路径 → **相对当前会话工作区**的路径；找不到目录或 `agents.js`/`flow.spec.js` 时报错
- `input`：spec 中标记 `required: true` 的字段必须提供（如 `bigTask`、`taskText`）；字符串值以 `@file:<路径>` 开头时，引擎把该 txt/markdown 文件内容读入（相对工作区或绝对，1 MiB 上限）

返回：`{ stopReason, runId, result?, error? }`；长任务到 `runTimeoutMs` 返回 `paused` + `runId`，再用同一 `flow` + `resumeRunId` 续跑。

## 编写 flow

每个 flow 是一个目录，含 `agents.js` 与 `flow.spec.js` 两个 JS 数据模块。节点：`agent/decision/branch/sequence/parallel/map/loop/set/push/emit/break`。模板只做取值，逻辑放谓词（`branch.if`、`loop.until`）。每个 `loop` 必须带 `maxIter`。

## 已知局限

- 内置 workflow-run UI 的成员"点开子会话"导航受限（我们的 agent 是顶层会话，非 subagent origin），但 run/阶段/成员状态树正常显示。
- 长任务占用父轮次（靠 `runTimeoutMs` 分段；后台 job 模式为后续项）。
- 崩溃的 `parallel` 恢复时会整体重跑。
- spec 变更阻断续跑（除非 `resumeStrict=true`）。
- 物化的 `agent.cordis.yml` 是配置参考快照（模型路由/记忆/工具选择属引擎），非可独立运行的完整预设。
- Windows：示例用纯 LLM 推理；用 shell 工具的 flow 经挂载预设走平台分支。

## 信任模型

加载 `flow.spec.js` / `agents.js` **会执行任意代码**——请像对待 bash 脚本一样对待 flow 目录（shell 级信任）。spawn 出的 agent 继承部署默认预设（可能含 shell 工具），受会话权限预设约束（默认 `workspace-write`）。

## 开发

```sh
npm install            # 用 --legacy-peer-deps；seam 包来自 dsh 安装
npm run check          # typecheck + vitest + build
```
