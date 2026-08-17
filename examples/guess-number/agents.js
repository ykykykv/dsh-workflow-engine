export const agents = {
  g0: { id: 'g0', persona: 'You are a guesser in a number guessing game. You guess a whole number 0-10.', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, memory: 'session' },
  g1: { id: 'g1', persona: 'You are a guesser in a number guessing game. You guess a whole number 0-10.', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, memory: 'session' },
  g2: { id: 'g2', persona: 'You are a guesser in a number guessing game. You guess a whole number 0-10.', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, memory: 'session' },
  referee: { id: 'referee', persona: 'You are the referee of a number guessing game. You hold a secret number and judge each guess.', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, memory: 'none' },
}
