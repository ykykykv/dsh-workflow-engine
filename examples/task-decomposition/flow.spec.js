// task-decomposition: outer re-split loop + inner per-task analysis loop.
// Each task runs pro/con analysts in parallel, a reviewer decides
// pass/fail/reanalyze (capped); a rejected split skips the analysis round;
// failures trigger a re-split reviewer whose advice feeds the next split.
// Overall attempt cap without all-pass -> the run fails.
export default {
  name: 'task-decomposition',
  description: 'Task supervisor splits a large task; per-task parallel pro/con analysis with reviewer loop; failures trigger re-split (capped); cap exhaustion fails the run. Input contract: input.bigTask (required string).',
  state: {
    bigTask: { type: 'string', required: true },
    splitResult: { type: 'json' },
    splitReview: { type: 'json' },
    resplitAdvice: { type: 'string' },
    rPro: { type: 'string' },
    rCon: { type: 'string' },
    judge: { type: 'json' },
    verdictDone: { type: 'boolean' },
    guidance: { type: 'string' },
    results: { type: 'array', element: { type: 'json' } },
    allPass: { type: 'boolean' },
  },
  defaults: { timeoutMs: 120000, runTimeoutMs: 3600000 },
  onError: { kind: 'abort' },
  entry: 'flow',
  nodes: {
    setVerdictDone: { kind: 'set', assign: { verdictDone: 'true' } },
    setAllPass: { kind: 'set', assign: { allPass: 'true' } },
    resetTask: { kind: 'set', assign: { verdictDone: 'false', guidance: '' } },
    setResplitAdvice: { kind: 'set', assign: { resplitAdvice: '{splitReview.advice}' } },
    fail: { kind: 'fail', message: 'task decomposition did not complete within the attempt limit' },
    flow: { kind: 'sequence', nodes: ['outerLoop', 'checkDone'] },
    checkDone: { kind: 'branch', if: '!allPass', then: 'fail' },
    outerLoop: {
      kind: 'loop', until: 'allPass==true', maxIter: 3,
      body: [
        {
          kind: 'agent', agent: 'taskSup',
          task: 'Split this large task into achievable small tasks: "{bigTask}". Previous re-split advice (if any): {resplitAdvice ?? none}.',
          outputSchema: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'string' } } }, required: ['tasks'] },
          store: 'splitResult',
        },
        {
          kind: 'agent', agent: 'splitReviewer',
          task: 'Check whether this split is sound. Tasks: {splitResult.tasks}.',
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, advice: { type: 'string' } }, required: ['ok'] },
          store: 'splitReview',
        },
        {
          kind: 'branch', if: 'splitReview.ok==false',
          then: 'setResplitAdvice',
          else: [
            {
              kind: 'map', items: 'splitResult.tasks', as: 't', forEach: [
                'resetTask',
                {
                  kind: 'loop', until: 'verdictDone==true', maxIter: 3,
                  body: [
                    {
                      kind: 'parallel',
                      branches: [
                        [
                          {
                            kind: 'agent', agent: 'analystPro',
                            task: 'Is this small task feasible? Provide evidence. Task: {t}. Extra guidance: {guidance ?? none}.',
                            store: 'rPro',
                          },
                        ],
                        [
                          {
                            kind: 'agent', agent: 'analystCon',
                            task: 'Is this small task NOT feasible? Provide evidence. Task: {t}. Extra guidance: {guidance ?? none}.',
                            store: 'rCon',
                          },
                        ],
                      ],
                    },
                    {
                      kind: 'agent', agent: 'smallReviewer',
                      task: 'Combine the two reports for task "{t}".\nPRO:\n{rPro}\nCON:\n{rCon}\nDecide pass, fail, or reanalyze (with guidance).',
                      outputSchema: { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail', 'reanalyze'] }, guidance: { type: 'string' } }, required: ['verdict'] },
                      store: 'judge',
                    },
                    {
                      kind: 'branch', if: 'judge.verdict=="reanalyze"',
                      then: { kind: 'set', assign: { guidance: '{judge.guidance}' } },
                      else: 'setVerdictDone',
                    },
                  ],
                },
                {
                  kind: 'push', into: 'results', value: {
                    task: '{t}',
                    verdict: '{judge.verdict}',
                    pro: '{state.rPro}',
                    con: '{state.rCon}',
                  },
                },
              ],
            },
            {
              kind: 'branch', if: "all(results, verdict, 'pass')",
              then: 'setAllPass',
              else: [
                {
                  kind: 'agent', agent: 'resplitReviewer',
                  task: 'Summarize all task reports and identify the split problems, then give advice. Reports: {state.results}.',
                  outputSchema: { type: 'object', properties: { problems: { type: 'string' }, advice: { type: 'string' } }, required: ['problems', 'advice'] },
                  store: 'splitReview',
                },
                'setResplitAdvice',
              ],
            },
          ],
        },
      ],
    },
  },
}
