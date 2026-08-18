// roundtable: structured discussion of a direction. Support vs critic debate
// in parallel rounds; the chair routes on convergence (decision routing);
// the scribe writes a report. Not converged by the round cap -> fail.
export default {
  name: 'roundtable',
  description: 'Structured roundtable discussion of a direction: parallel support/critique rounds, chair convergence routing, scribe report. Input contract: input.topic (required string).',
  state: {
    topic: { type: 'string', required: true },
    converged: { type: 'boolean' },
    feedback: { type: 'string' },
    minutes: { type: 'array', element: { type: 'json' } },
    reportPath: { type: 'string' },
    reportText: { type: 'string' },
  },
  defaults: { timeoutMs: 300000, runTimeoutMs: 3600000 },
  onError: { kind: 'retry', max: 1 },
  outputs: ['{flowId}/runs/{runId}/workspace/scribe/output/report.md'],
  entry: 'flow',
  nodes: {
    flow: { kind: 'sequence', nodes: ['setup', 'discuss', 'setReportPath', 'scribe', 'outcome'] },
    setup: { kind: 'set', assign: { converged: 'false', feedback: '' } },
    setConverged: { kind: 'set', assign: { converged: 'true' } },
    setFeedback: { kind: 'set', assign: { feedback: '{chair.feedback}' } },
    halt: { kind: 'break' },
    discuss: {
      kind: 'loop', until: 'converged==true', maxIter: 4,
      body: [
        { kind: 'emit', event: 'phase', payload: { round: '{loopIndex}' } },
        {
          kind: 'parallel',
          branches: [
            [
              {
                kind: 'agent', agent: 'supporter',
                task: '对讨论方向 "{topic}" 给出支持/正面观点（1-3 条，具体）。参考已有讨论记录：{state.minutes}。主席上轮反馈（如有）：{feedback ?? 无}。',
                store: 'supporterView',
              },
            ],
            [
              {
                kind: 'agent', agent: 'critic',
                task: '对讨论方向 "{topic}" 给出质疑/风险观点（1-3 条，具体）。参考已有讨论记录：{state.minutes}。主席上轮反馈（如有）：{feedback ?? 无}。',
                store: 'criticView',
              },
            ],
          ],
        },
        { kind: 'push', into: 'minutes', value: { round: '{loopIndex}', supporter: '{state.supporterView}', critic: '{state.criticView}' } },
        {
          kind: 'decision', agent: 'chair', routeField: 'converged',
          task: '综合讨论记录判断是否收敛（能否达成一致/收尾）：{state.minutes}。若可收尾：converged=true 并给最终 feedback；否则 converged=false 并给下一轮聚焦的 feedback。',
          outputSchema: { type: 'object', properties: { converged: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['converged'] },
          store: 'chair',
          cases: { 'true': ['setConverged', 'halt'], 'false': 'setFeedback' },
        },
      ],
    },
    setReportPath: { kind: 'set', assign: { reportPath: '{flowId}/runs/{runId}/workspace/scribe/output/report.md' } },
    scribe: {
      kind: 'agent', agent: 'scribe',
      task: '基于讨论记录写一份"圆桌讨论报告"中文 Markdown 文件，用 write 工具写入绝对路径：{reportPath}。报告需含：讨论方向（{topic}）、各轮观点（{state.minutes}）、是否收敛（{converged}）、主席结论/反馈（{feedback ?? 无}）、最终结论。写完后用一句话确认已写入。',
      store: 'reportText',
    },
    outcome: { kind: 'branch', if: '!converged', then: { kind: 'fail', message: '讨论未收敛' } },
  },
}
