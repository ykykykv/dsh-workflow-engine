# @deepseek-ai/dsh-workflow-engine

[中文](README.zh.md)

Declarative multi-agent workflow engine for DeepSeek Harness. Describe workflows as **data** (a flow spec + agent config) and run them with a deterministic, checkpointed, pause-resumable engine — serial / parallel / conditional / loop orchestration, schema-validated decision agents, per-agent memory, per-agent dynamic prompts, and run-isolated workspaces.

- **Engine is fixed, config is swappable**: a flow = `flow.spec.js` + `agents.js` data modules. Swap the files, the engine does not change.
- **Controllable & reproducible**: orchestration is interpreted from data (not model-generated code), loops require `maxIter`, decision output is schema-validated with in-turn self-correction.
- **Checkpoint / pause / resume**: the run state is checkpointed after each node; a run-level time limit pauses (not kills) and resumes by `runId`; cancellation checkpoints first.
- **Per-agent memory**: `memory: 'session'` (one session per agent within a run) or `'none'` (fresh per call).
- **Per-agent dynamic prompts**: each agent call's task text is templated from the shared run-state (`{state.x}`, `{item.y}`, readers).

## Install

From GitHub (web and headless are separate profiles):

```sh
dsh plugin --profile web add github:ykykykv/dsh-workflow-engine#v0.0.4
dsh plugin --profile headless add github:ykykykv/dsh-workflow-engine#v0.0.4
```

Git installs fetch **sources**, and the `prepare` script builds them on install. pnpm ≥10 blocks a git dependency's `prepare` script until it is explicitly allowed: the first `add` fails and prints the exact `allowBuilds` key — copy it into the profile's `pnpm-workspace.yaml`, then re-run `add`:

```yaml
allowBuilds:
  <printed key>: true
```

From a local tarball (no build allowance needed):

```sh
npm pack
dsh plugin --profile web add ./deepseek-ai-dsh-workflow-engine-0.0.4.tgz
```

Verify the row is composed:

```sh
dsh --profile web --dump-config | grep tool-workflow-engine
```

