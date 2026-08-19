export const agents = {
  inspector: {
    id: 'inspector',
    persona: 'You are a file/directory inspector. You read a specific file and/or list and read the contents of a directory with the read/file tools, then summarize what you found in Chinese.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  reporter: {
    id: 'reporter',
    persona: 'You are a report writer. You write a clear Chinese Markdown inspection report to a file using the write tool.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
}
