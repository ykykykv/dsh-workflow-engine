// department-flow: supervisor routes a task to budget or logistics; the
// department supervisor assigns, the employee completes, review loops until
// approved, then the result returns to the overall supervisor.
export default {
  name: 'department-flow',
  description: 'Supervisor routes a task to budget or logistics; department assign->execute->review loop until approved, then report back.',
  state: {
    taskText: { type: 'string', required: true },
    dept: { type: 'string' },
    assignment: { type: 'json' },
    work: { type: 'string' },
    review: { type: 'json' },
    approved: { type: 'boolean' },
    done: { type: 'string' },
  },
  defaults: { timeoutMs: 120000, runTimeoutMs: 600000 },
  onError: { kind: 'abort' },
  entry: 'route',
  nodes: {
    route: {
      kind: 'decision', agent: 'supervisor',
      task: 'Decide which department should handle this task: "{taskText}". Route to budget or logistics.',
      outputSchema: { type: 'object', properties: { dept: { type: 'string', enum: ['budget', 'logistics'] } }, required: ['dept'] },
      store: 'dept',
      cases: { budget: 'budgetFlow', logistics: 'logisticsFlow' },
    },
    setApproved: { kind: 'set', assign: { approved: 'true' } },
    budgetFlow: {
      kind: 'sequence',
      nodes: [
        {
          kind: 'agent', agent: 'deptBudgetSup',
          task: 'Assign this task to your budget employee: "{taskText}". Produce an assignment with an assignee and concrete detail.',
          outputSchema: { type: 'object', properties: { assignee: { type: 'string' }, detail: { type: 'string' } }, required: ['assignee', 'detail'] },
          store: 'assignment',
        },
        {
          kind: 'loop', until: 'approved==true', maxIter: 10,
          body: [
            {
              kind: 'agent', agent: 'empBudget',
              task: 'Complete this task: {assignment.detail}. Previous review feedback (if any): {review.feedback ?? none}.',
              store: 'work',
            },
            {
              kind: 'agent', agent: 'deptBudgetSup',
              task: 'Review your employee\'s work for the task "{taskText}":\n{work}\nApprove or reject with feedback.',
              outputSchema: { type: 'object', properties: { approved: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['approved'] },
              store: 'review',
            },
            { kind: 'branch', if: 'review.approved==true', then: 'setApproved' },
          ],
        },
        { kind: 'agent', agent: 'supervisor', task: 'The budget department finished. Final review: {review}. Report the completed result.', store: 'done' },
      ],
    },
    logisticsFlow: {
      kind: 'sequence',
      nodes: [
        {
          kind: 'agent', agent: 'deptLogisticsSup',
          task: 'Assign this task to your logistics employee: "{taskText}". Produce an assignment with an assignee and concrete detail.',
          outputSchema: { type: 'object', properties: { assignee: { type: 'string' }, detail: { type: 'string' } }, required: ['assignee', 'detail'] },
          store: 'assignment',
        },
        {
          kind: 'loop', until: 'approved==true', maxIter: 10,
          body: [
            {
              kind: 'agent', agent: 'empLogistics',
              task: 'Complete this task: {assignment.detail}. Previous review feedback (if any): {review.feedback ?? none}.',
              store: 'work',
            },
            {
              kind: 'agent', agent: 'deptLogisticsSup',
              task: 'Review your employee\'s work for the task "{taskText}":\n{work}\nApprove or reject with feedback.',
              outputSchema: { type: 'object', properties: { approved: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['approved'] },
              store: 'review',
            },
            { kind: 'branch', if: 'review.approved==true', then: 'setApproved' },
          ],
        },
        { kind: 'agent', agent: 'supervisor', task: 'The logistics department finished. Final review: {review}. Report the completed result.', store: 'done' },
      ],
    },
  },
}
