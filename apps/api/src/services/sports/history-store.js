import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, '../../../../../');
const SPORTS_DATA_DIRECTORY = path.join(repoRoot, 'data', 'sports');
const TEAM_UNIVERSE_FILE = path.join(SPORTS_DATA_DIRECTORY, 'polymarket-us-teams.json');
const TEAM_HISTORY_FILE = path.join(SPORTS_DATA_DIRECTORY, 'team-history.json');

const DEFAULT_TEAM_UNIVERSE = {
  version: 1,
  generatedAt: null,
  marketCount: 0,
  teamCount: 0,
  teams: [],
  markets: []
};

const DEFAULT_TEAM_HISTORY = {
  version: 1,
  generatedAt: null,
  games: []
};

async function ensureSportsDirectory() {
  await mkdir(SPORTS_DATA_DIRECTORY, { recursive: true });
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await ensureSportsDirectory();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function loadPolymarketUsTeamUniverse() {
  await ensureSportsDirectory();
  return readJsonFile(TEAM_UNIVERSE_FILE, DEFAULT_TEAM_UNIVERSE);
}

export async function savePolymarketUsTeamUniverse(snapshot) {
  await writeJsonFile(TEAM_UNIVERSE_FILE, snapshot);
}

export async function loadSportsHistoryStore() {
  await ensureSportsDirectory();
  return readJsonFile(TEAM_HISTORY_FILE, DEFAULT_TEAM_HISTORY);
}

export async function saveSportsHistoryStore(store) {
  await writeJsonFile(TEAM_HISTORY_FILE, store);
}

function getGameKey(game) {
  return [
    game?.league ?? '',
    game?.date ?? '',
    game?.homeTeamId ?? '',
    game?.awayTeamId ?? ''
  ].join('|');
}

export async function mergeSportsHistoryGames(games, options = {}) {
  const existing = await loadSportsHistoryStore();
  const merged = new Map(
    (Array.isArray(existing.games) ? existing.games : []).map((game) => [getGameKey(game), game])
  );

  for (const game of Array.isArray(games) ? games : []) {
    merged.set(getGameKey(game), game);
  }

  const nextStore = {
    version: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    games: [...merged.values()].sort((left, right) => String(left.date ?? '').localeCompare(String(right.date ?? '')))
  };

  await saveSportsHistoryStore(nextStore);

  return {
    store: nextStore,
    insertedCount: Math.max(0, nextStore.games.length - (Array.isArray(existing.games) ? existing.games.length : 0)),
    totalCount: nextStore.games.length
  };
}

export function getSportsDataPaths() {
  return {
    sportsDataDirectory: SPORTS_DATA_DIRECTORY,
    teamUniverseFile: TEAM_UNIVERSE_FILE,
    teamHistoryFile: TEAM_HISTORY_FILE
  };
}