export const agents = {
  taskSup: {
    id: 'taskSup',
    persona: 'You are a task supervisor. You split a large task into achievable small tasks and revise the split based on review advice.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  splitReviewer: {
    id: 'splitReviewer',
    persona: 'You are a split reviewer. You check whether a task split is sound and point out problems.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  analystPro: {
    id: 'analystPro',
    persona: 'You are a feasibility analyst who argues that a small task IS feasible, with evidence.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  analystCon: {
    id: 'analystCon',
    persona: 'You are a feasibility analyst who argues that a small task is NOT feasible, with evidence.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  smallReviewer: {
    id: 'smallReviewer',
    persona: 'You are a small-task reviewer. You combine pro/con analyst reports and decide pass, fail, or re-analyze with guidance.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  resplitReviewer: {
    id: 'resplitReviewer',
    persona: 'You are a re-split reviewer. You summarize all task reports, identify split problems, and give advice to the supervisor.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
}
