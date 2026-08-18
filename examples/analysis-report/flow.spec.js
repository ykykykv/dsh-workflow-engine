// analysis-report: analyze a subject (optionally reading a source directory)
// and produce a reviewed Markdown report file. The writer writes into its own
// workspace; the engine collects the declared output to outputDir/<runId>/.
export default {
  name: 'analysis-report',
  description: 'Analyze a subject (optionally reading a source directory) and produce a reviewed Markdown report file.',
  state: {
    subject: { type: 'string', required: true },
    sourceDir: { type: 'string' },
    analysis: { type: 'string' },
    reportPath: { type: 'string' },
    reportText: { type: 'string' },
    review: { type: 'json' },
    approved: { type: 'boolean' },
  },
  defaults: { timeoutMs: 120000, runTimeoutMs: 3600000 },
  onError: { kind: 'abort' },
  outputs: ['{flowId}/runs/{runId}/workspace/writer/output/report.md'],
  entry: 'analyze',
  nodes: {
    analyze: {
      kind: 'agent', agent: 'analyst',
      task: '分析主题："{subject}"。资料目录：{sourceDir ?? 无（基于你的知识分析）}。若资料目录存在，请用 read/文件搜索工具阅读其中的材料作为依据，然后给出你的分析要点（结构清晰，中文）。',
      store: 'analysis',
    },
    setReportPath: { kind: 'set', assign: { reportPath: '{flowId}/runs/{runId}/workspace/writer/output/report.md' } },
    setApproved: { kind: 'set', assign: { approved: 'true' } },
    reportLoop: {
      kind: 'loop', until: 'approved==true', maxIter: 3,
      body: [
        {
          kind: 'agent', agent: 'writer',
          task: '根据以下分析撰写一份中文 Markdown 报告，并用 write 工具写入文件（绝对路径）：{reportPath}\n\n分析要点：\n{analysis}\n\n上次审阅反馈（如有）：{review.feedback ?? 无}\n\n报告需含：标题、关键要点、结论。写完后用一句话确认文件已写入。',
          store: 'reportText',
        },
        {
          kind: 'agent', agent: 'reviewer',
          task: '用 read 工具阅读文件 {reportPath} 的完整内容，审阅报告质量（结构、准确、覆盖分析要点），并判定是否通过。',
          outputSchema: { type: 'object', properties: { approved: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['approved'] },
          store: 'review',
        },
        { kind: 'branch', if: 'review.approved==true', then: 'setApproved' },
      ],
    },
  },
}
