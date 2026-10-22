# Changelog

## 0.0.20 — 2026-10-22 (unreleased)

### Added

- **Background runs** (`background: true`): the run is registered as an owned `ctx.jobs`
  job and the tool returns `{ stopReason: 'started', jobId, runId }` immediately, so a long
  flow no longer holds the parent turn. Phase changes feed the job progress line and
  `tool-workflow/*` narration lands in the job output ring; the settled job carries the same
  JSON as a foreground call. A background run requires a positive run budget
  (`flow defaults.runTimeoutMs` or plugin `runTimeoutMs`) and is rejected otherwise.
  Job outcomes are `completed | killed | failed`; `paused` settles as `failed` with a
  `paused: … (runId=…)` detail (the job vocabulary has no `paused`).
- **Bounded auto-resume** (`autoResume`, 0–3, background only): a paused background run
  resumes itself up to N times, each resume spending one fresh budget window, so total work
  stays bounded by `budget × (N + 1)`. Default 0.
- **Run-level lease** (`runs/<runId>/lease.json`, 5s heartbeat, 30s TTL): one writer per run.
  A concurrent manual resume while a background job owns the run is rejected with the current
  owner and expiry; a lease left by a crashed process needs `takeover: true`. This closes the
  last-writer-wins window between a manual resume and a background job.

### Changed

- `paused` and `cancelled` results now carry a `message` with the exact resume/kill guidance
  plus a `checkpointPath`, instead of only the state.

### Tests

- Lease acquisition/conflict/expiry/takeover/release, job-outcome mapping, and the bounded
  auto-resume loop are unit-tested; the compatibility harness gained two probes (background
  job + auto-resume, concurrent-writer rejection) and now runs 10 probes against a real dsh
  profile.

## 0.0.19 — 2026-10-22 (unreleased)

### Added

- `state.<field>.path: true`: a string input declared as a path is resolved against the
  session workspace when the flow loads, so member agents (whose cwd is their own
  run-isolated workspace) receive an absolute path. `file-inspect` (`file`, `dir`) and
  `analysis-report` (`sourceDir`) now declare it; `run_workflow flow: 'file-inspect'
  input: { file: './README.md', dir: './examples' }` works as documented.
- `npm run typecheck:dsh` (`scripts/typecheck-dsh.mjs`): type-check against the seam
  packages of the **deployed** dsh installation (`$DSH_SEAMS_DIR` or
  `~/.dsh/profiles/node_modules/@deepseek-ai`). Wired into `npm run check`.

### Fixed

- A run that paused before its first node completed left no checkpoint (a later resume
  failed with `ENOENT`). The engine now writes an initial checkpoint, and a genuinely
  missing checkpoint yields a readable error instead of a raw filesystem one.
- Flow modules are cache-busted by `mtime+size`, so editing `flow.spec.js` / `agents.js`
  takes effect within one process and the `resumeStrict` spec-changed gate is meaningful.
- Materialized `agent.cordis.yml` snapshots report the real package version instead of a
  hard-coded one.
- `workspaceRoot` falls back to the sandbox policy root (then fails loudly) instead of
  silently using `process.cwd()`.
- `src/index.ts` contained three invalid UTF-8 byte sequences; it is valid UTF-8 again.

### Changed

- Manifest: `engines.dsh: "^0.2.0 || ^0.2.1-rc.2"`; the seam packages are declared as
  **optional** peer dependencies (dsh provides them through its healed profile tree) and
  devDependencies are realigned to 0.2.1-rc.2. Prerelease note: `^0.2.0` alone does not
  match `0.2.1-rc.2`, hence the second alternative.
- Per-agent sessions record `agentPreset` + `parentSession`, inherit the parent's composed
  preset (`agentPresets.composedPreset()` first, `session.header.agentPreset` as fallback),
  pin `approval/policy: 'never'` so background members never block on an approval prompt,
  and inherit the parent's explicit sandbox override when `AgentConfig.sandbox` is unset.
- `AgentConfig.sandbox` is typed as the exported `SandboxMode`.
- PR4 documentation/assets: README compatibility and install references updated,
  CHANGELOG added, generated run directories ignored, stale `0.0.1` / `0.0.15` tarballs
  removed.

## 0.0.18 — 2026-10-22 (unreleased)

- dsh 0.2.1-rc.2 compatibility: `AgentSetup` typed against the real `Agent` (0.1.x
  `agentCtx.agent` retained as fallback), platform event declarations for
  `sandbox/mode` / `approval/policy`, optional seam peers + `engines.dsh`, and a
  deployment-seam typecheck (`typecheck:dsh`).
- Verified with 7 probes (`compat-audit/run-probes.mjs`) against a real dsh `compat`
  profile: composition, `list`, agent call, decision/structured output, flow reload,
  pause→resume with session memory, and first-node pause.

## 0.0.17 — previous GitHub tag

See the repository history before this release.
