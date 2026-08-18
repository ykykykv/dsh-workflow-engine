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
dsh plugin --profile web add github:ykykykv/dsh-workflow-engine#v0.0.4
dsh plugin --profile headless add github:ykykykv/dsh-workflow-engine#v0.0.4
# 本地 tarball：
npm pack
dsh plugin --profile web add ./deepseek-ai-dsh-workflow-engine-0.0.4.tgz
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
run_workflow flow: '/abs/path/to/my-flow'
run_workflow flow: './my-flow'                 # 相对当前会话工作区
run_workflow flow: './game' input: { subject: '@file:./docs/需求.md' }   # 导入 txt/md 文件作为提示词
```

- `flow` 解析顺序：内置名 → 绝对路径 → **相对当前会话工作区**的路径；找不到目录或 `agents.js`/`flow.spec.js` 时报错
- `input`：spec 中标记 `required: true` 的字段必须提供（如 `bigTask`、`subject`）；字符串值以 `@file:<路径>` 开头时，引擎把该 txt/markdown 文件内容读入（相对工作区或绝对，1 MiB 上限）
- `outputDir`：flow 声明的 `outputs` 复制到的目录（绝对或相对工作区；默认 `<工作区>/<flowId>/output`）

返回：`{ stopReason, runId, result?, outputs?, error? }`；`outputs` 为 `[{from, to}]` 报告文件映射；长任务到 `runTimeoutMs` 返回 `paused` + `runId`，再用同一 `flow` + `resumeRunId` 续跑。

## 编写 flow

每个 flow 是一个目录，含 `agents.js` 与 `flow.spec.js` 两个 JS 数据模块。节点：`agent/decision/branch/sequence/parallel/map/loop/set/push/emit/break/fail`。模板只做取值（支持 `{flowId}`/`{runId}`/裸路径 `{splitResult.tasks}`），逻辑放谓词（`branch.if`、`loop.until`）。每个 `loop` 必须带 `maxIter`；`fail` 节点令运行以 `stopReason:'failed'` 结束（如循环上限未达成）。

**报告/文件输出**：flow 顶部声明 `outputs: ['<路径模板>']`（模板可用 `{state,flowId,runId}`），引擎 run 结束后把文件复制到 `outputDir/<runId>/`（默认 `<工作区>/<flowId>/output/<runId>/`），结果返回 `outputs` 映射。推荐写法：写报告的 agent 把文件写进自己的工作区（写权限天然），flow 把该文件声明为 output，引擎搬运到稳定位置。

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
