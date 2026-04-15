import dotenv from 'dotenv';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const requiredKeys = ['POLYMARKET_API_KEY', 'POLYMARKET_PRIVATE_KEY'];

export function getEnv() {
  const env = {
    port: Number.parseInt(process.env.PORT ?? '4000', 10),
    polymarketApiKey: process.env.POLYMARKET_API_KEY ?? '',
    polymarketPrivateKey: process.env.POLYMARKET_PRIVATE_KEY ?? '',
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