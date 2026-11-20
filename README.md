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
dsh plugin --profile web add github:ykykykv/dsh-workflow-engine#v0.0.18
dsh plugin --profile headless add github:ykykykv/dsh-workflow-engine#v0.0.18
```

Git installs fetch **sources**, and the `prepare` script builds them on install. pnpm ≥10 blocks a git dependency's `prepare` script until it is explicitly allowed: the first `add` fails and prints the exact `allowBuilds` key — copy it into the profile's `pnpm-workspace.yaml`, then re-run `add`:

```yaml
allowBuilds:
  <printed key>: true
```

From a local tarball (no build allowance needed):

```sh
npm pack
dsh plugin --profile web add ./deepseek-ai-dsh-workflow-engine-0.0.18.tgz
```

Verify the row is composed:

```sh
dsh --profile web --dump-config | grep tool-workflow-engine
```

Runtime seam packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-skill-filesystem`) are provided by the dsh installation's healed `profiles/node_modules`, so no separate install is needed: they are declared as **optional** peer dependencies (the declared ranges are still what dsh's install-time compatibility gate checks).

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
| `background` | boolean | Register the run as an owned `ctx.jobs` job and return `{ stopReason: 'started', jobId, runId }` immediately instead of holding the turn. Requires a positive run budget (`flow` `defaults.runTimeoutMs` or the plugin `runTimeoutMs`). |
| `autoResume` | integer | Background only: automatically resume a paused run up to this many times (`0`–`3`, default `0`). Each resume spends a fresh budget window, so it also bounds token spend. |
| `takeover` | boolean | Take over an expired run lease left by a crashed process (default `false`). Fails while the lease is live. |

Result shape (foreground):

```json
{ "stopReason": "completed|paused|cancelled|failed|error", "runId": "...", "result": {…}, "outputs": [ { "from": "…", "to": "…" } ], "error": { "node": "…", "message": "…", "checkpointPath": "…" }, "message": "…", "checkpointPath": "…" }
```

`paused` / `cancelled` carry a `message` with the exact next call and the `checkpointPath`; long runs return `paused` with a `runId` when `runTimeoutMs` elapses, so calling again with the same `flow` and `resumeRunId` continues from the checkpoint.

### Background runs

`background: true` hands the run to the job registry (`ctx.jobs`, provided by `dsh-jobs-local` + `dsh-tool-jobs`): the call returns `{ "stopReason": "started", "jobId": "workflow-engine-…", "runId": "…", "message": "…" }` and the run keeps going after the turn ends. Check it with `job_output`, stop it with `job_kill`; a completed run carries the same JSON as a foreground call (`stopReason`, `result`, `outputs`) in the job result. Phase changes become the job's progress line and the `tool-workflow/*` log lines land in the job output ring.

- **Budget is mandatory**: a background run without a positive `runTimeoutMs` is rejected — an unbounded run nobody watches would burn tokens.
- **`paused` settles the job as `failed`** with a `paused: … (runId=…)` detail, because the job vocabulary has no `paused`. Pass `autoResume: N` (≤ 3) to let the job resume itself up to N times before settling.
- **One writer per run**: each run holds `runs/<runId>/lease.json` (5s heartbeat, 30s TTL). A concurrent manual resume is rejected while a background job owns the run, and a lease left by a crashed process needs `takeover: true`.
- Foreground calls are unchanged: without `background`, the turn still waits for the run.

## Authoring a flow

A flow is a directory with two JS data modules plus optional bundle files:

- `agents.js` — `export const agents = { <id>: { id, persona | personaRef, model: { provider, model }, memory: 'session'|'none', tools?, skills?, sandbox?, promptSections?, presetId? } }`
- `flow.spec.js` — `export default { name, state, defaults?, onError?, outputs?, entry, nodes }`
- `personas/<name>.md` — shared persona text for `personaRef: '<name>'` (tried as `.md`, `.markdown`, `.txt`).
- `code/<name>.mjs` — bodies for `code` nodes (`{ module: './code/<name>.mjs' }`).

Node kinds: `agent` / `decision` / `code` / `branch` / `sequence` / `parallel` / `map` / `loop` / `set` / `push` / `emit` / `break` / `fail`.

The loader resolves `personaRef` and every referenced code module, hashes each file's bytes into the run's **flow bundle**, and folds that into the resume gate: editing a persona or a code module changes `specHash`, so an old checkpoint cannot silently resume against new code.

### Keeping member sessions out of the sidebar

