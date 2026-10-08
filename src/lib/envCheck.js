// src/lib/envCheck.js
// Production readiness of an environment (process.env shape) — pure.
// Used by scripts/check-env.mjs (npm run ops:check-env) and at boot.

/**
 * @param {Record<string, string|undefined>} e
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkProductionEnv(e) {
  const errors = []
  const warnings = []
  const val = (k) => (e[k] ?? '').trim()

  if (val('NODE_ENV') !== 'production') warnings.push('NODE_ENV não é "production" (dev deixa o painel sem login e o Swagger aberto).')

  for (const k of ['MONGO_URI', 'REDIS_URL', 'UDP_HOST', 'UDP_PORT']) {
    if (!val(k)) errors.push(`${k} está vazio (obrigatório).`)
  }

  const pw = val('OPERATOR_PASSWORD')
  if (!pw) errors.push('OPERATOR_PASSWORD está vazio: o servidor não sobe em produção sem ele.')
  else if (pw.length < 16) warnings.push(`OPERATOR_PASSWORD tem ${pw.length} caracteres; use 16 ou mais (aleatória).`)
  if (pw.startsWith('<')) errors.push('OPERATOR_PASSWORD ainda é o valor de exemplo.')

  const url = val('PUBLIC_URL')
  if (!url) errors.push('PUBLIC_URL está vazio: os QR Codes apontariam para http://localhost:3000.')
  else if (url.includes('<')) errors.push('PUBLIC_URL ainda é o valor de exemplo.')
  else if (!url.startsWith('https://')) warnings.push('PUBLIC_URL não é https: o cookie de login não sai como Secure e o celular pode bloquear a câmera/QR.')
  else if (/localhost|127\.0\.0\.1/.test(url)) warnings.push('PUBLIC_URL aponta para localhost: celulares não alcançam esse endereço.')

  if (!['true', '1'].includes(val('TRUST_PROXY').toLowerCase())) {
    warnings.push('TRUST_PROXY não está ligado: atrás do nginx os limites por IP valem para todo mundo junto.')
  }

  if (!val('EMBED_FRAME_ANCESTORS') || val('EMBED_FRAME_ANCESTORS') === '*') {
    warnings.push('EMBED_FRAME_ANCESTORS libera qualquer site a incorporar os jogos. Restrinja se só seus sites devem usar.')
  }

  const days = Number(val('SESSION_RETENTION_DAYS') || '90')
  if (!Number.isFinite(days) || days < 0) errors.push('SESSION_RETENTION_DAYS precisa ser um número ≥ 0.')
  else if (days > 0 && days < 30) warnings.push('SESSION_RETENTION_DAYS < 30 apaga partidas que o histórico de 30 dias ainda mostraria.')

  return { errors, warnings }
}
