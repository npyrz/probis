export function logStartup(env) {
  console.log('[probis] API booting');
  console.log(`[probis] Trading credentials configured: ${env.hasTradingCredentials ? 'yes' : 'no'}`);
  if (!env.hasTradingCredentials) {
    console.log(`[probis] Missing env keys: ${env.missing.join(', ')}`);
  }
}