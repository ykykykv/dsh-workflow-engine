// file-inspect: inspect a specific file and/or a directory's contents and
// produce a Markdown report. At least one of input.file / input.dir is needed.
export default {
  name: 'file-inspect',
  description: 'Inspect a specific file and/or a directory\'s contents and produce a reviewed Markdown report. Input contract: input.file (optional string, absolute or relative to the session workspace); input.dir (optional string); at least one required.',
  state: {
    file: { type: 'string' },
    dir: { type: 'string' },
    notes: { type: 'string' },
    reportPath: { type: 'string' },
    reportText: { type: 'string' },
  },
  defaults: { timeoutMs: 300000, runTimeoutMs: 3600000 },
  onError: { kind: 'retry', max: 1 },
  outputs: ['{flowId}/runs/{runId}/workspace/reporter/output/report.md'],
  entry: 'flow',
  nodes: {
    flow: { kind: 'sequence', nodes: ['check', 'inspect', 'setReportPath', 'report'] },
    check: { kind: 'branch', if: '!file && !dir', then: { kind: 'fail', message: 'file-inspect: provide input.file and/or input.dir' } },
    inspect: {
      kind: 'agent', agent: 'inspector',
      task: '读取指定文件（若提供）：{file ?? 无}；查看指定目录的内容（若提供）：{dir ?? 无}。请用 read / 文件搜索工具读取内容或列出目录文件，然后给出结构清晰的要点（中文）。',
      store: 'notes',
    },
    setReportPath: { kind: 'set', assign: { reportPath: '{flowId}/runs/{runId}/workspace/reporter/output/report.md' } },
    report: {
      kind: 'agent', agent: 'reporter',
      task: '基于检查要点写一份"文件/目录检查报告"中文 Markdown 文件，用 write 工具写入绝对路径：{reportPath}。报告需含：检查对象（文件 {file ?? 无}、目录 {dir ?? 无}）、检查要点（{notes}）、结论。写完后用一句话确认已写入。',
      store: 'reportText',
    },
  },
}
