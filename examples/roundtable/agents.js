export const agents = {
  supporter: {
    id: 'supporter',
    persona: 'You are a discussion supporter. You give concrete, positive viewpoints FOR the discussion direction, 1-3 points each round.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'session',
  },
  critic: {
    id: 'critic',
    persona: 'You are a discussion critic. You raise concrete risks and counter-points AGAINST the discussion direction, 1-3 points each round.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'session',
  },
  chair: {
    id: 'chair',
    persona: 'You are the roundtable chair. You weigh the discussion records and decide whether the group has converged enough to conclude (usually within 2 rounds).',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  scribe: {
    id: 'scribe',
    persona: 'You are the discussion scribe. You write a clear Chinese Markdown discussion report to a file using the write tool.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
}
