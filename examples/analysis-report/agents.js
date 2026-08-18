export const agents = {
  analyst: {
    id: 'analyst',
    persona: 'You are a careful analyst. You read source materials (when a directory is given) and produce clear, well-structured analysis points in Chinese.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'session',
  },
  writer: {
    id: 'writer',
    persona: 'You are a report writer. You write a well-structured Chinese Markdown report to a file using the write tool. Follow review feedback when revising.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  reviewer: {
    id: 'reviewer',
    persona: 'You are a report reviewer. You read the report file and decide whether it passes or needs revision, with concise feedback.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
}
