/**
 * Preload de bun test (bunfig.toml): carrega as mesmas variáveis do .env.example, sem sobrescrever
 * o que já estiver no ambiente. Testes de integração/concorrência batem em Postgres/LocalStack
 * reais (docker compose up -d postgres localstack) — não precisam do Keycloak, que só é consultado
 * de verdade (JWKS) quando um token é validado, algo que testes de use case não fazem.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const envPath = join(process.cwd(), '.env.example');
const content = readFileSync(envPath, 'utf8');

for (const line of content.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx === -1) continue;
  const key = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + 1).trim();
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

process.env.SQS_INTEGRATION_EVENTS_QUEUE_URL ??=
  'http://localhost:4566/000000000000/wager-integration-events.fifo';
