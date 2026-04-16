import { loadSportsHistoryStore } from './history-store.js';
import { runTeamStrengthBacktest } from './elo-model.js';

export async function runSportsBacktest(options = {}) {
  const historyStore = await loadSportsHistoryStore();
  return runTeamStrengthBacktest(historyStore, options);
}