Runtime seam packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`) are provided by the dsh installation's healed `profiles/node_modules`, so no separate peer install is needed.

## Usage

Start `dsh web`, create a session, and call the `run_workflow` tool:

```text
run_workflow flow: 'guess-number'            # built-in example (variant a: own history)
run_workflow flow: 'guess-number-shared'     # variant b: full shared history
run_workflow flow: 'analysis-report' input: { subject: 'AI agents in 2026' }
run_workflow flow: 'analysis-report' input: { subject: '竞品分析', sourceDir: './materials' }
run_workflow flow: 'task-decomposition' input: { bigTask: 'ship a release' }
run_workflow flow: 'roundtable' input: { topic: 'should we adopt Conventional Commits' }
run_workflow flow: 'file-inspect' input: { file: './docs/notes.md', dir: './docs' }
run_workflow flow: '/abs/path/to/my-flow'    # any directory with agents.js + flow.spec.js
run_workflow flow: './my-flow'               # relative to the session workspace
run_workflow flow: './game' input: { subject: '@file:./docs/需求.md' }   # import a txt/md file as the prompt
```

`flow` resolution: a built-in name (`guess-number`, …), an absolute path, or a path **relative to the current session workspace**. Built-in flows live **inside the plugin package** (`…/dsh-workflow-engine/examples/`), not in the workspace — the workspace only holds materialized reference snapshots. If the directory or `agents.js` / `flow.spec.js` is missing, the call fails with a clear error.

List the available built-ins:

```text
run_workflow flow: 'list'
```

Parameters:

| Param | Type | Meaning |
|---|---|---|
| `flow` | string | Built-in name, absolute path, or path relative to the session workspace. Default: configured `defaultExample`. |
| `input` | object | Initial run-state (type-checked against the spec state shape). Fields the spec marks `required` must be present. A string value `@file:<path>` imports that txt/markdown file's content (relative to the session workspace or absolute; 1 MiB cap). |
| `resumeRunId` | string | Resume a paused/interrupted run by id. |
| `resumeStrict` | boolean | Resume even when the spec changed (default `false`). |
| `outputDir` | string | Directory the flow's declared `outputs` are copied to (absolute, or relative to the session workspace). Default: `<workspace>/<flowId>/output`. |

Result shape:

```json
{ "stopReason": "completed|paused|cancelled|failed|error", "runId": "...", "result": {…}, "outputs": [ { "from": "…", "to": "…" } ], "error": { "node": "…", "message": "…", "checkpointPath": "…" } }
```

Long runs return `paused` with a `runId` when `runTimeoutMs` elapses; call again with the same `flow` and `resumeRunId` to continue.

## Authoring a flow

A flow is a directory with two JS data modules:

- `agents.js` — `export const agents = { <id>: { id, persona, model: { provider, model }, memory: 'session'|'none', tools?, skills?, promptSections?, presetId? } }`
- `flow.spec.js` — `export default { name, state, defaults?, onError?, outputs?, entry, nodes }`

Node kinds: `agent` / `decision` / `branch` / `sequence` / `parallel` / `map` / `loop` / `set` / `push` / `emit` / `break` / `fail`.

Per-agent tools & skills (loaded from absolute file/folder paths):

- `tools?: string[]` — absolute paths to **ESM plugin-module files** (`.js`/`.mjs`/`.ts`) that export a Cordis plugin (`apply(ctx)`, registering tools via `ctx.tools.register`). Each module is loaded into that agent's scope only. Loading arbitrary code is shell-level trust; missing/invalid modules fail loudly at agent creation.
- `skills?: string[]` — absolute paths to **skill folders that directly contain `SKILL.md`** (or directories containing multiple skill subfolders). The engine scans their parent as an isolated skill root (`includeDefaultRoots: false`), so only the listed skills are visible to that agent.

`file-inspect` example: `run_workflow flow: 'file-inspect' input: { file: './x.md', dir: './docs' }` reads a specific file and a directory's contents, then produces a report collected via `outputs`.

- Templates: `{state.a.b}`, `{item.x}`, `{loopIndex}`, bare vars (`{t}` for map `as`, bare paths like `{splitResult.tasks}` resolve against `state`), readers (`{filterBy(history, owner, 'g0')}`), `{path ?? fallback}`, and the run facts `{flowId}` / `{runId}`. Lookup only — logic goes in predicates.
- Input: state fields declared `required: true` must be supplied via `input` for the flow to start (e.g. `bigTask`, `taskText`, `subject`); fields without it may be filled by the flow itself. Long prompts can be imported from a file: `input: { subject: '@file:./docs/需求.md' }`.
- Predicates (`branch.if`, `loop.until`): `a==1`, `!splitReview.ok`, `judge.verdict=="reanalyze"`, `&&`/`||`, reader calls. `set` coerces literal `true`/`false`/numbers to typed values, so `set allPass = 'true'` is truthy against `allPass==true`.
- Every `loop` requires `maxIter` (default guidance 3); `break` exits the nearest loop (and is validated to be inside a loop); `fail` stops the run with `stopReason: 'failed'` (e.g. a loop cap reached without success).
- Spec-level `defaults: { timeoutMs, runTimeoutMs }` override the plugin's configured timeouts; a spec `timeoutMs` is clamped to `[defaultTimeoutMs, maxTimeoutMs]` (config), so it can raise a node's budget but not lower it below the configured floor.
- Decision nodes: the agent reports its answer by calling the `structured_output` tool whose argument schema is `outputSchema`; invalid arguments self-correct in-turn; empty capture retries the node (default 3). A `decision` node additionally **routes**: `routeField` names which structured-output field selects `cases` (keyed by its String value), with `default` as fallback (no match + no default → run error).
- `onError`: `abort` (default) / `retry(N)` / `continue` (writes a placeholder) / `goto`.

Outputs / report files:

- Flow-declared `outputs: ['<path template>']` are files the engine copies after the run to `outputDir/<runId>/`. Templates render with `{state, flowId, runId}`; relative paths resolve against the session workspace.
- The recommended pattern: an agent writes the report into its own workspace (write permission is natural there), the flow declares that file as an `output`, and the engine delivers it to the stable `outputDir/<runId>/` location; the tool result's `outputs` array carries the `from → to` mapping.

Run directories created under the session workspace:

```
<workspace>/<flowId>/agent/<agentId>/agent.cordis.yml     # materialized reference snapshot
<workspace>/<flowId>/runs/<runId>/workspace/<agentId>/    # per-agent run-isolated cwd
<workspace>/<flowId>/runs/<runId>/checkpoint.json         # per-node checkpoint
<workspace>/<flowId>/output/<runId>/                      # collected outputs (outputDir default)
```

## Consumer verification (release gate)

```sh
npm run check        # typecheck + unit tests + build
npm pack
dsh plugin --profile compat add -w ./deepseek-ai-dsh-workflow-engine-0.0.4.tgz
dsh --profile compat --dump-config | grep tool-workflow-engine
# module loads in the profile context:
node -e "import('@deepseek-ai/dsh-workflow-engine').then(m => console.log(m.name, m.inject))"
```

## Known limitations

- Member-session navigation in the built-in workflow-run UI is limited: spawned agents are top-level sessions, not `subagent` origin, so the run/phase/member **status tree** renders but per-member "open child session" may not navigate.
- A long `run_workflow` holds the parent turn; segmented by `runTimeoutMs` pause/resume. A background-job mode is future work.
- A crashed `parallel` re-runs as a whole on resume (session-mode agents gain extra turns).
- A changed spec blocks resume unless `resumeStrict=true` (reproducibility gate).
- Resume restores the workflow state/stack **and** session-mode agents' conversation memory (their persisted sessions are resumed; a missing session falls back to a fresh create).
- Materialized `agent.cordis.yml` files are configuration reference snapshots (model route / memory / tool selection are engine-owned) — not standalone runnable presets.
- Windows: the shipped examples use pure LLM reasoning; flows that use shell tools inherit the platform's bash/pwsh platform branching via the mounted preset.

## Trust model

Loading `flow.spec.js` / `agents.js` **executes arbitrary code** — treat a flow directory like a bash script (shell-level trust, same stance as the cordis toolset). Spawned agents inherit the deployment default agent preset (which may include shell tools) and are bounded by the session permission presets (`workspace-write` by default).

## Development

```sh
npm install            # with --legacy-peer-deps; seams come from the dsh installation
npm run check          # typecheck + vitest + build
```

## Model Experience

The `run_workflow` tool adds one fixed schema to the tool catalog. Run results are truncated (`maxResultChars`, default 20000) with full results retained in the run state/checkpoint. Monitoring appends `tool-workflow/*` session events.

## Known Limitations and Deferred Work

- Background-job / async-start mode for long workflows.
- Cross-run persistent agent memory (workspaces are run-isolated by design).
- Resume of session-mode agents across a process restart (currently within-process via live agents; cross-process needs `ctx.agents.resume` wiring).
- Hub registration pending first release.