Every member agent runs on a real DSH session, so its transcript lands in the session store
(`~/.dsh/sessions/…`) and, unless marked otherwise, shows up in the Web sidebar's "Ungrouped"
bucket (members run in isolated run workspaces). Two per-agent knobs control this:

- `visibility?: 'listed' | 'hidden'` (or flow-level `defaults.visibility`) — `hidden` creates the
  session with DSH's only subagent marker, `origin: 'subagent'` (plus `parentSession` lineage and
  `delegationDepth: 1`). The Web client filters `origin === 'subagent'` out of every workspace
  bucket, so the member disappears from the sidebar. **Visibility only**: DSH keeps persisting
  the session and its projection-cache row — there is no per-session "don't persist" switch.
- `transcript?: 'none' | 'run'` — `run` writes a JSONL copy (header line + every event) to
  `runs/<runId>/agents/<agentId>.jsonl` before the session is disposed, and lists the paths in
  the run result's `transcripts` map. This is the durable, run-scoped audit copy.

```js
// agents.js
worker: { id: 'worker', persona: '…', visibility: 'hidden', transcript: 'run', … }
```

Hidden sessions cannot be opened from the Web UI (they are not in the parent's subagent catalog);
resume is unaffected (`resumeRunId` restores them through the agent registry, not the session API).

### Deterministic `code` nodes

A `code` node is a first-class non-agent step: it does the computation the flow would otherwise have to ask an agent for (parse/validate/transform JSON, filter/sort/dedupe, arithmetic, hashing). It is **not** "the flow written in code" — control flow, retries, and checkpointing stay with the engine.

```js
// flow.spec.js
normalize: { kind: 'code', run: { module: './code/normalize.mjs' }, store: 'tasks' },
count:     { kind: 'code', run: 'return { value: state.tasks.length }', store: 'taskCount' },
guard:     { kind: 'code', run: { module: './code/guard.mjs' }, timeoutMs: 5000, onError: { kind: 'goto', node: 'repair' } },
```

```js
// code/normalize.mjs — default-exported function
export default ({ state, get, fail }) => {
  const raw = get('splitResult.tasks')
  if (!Array.isArray(raw)) fail('splitResult.tasks is not an array')
  return { patch: { tasks: raw.map(t => String(t).trim()).filter(Boolean) } }
}
```

Contract:

- The body receives `{ state, item?, loopIndex?, get(path), render(template), now(), log(msg), fail(msg), signal }`. No `ctx`, no agent access.
- It returns `{ patch?: object, value?, signal?: 'break' }` (or nothing). `patch` merges into the run state; `value` is stored at the node's `store`; `signal: 'break'` exits the nearest loop.
- `fail(msg)` ends the run with `stopReason: 'failed'` (like a `fail` node, bypassing `onError`); a thrown error is a normal node error and honors `onError` (`retry`/`continue`/`goto`/`abort`).
- Bodies must be **pure**: a resume replays every code node, so I/O would run twice. `timeoutMs` (default 5s) is cooperative — it applies to async bodies and is checked at await boundaries.
- Code bodies are trusted code running in the host process, exactly like `flow.spec.js` itself (shell-level trust); they cannot reach `ctx` or start agents.
- Inline bodies (`run: 'return …'`) are convenient for one-liners; anything longer should be a module so it can be tested and reviewed.

Per-agent tools & skills (loaded from absolute file/folder paths):

- `tools?: string[]` — absolute paths to **ESM plugin-module files** (`.js`/`.mjs`/`.ts`) that export a Cordis plugin (`apply(ctx)`, registering tools via `ctx.tools.register`). Each module is loaded into that agent's scope only. Loading arbitrary code is shell-level trust; missing/invalid modules fail loudly at agent creation.
- `skills?: string[]` — absolute paths to **skill folders that directly contain `SKILL.md`** (or directories containing multiple skill subfolders). The engine scans their parent as an isolated skill root (`includeDefaultRoots: false`), so only the listed skills are visible to that agent.
- `sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'` — optional **per-agent** sandbox override seeded onto the agent session at materialization (mirrors the platform's `source: 'delegation'` events). Default (unset) follows the deployment/session policy. `danger-full-access` **bypasses confinement** so the agent's shell tools run unrestricated — required for tools that must spawn piped child processes (e.g. `playwright-cli`'s daemon uses `stdio: 'pipe'`, which fails with `EPERM` under a restricted token). Opt in explicitly per agent; treat it as shell-level trust.

`file-inspect` example: `run_workflow flow: 'file-inspect' input: { file: './x.md', dir: './docs' }` reads a specific file and a directory's contents, then produces a report collected via `outputs`. `file`/`dir` are declared `path: true`, so relative values are resolved against the session workspace before the run starts (member agents run in their own isolated cwd).

- Templates: `{state.a.b}`, `{item.x}`, `{loopIndex}`, bare vars (`{t}` for map `as`, bare paths like `{splitResult.tasks}` resolve against `state`), readers (`{filterBy(history, owner, 'g0')}`), `{path ?? fallback}`, and the run facts `{flowId}` / `{runId}`. Lookup only — logic goes in predicates.
- Input: state fields declared `required: true` must be supplied via `input` for the flow to start (e.g. `bigTask`, `taskText`, `subject`); fields without it may be filled by the flow itself. Long prompts can be imported from a file: `input: { subject: '@file:./docs/需求.md' }`. Declare a string field `path: true` when the value is a filesystem path and the producing agent should receive it **absolute**: relative input is resolved against the session workspace at load time, because each member agent's cwd is its own run-isolated workspace (`<workspace>/<flowId>/runs/<runId>/workspace/<agent>`).
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
npm run check        # typecheck + typecheck:dsh + unit tests + build
npm pack
dsh plugin --profile compat add -w ./deepseek-ai-dsh-workflow-engine-0.0.18.tgz
dsh --profile compat --dump-config | grep tool-workflow-engine
# module loads in the profile context:
node -e "import('@deepseek-ai/dsh-workflow-engine').then(m => console.log(m.name, m.inject))"
```

`npm run typecheck:dsh` type-checks the sources against the seam packages of the **deployed** dsh
installation (`$DSH_SEAMS_DIR`, default `~/.dsh/profiles/node_modules/@deepseek-ai`), which is the
drift detector for dsh upgrades — run it after bumping the dsh version.

## Known limitations

- Member-session navigation in the built-in workflow-run UI is limited: spawned agents are top-level sessions, not `subagent` origin, so the run/phase/member **status tree** renders but per-member "open child session" may not navigate.
- A foreground `run_workflow` holds the parent turn (segmented by `runTimeoutMs` pause/resume); use `background: true` to move it to a job. Background job lifetime is the process lifetime — a restart keeps the checkpoint, and `resumeRunId` continues manually.
- `autoResume` is bounded to 3 and needs a positive budget; there is no unbounded self-driving loop.
- A crashed `parallel` re-runs as a whole on resume (session-mode agents gain extra turns).
- A changed spec blocks resume unless `resumeStrict=true` (reproducibility gate).
- Resume restores the workflow state/stack **and** session-mode agents' conversation memory (their persisted sessions are resumed; a missing session falls back to a fresh create).
- Materialized `agent.cordis.yml` files are configuration reference snapshots (model route / memory / tool selection are engine-owned) — not standalone runnable presets.
- Windows: the shipped examples use pure LLM reasoning; flows that use shell tools inherit the platform's bash/pwsh platform branching via the mounted preset.

## Compatibility

- Verified against dsh **0.2.1-rc.2** (seam packages `@deepseek-ai/dsh-{agent,llm,session,tools,skill-filesystem}`); the manifest declares `engines.dsh: "^0.2.0 || ^0.2.1-rc.2"` and the same range on its optional seam peers, so dsh's install-time compatibility gate rejects a mismatched runtime instead of failing later.
- Prerelease note: `^0.2.0` alone does **not** match `0.2.1-rc.2` (semver excludes prereleases unless the comparator carries the same version tuple), hence the `^0.2.1-rc.2` alternative. A hard-pinned install can be waived per exact version with `dsh plugin allow-version`.
- Setup receives the agent as its second argument; `agentCtx.agent` remains a 0.1.x fallback. The child session records `agentPreset` and `parentSession` from the parent, and the parent's composed preset is resolved via `agentPresets.composedPreset()` before falling back to `session.header.agentPreset`.
- Delegation parity: member sessions get `sandbox/mode` (from `AgentConfig.sandbox`, else the parent's explicit override) and `approval/policy: 'never'`, both with `source: 'delegation'` — a background member never blocks on an interactive approval prompt.
- Cross-version preset alias: dsh 0.2.x renamed the built-in `code` preset to `ptc`; `AgentConfig.presetId` may name either and falls back to the other (only on an unknown-preset error, retried once).
- 0.2.x presets ship `web_search`/`web_fetch` by default (fine for static pages); JS-rendered pages and browser automation still want the `playwright-cli` skill + `sandbox: 'danger-full-access'`.

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
