# Setup — Distributed Wagering Processor

Guia de setup e comandos do serviço financeiro distribuído (NestJS + Bun + PostgreSQL + SQS) descrito
em [`README.md`](./README.md). Para decisões técnicas, trade-offs e limitações, ver
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker + Docker Compose

## Setup rápido

```bash
# 1. Dependências
bun install

# 2. Variáveis de ambiente
cp .env.example .env

# 3. Infraestrutura (Postgres + SQS/LocalStack + Keycloak)
docker compose up -d

# 4. Migrations
bun run migration:up

# 5. Subir a API
bun run start:dev
```

A API sobe em `http://localhost:3000`. Confirme que está tudo de pé:

```bash
curl http://localhost:3000/health/ready
# {"status":"ok","info":{"postgres":{"status":"up"},"sqs":{"status":"up"}},...}
```

> `docker compose up -d` sozinho já sobe **todos** os serviços de infraestrutura declarados no
> compose (`postgres`, `localstack`, `keycloak`) — a API em si roda fora do compose, via `bun run
> start`/`start:dev` (não há `Dockerfile` da aplicação neste desafio; ver "Limitações" no
> `ARCHITECTURE.md`).

## Variáveis de ambiente

Ver [`.env.example`](./.env.example) — valores padrão já funcionam com o `docker-compose.yml` como
está, sem nenhum ajuste necessário para rodar localmente.

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | conexão com o Postgres |
| `AWS_*`, `SQS_ENDPOINT`, `SQS_*_URL` | LocalStack (SQS) |
| `KEYCLOAK_ISSUER_URL`, `KEYCLOAK_AUDIENCE` | validação do JWT |

## Autenticação

Todos os endpoints HTTP (exceto `/health/*` e `/metrics`) exigem um Bearer token JWT válido emitido
pelo Keycloak (realm `jungle-gaming`, importado automaticamente do `docker-compose.yml`). Para obter
um token de teste (client `wagering-api`, fluxo `client_credentials` — pensado para chamadas
servidor-a-servidor de um provedor de jogos, sem usuário humano):

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/realms/jungle-gaming/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials' \
  -d 'client_id=wagering-api' \
  -d 'client_secret=wagering-api-secret' \
  | grep -oP '(?<="access_token":")[^"]+')

curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/wallets/<id>
```

Detalhes da decisão de auth (não vale pontos na avaliação, implementada mesmo assim) em
`ARCHITECTURE.md`, seção 8.

## Testando a API

Uma collection pronta do Insomnia está em [`docs/insomnia-collection.json`](./docs/insomnia-collection.json)
— importe via `Application → Preferences → Data → Import Data → From File`. Cobre todos os endpoints
abaixo, incluindo casos de replay idempotente, conflito de idempotência, `PENDING_REFERENCE`, saldo
insuficiente e cursor de ledger malformado.

A pasta **Auth** tem uma request pronta (`Get Token`, `client_credentials` contra o Keycloak) — rode
primeiro e cole o `access_token` da resposta na variável de ambiente `token`; as pastas **Wallets** e
**Wagering Transactions** já usam `Bearer {{ _.token }}` automaticamente em todas as requests.

### Endpoints

| Método | Rota | O quê |
|---|---|---|
| `POST` | `/wallets` | cria uma wallet (com `OPENING` se `initialBalance > 0`) |
| `GET` | `/wallets/:walletId` | consulta uma wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | extrato paginado (cursor opaco) |
| `POST` | `/wallets/:walletId/reconciliation` | recalcula o saldo a partir do ledger e compara |
| `POST` | `/wagering/transactions` | submete `BET`\|`WIN`\|`LOSS`\|`REFUND`\|`ROLLBACK` (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta transação por id |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por chave do provedor |
| `GET` | `/health/live` | liveness (sem auth) |
| `GET` | `/health/ready` | readiness — Postgres + SQS (sem auth) |
| `GET` | `/metrics` | métricas Prometheus (sem auth) |

Exemplo completo (criar wallet → apostar):

```bash
PLAYER_ID=$(uuidgen)
WALLET_ID=$(curl -s -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" \
  | grep -oP '(?<="id":")[^"]+')

curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-1\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

## Testes

```bash
bun run test              # unidade — domínio puro, sem containers
bun run test:integration  # integração — precisa de postgres + localstack de pé
bun run test:concurrency  # concorrência real — idem
```

Testes de integração/concorrência sobem o `AppModule` completo (incluindo o consumer SQS e os
workers agendados) contra infraestrutura real — não usam mocks de Postgres/SQS. Rode a infra antes:

```bash
docker compose up -d postgres localstack
bun run migration:up
bun run test:integration
bun run test:concurrency
```

(Não precisam do Keycloak — os testes chamam os use cases diretamente, sem passar pela camada HTTP
autenticada.)

94 testes no total (66 unidade + 17 integração + 11 concorrência). Detalhes de cobertura por cenário
em `ARCHITECTURE.md`, seção 10.

## Migrations

```bash
bun run migration:up            # aplica todas as pendentes
bun run migration:down          # reverte a última
bun run migration:pending       # lista pendentes
bun run migration:create --name NomeDaMigration --blank
```

## Observabilidade

- **Logs**: JSON estruturado (`nestjs-pino`) — inclui `correlationId`, `causationId`, `messageId`,
  `transactionId`, `walletId`, `providerId` conforme aplicável; nunca valores monetários nem o
  header `Authorization`.
- **Métricas**: `GET /metrics` (formato Prometheus) — transações por status, duplicatas (negócio e
  entrega), retries, mensagens em DLQ, outbox lag, latência de processamento.
- **Health**: `GET /health/live` (processo vivo) e `GET /health/ready` (Postgres + SQS alcançáveis).

## Estrutura do projeto

```
src/
  shared/            Money, IntegrationEvent, erros de domínio, utilitários (hash, backoff, id)
  modules/
    wallets/          domain/ application/ infrastructure/ interface/ — o núcleo financeiro
    messaging/         Inbox, Outbox, SQS publisher/consumer, worker de publicação
    auth/               guard JWT (Keycloak)
    observability/     health checks, métricas
test/
  unit/                use cases com repositórios fake — sem containers
  integration/         Postgres + LocalStack reais
  concurrency/          paralelismo real (Promise.all, múltiplas instâncias)
  support/              bootstrap de app e fakes para testes
docker/
  localstack/          init das filas SQS
  keycloak/             realm importado no boot
```

## Diferenciais não implementados

- **Teste de carga**: não implementado — é diferencial opcional (não pontua), descartado para
  priorizar os requisitos obrigatórios dentro do tempo disponível.
- **Ledger de partidas dobradas** (double-entry bookkeeping): fora de escopo, também diferencial.

Justificativas completas de cada decisão de arquitetura, incluindo trade-offs considerados e
descartados, estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).
