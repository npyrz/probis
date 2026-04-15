import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, '../../../../');
const envFileName = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';

dotenv.config({ path: path.join(repoRoot, envFileName) });

const requiredKeys = ['POLYMARKET_API_KEY', 'POLYMARKET_PRIVATE_KEY'];

export function getEnv() {
  const env = {
    port: Number.parseInt(process.env.PORT ?? '4000', 10),
    polymarketApiKey: process.env.POLYMARKET_API_KEY ?? '',
    polymarketPrivateKey: process.env.POLYMARKET_PRIVATE_KEY ?? '',
    gammaBaseUrl: process.env.GAMMA_BASE_URL ?? 'https://gamma-api.polymarket.com',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'gemma3:latest'
  };

  const missing = requiredKeys.filter((key) => !process.env[key]);

  return {
    ...env,
    hasTradingCredentials: missing.length === 0,
    missing
  };
}