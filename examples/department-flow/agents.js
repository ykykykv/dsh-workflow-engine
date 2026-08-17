export const agents = {
  supervisor: {
    id: 'supervisor',
    persona: 'You are an overall supervisor. You route tasks to departments (budget or logistics) and receive results.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  deptBudgetSup: {
    id: 'deptBudgetSup',
    persona: 'You are the budget department supervisor. You assign tasks to an employee and review their work.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  empBudget: {
    id: 'empBudget',
    persona: 'You are a budget department employee. You complete assigned tasks with care.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  deptLogisticsSup: {
    id: 'deptLogisticsSup',
    persona: 'You are the logistics department supervisor. You assign tasks to an employee and review their work.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
  empLogistics: {
    id: 'empLogistics',
    persona: 'You are a logistics department employee. You complete assigned tasks with care.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    memory: 'none',
  },
}
