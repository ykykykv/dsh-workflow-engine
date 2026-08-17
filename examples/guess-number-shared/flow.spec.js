// guess-number (variant b): each guesser sees the FULL shared history.
export default {
  name: 'guess-number-shared',
  description: 'Guessing game: three guessers guess a secret 0-10 until correct (variant b: full shared history).',
  state: {
    secret: { type: 'number' },
    guess: { type: 'string' },
    lastCorrect: { type: 'boolean' },
    solved: { type: 'boolean' },
    history: { type: 'array', element: { type: 'json' } },
  },
  defaults: { timeoutMs: 120000, runTimeoutMs: 600000 },
  onError: { kind: 'abort' },
  entry: 'init',
  nodes: {
    init: {
      kind: 'agent', agent: 'referee',
      task: 'Choose a secret integer from 0 to 10 and report it.',
      outputSchema: { type: 'object', properties: { secret: { type: 'number' } }, required: ['secret'] },
      store: 'secret',
    },
    setSolved: { kind: 'set', assign: { solved: 'true' } },
    halt: { kind: 'break' },
    roundLoop: {
      kind: 'loop', until: 'solved==true', maxIter: 20,
      body: [
        {
          kind: 'agent', agent: 'g0',
          task: 'Round {loopIndex}. All previous guesses and replies: {state.history}. Guess a whole number 0-10 and output ONLY the number.',
          store: 'guess',
        },
        {
          kind: 'agent', agent: 'referee',
          task: 'The secret is {secret}. Guesser g0 guessed: {guess}. Is it correct?',
          outputSchema: { type: 'object', properties: { correct: { type: 'boolean' } }, required: ['correct'] },
          store: 'lastCorrect',
        },
        { kind: 'push', into: 'history', value: { owner: 'g0', guess: '{state.guess}', correct: '{state.lastCorrect}' } },
        { kind: 'branch', if: 'lastCorrect==true', then: ['setSolved', 'halt'] },
        {
          kind: 'agent', agent: 'g1',
          task: 'Round {loopIndex}. All previous guesses and replies: {state.history}. Guess a whole number 0-10 and output ONLY the number.',
          store: 'guess',
        },
        {
          kind: 'agent', agent: 'referee',
          task: 'The secret is {secret}. Guesser g1 guessed: {guess}. Is it correct?',
          outputSchema: { type: 'object', properties: { correct: { type: 'boolean' } }, required: ['correct'] },
          store: 'lastCorrect',
        },
        { kind: 'push', into: 'history', value: { owner: 'g1', guess: '{state.guess}', correct: '{state.lastCorrect}' } },
        { kind: 'branch', if: 'lastCorrect==true', then: ['setSolved', 'halt'] },
        {
          kind: 'agent', agent: 'g2',
          task: 'Round {loopIndex}. All previous guesses and replies: {state.history}. Guess a whole number 0-10 and output ONLY the number.',
          store: 'guess',
        },
        {
          kind: 'agent', agent: 'referee',
          task: 'The secret is {secret}. Guesser g2 guessed: {guess}. Is it correct?',
          outputSchema: { type: 'object', properties: { correct: { type: 'boolean' } }, required: ['correct'] },
          store: 'lastCorrect',
        },
        { kind: 'push', into: 'history', value: { owner: 'g2', guess: '{state.guess}', correct: '{state.lastCorrect}' } },
        { kind: 'branch', if: 'lastCorrect==true', then: ['setSolved', 'halt'] },
      ],
    },
  },
}
