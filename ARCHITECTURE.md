# ARCHITECTURE.md

Decisões técnicas, trade-offs e limitações do Distributed Wagering Processor. Organizado em torno
das áreas centrais do sistema: correção financeira, concorrência, idempotência, mensageria e falhas,
modelagem e arquitetura, testes, observabilidade.

**Índice**: [1. Visão geral](#1-visão-geral-e-estilo-arquitetural) ·
[2. Stack](#2-stack-e-escolhas-de-ferramentas) ·
[3. Correção financeira](#3-correção-financeira) ·
[4. Concorrência](#4-concorrência--unidade-walletid) · [5. Idempotência](#5-idempotência) ·
[6. Mensageria e recuperação de falhas](#6-mensageria-e-recuperação-de-falhas) ·
[7. API HTTP](#7-api-http) · [8. Autenticação](#8-autenticação) ·
[9. Observabilidade](#9-observabilidade) · [10. Testes](#10-testes) ·
[11. Limitações](#11-limitações-conhecidas--fora-de-escopo)

---

## 1. Visão geral e estilo arquitetural

Serviço único NestJS (não microserviços). A `Wallet` e a `WagerTransaction` são transacionalmente
acopladas — toda mudança de saldo precisa de um lançamento de ledger correspondente na **mesma
transação SQL** — então separá-las em bounded contexts/serviços distintos exigiria coordenação
distribuída (saga, 2PC) sem ganho real para o escopo deste desafio. A separação é por **camada**
(hexagonal/DDD), não por serviço:

```
src/
  shared/domain/         Money, DomainError, FailureCode, IntegrationEvent — sem dependência de ORM/Nest
  modules/wallets/        domain/ application/ infrastructure/ interface/
  modules/messaging/      Inbox, Outbox, SQS publisher/consumer, workers agendados
  modules/auth/           Keycloak JWT guard
  modules/observability/  logging, métricas, health
```

Todas as instâncias da aplicação rodam o processo completo (API HTTP + consumer SQS + workers via
`@nestjs/schedule`) — não há um serviço "worker" separado. É isso que faz os cenários de "3+
instâncias" e "múltiplos publishers concorrentes na outbox" acontecerem naturalmente ao escalar
`docker-compose` horizontalmente, sem infraestrutura extra.

## 2. Stack e escolhas de ferramentas

| Decisão | Escolha | Por quê |
|---|---|---|
| Runtime/test runner | Bun 1.4.0 | Exigido pelo desafio. |
| ORM | MikroORM | Preferencial no desafio: `EntityManager.transactional()` encapsula bem "tudo na mesma transação SQL", e `LockMode` dá pessimistic locking nativo e explícito — encaixa direto na estratégia de concorrência da seção 4. |
| Concorrência de wallet | Pessimistic locking (`SELECT ... FOR UPDATE`) | Ver seção 4. |
| Auth | Keycloak (OIDC) | Autenticação real via OIDC, protegendo os endpoints HTTP — ver seção 8. |
| TypeScript | `strict: true` de verdade | O `tsconfig.json` gerado pelo `@nestjs/cli` vem com vários relaxamentos (`noImplicitAny: false`, etc.); removidos explicitamente, e adicionado `noUncheckedIndexedAccess` + `noImplicitOverride`. |

`bun install` resolve `ajv@6` para o topo do grafo de dependências (via alguma dependência
transitiva do `@nestjs/cli`), o que quebra `@mikro-orm/migrations` — a lib `ajv-draft-04` que ele usa
via `umzug` exige `ajv@8`. Fixado em `package.json`:

```json
"overrides": { "ajv": "^8.17.1" }
```

## 3. Correção financeira

### 3.1 `Money`

`src/shared/domain/money.ts`. Nunca `number`/`float`/`double`. Usa `decimal.js` internamente, mas
isso é um detalhe de implementação: o domínio não expõe `Decimal` na API pública, só `MoneyProps`
(`{ amount: string; currency: string }`) via `toJSON()`.

- `Money.from()` (parsing de contratos de entrada — API/mensagens) valida com regex `^\d+\.\d{2}$`
  para o amount (rejeita `NaN`, `Infinity`, notação científica, vazio, escala != 2, **e valores
  negativos**) e `^[A-Z]{3}$` para a moeda.
- `subtract()`/`negate()` podem produzir um `Money` internamente negativo — a restrição "sem
  negativo" vale só para `from()` (contrato de entrada), não para o resultado de aritmética de
  domínio. Necessário para `Wallet.debit()` calcular `balanceBefore.subtract(money)` e decidir se o
  resultado seria negativo *antes* de aceitar a operação, sem lançar exceção prematuramente.
- `equals()` **não lança** em moedas diferentes (só retorna `false`) — tratado como identidade
  estrutural, não uma operação aritmética. `add()`, `subtract()` e `isLessThan()` lançam
  `CurrencyMismatchError`, pois exigem a mesma unidade.

### 3.2 `Wallet` e `WagerTransaction` — invariantes de domínio

- `Wallet.open()` **não incrementa `version`** mesmo com `initialBalance > 0`: a versão nasce em `1`
  (o exemplo de resposta da seção 9 do desafio mostra `"version": 1` já com saldo inicial de
  1000.00). O lançamento `OPENING` correspondente no ledger é responsabilidade do use case
  `CreateWallet`, não da `Wallet` — a wallet nasce com o saldo, não "recebe" o saldo como uma
  transição.
- `Wallet.debit()` lança um `InsufficientBalanceError` de domínio único, sem saber por que está
  debitando. A tradução para o `FailureCode` correto (`INSUFFICIENT_BALANCE` numa `BET`, ou
  `NEGATIVE_BALANCE_ON_REVERSAL` num `ROLLBACK`/`REFUND` — regra 9 da seção 7 do desafio, situações
  operacionalmente diferentes) é responsabilidade do use case, que sabe qual operação está em curso.
- Taxonomia completa de `FailureCode` em `src/shared/domain/failure-code.ts`.

### 3.3 Persistência e constraints de schema

Entidades MikroORM (`src/modules/wallets/infrastructure/entities/`) são um modelo de persistência
**separado** do agregado de domínio — sem decorators no domínio (regra da seção 6.1 do desafio). A
conversão é feita por mappers explícitos (`.../infrastructure/mappers/`), não por decorators
acoplando as duas camadas.

`Money` é persistido como duas colunas simples (`*_amount numeric(19,2)` + `*_currency varchar(3)`),
não como tipo composto/embeddable do ORM nem JSONB — permite `CHECK` diretamente sobre a coluna
numérica. Exceção deliberada: `wallets.balance` não tem coluna de moeda própria, porque o agregado
`Wallet` garante que o saldo está sempre na moeda da própria wallet; já `wager_transactions.money_*`
e as colunas de dinheiro em `wallet_ledger_entries` têm moeda própria, porque a moeda da transação é
parte do contrato de entrada e **precisa** poder divergir da moeda da wallet para o teste de conflito
de moeda fazer sentido.

As garantias de unicidade, imutabilidade e não-negatividade (seção 5.9 do desafio) são aplicadas no
**schema**, não só em código de aplicação:

| Invariante | Mecanismo |
|---|---|
| No máx. 1 wallet por `(playerId, currency)` | `UNIQUE(player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Idempotência única | `UNIQUE(idempotency_key)` |
| Dedup por provider | `UNIQUE(provider_id, external_transaction_id)` |
| 1 lançamento por transação por wallet | `UNIQUE(transaction_id, wallet_id)` em `wallet_ledger_entries` |
| Uma referência não pode ser revertida 2x pelo mesmo tipo de operação | índice parcial `UNIQUE(reference_transaction_id, kind) WHERE status = 'PROCESSED'` |
| Ledger é append-only | trigger `BEFORE UPDATE OR DELETE ... RAISE EXCEPTION` |

**Sobre a imutabilidade do ledger**: a alternativa mais óbvia seria revogar `UPDATE`/`DELETE` da role
da aplicação (`REVOKE`). Descartada ao notar que, no Postgres, o **dono da tabela sempre ignora
`REVOKE` sobre si mesmo** — só funcionaria com uma segunda role sem privilégio de dono, exigindo dois
usuários/senhas no `docker-compose`. Optamos por um trigger `BEFORE UPDATE OR DELETE` que lança
exceção incondicionalmente: funciona para qualquer role, inclusive o dono, com uma fração da
complexidade de infraestrutura, e cobre o mesmo caso de uso (bug de aplicação tentando mutar um
lançamento).

Migrations de `inbox_messages`/`outbox_messages` e dos campos de retry de `PENDING_REFERENCE` vivem
em migrations próprias, separadas da migration inicial — cada migration corresponde a uma fatia de
funcionalidade coesa, não a um "schema completo" adivinhado com antecedência.

### 3.4 Reconciliação

`POST /wallets/:walletId/reconciliation` recalcula o saldo a partir de **todo** o histórico do
ledger (agregação SQL, não confia em nenhum valor já calculado) e compara com o saldo armazenado.
Divergências não são corrigidas silenciosamente (seção 9 do desafio) — só logadas e sinalizadas na
resposta (`consistent: false`).

## 4. Concorrência — unidade `walletId`

**Estratégia: pessimistic locking** via `SELECT ... FOR UPDATE` dentro da transação, em vez de
optimistic locking com retry. Sob 50 requisições simultâneas verdadeiramente concorrentes na mesma
aposta, optimistic locking geraria uma tempestade de conflitos de `version`; pessimistic lock
simplesmente enfileira as threads no lock do Postgres — mais previsível sob a alta contenção que os
cenários obrigatórios da seção 13 exercitam.

O lock é sempre por `walletId` (uma linha específica da tabela `wallets`), nunca uma tabela inteira
ou um mutex compartilhado entre todas as wallets — wallets diferentes nunca disputam o mesmo lock
(proibido pela seção 5, item 6).

### Ordem das operações: wallet primeiro, claim de idempotência depois

Dentro de `ProcessWagerTransactionUseCase`, a wallet é travada (ou só lida, para `LOSS`, que nunca
move saldo) **antes** do claim de idempotência (`INSERT ... ON CONFLICT`) — não depois. A ordem
inversa (claim primeiro) parecia mais barata à primeira vista, porque deixaria requisições duplicadas
nunca tocarem o lock da wallet; na prática, causa um **deadlock real do Postgres**:

`wager_transactions.wallet_id` é FK para `wallets.id`. No Postgres, todo `INSERT` numa tabela com FK
adquire um lock implícito `FOR KEY SHARE` na linha referenciada (protege contra a linha pai ser
alterada por baixo do INSERT). Com claim antes do lock:

1. Transação A insere o claim → adquire `FOR KEY SHARE` na linha da wallet.
2. Transação B (aposta diferente, mesma wallet) faz o mesmo → adquire `FOR KEY SHARE` também
   (compatível com o de A — múltiplos `FOR KEY SHARE` coexistem).
3. A tenta `SELECT ... FOR UPDATE` na wallet → espera B soltar o `FOR KEY SHARE`.
4. B tenta o mesmo → espera A soltar o dele.
5. Ciclo. O Postgres mata uma das duas transações com `DeadlockException`.

Isso só aparece com paralelismo real (curl concorrente contra o servidor, não teste
unitário/sequencial) — a transação "perdedora" recebia um erro não tratado, capturado como `503` em
vez do `REJECTED` esperado pela seção 8.

**Correção**: travar (ou só ler, para `LOSS`) a linha da wallet **antes** de qualquer `INSERT` que a
referencie. O primeiro toque de cada transação nessa linha já é o lock forte — nunca há escalada de
`FOR KEY SHARE` para `FOR UPDATE` disputada por duas transações ao mesmo tempo, logo nenhum ciclo é
possível. Validado rodando o cenário obrigatório da seção 8 (saldo 100, duas apostas de 80
concorrentes) repetidamente contra Postgres real: saldo final `20.00` em todas as execuções, zero
deadlocks, zero 503.

Efeito colateral aceito: pedidos duplicados numa wallet "quente" agora serializam pelo lock da
wallet em vez de resolver via conflito de `idempotency_key` sem nunca tocá-la — corretude teve
prioridade sobre essa otimização de throughput. Efeito colateral positivo: um `walletId` inexistente
agora é verificado **antes** de qualquer `INSERT`, retornando `WalletNotFoundError` (404) de forma
limpa, em vez de estourar como violação de FK não tratada.

A mesma disciplina de ordem (wallet antes da linha da própria transação) se repete em
`PendingReferenceReprocessorWorker.retryPendingReference()` — ver seção 6.5.

### Corrida de dupla-reversão

Dois `ROLLBACK`/`REFUND` da mesma referência passando pela checagem `hasProcessedReversal` antes de
qualquer um commitar: não tem tratamento especial no use case — é pega pelo índice parcial único do
schema (seção 3.3). `em.transactional()` propaga a violação e desfaz a transação inteira (incluindo o
claim). No retry do provider (mesma idempotency key, natural em entrega at-least-once), a segunda
tentativa encontra a reversão já commitada e rejeita normalmente com `REFERENCE_ALREADY_REVERSED`.
Deliberadamente mais simples que um retry automático dentro do use case, com o mesmo resultado
observável para o provider.

## 5. Idempotência

Duas camadas distintas, propositalmente não fundidas:

1. **Idempotência de negócio** (`idempotency_key`, na `WagerTransaction`) — dedup pela chave que o
   provedor envia (`{providerId}:{externalTransactionId}` por default), com `payloadHash` para
   distinguir replay (mesma key, mesmo payload → devolve o resultado original) de conflito (mesma
   key, payload diferente → `409`).

   **Algoritmo do `payloadHash`** (`src/shared/infra/canonical-hash.ts`): SHA-256, em hex, sobre um
   JSON canônico — `JSON.stringify` de um objeto cujas chaves (e as de todo objeto aninhado) são
   ordenadas alfabeticamente antes de serializar, para que o mesmo conteúdo produza sempre os mesmos
   bytes independente da ordem em que os campos chegaram no request. Os campos hasheados são
   exatamente os campos de negócio de `ProcessWagerTransactionInput` —
   `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
   `money: {amount, currency}` e `referenceExternalTransactionId` (quando presente) — e nada além
   disso: o próprio header `Idempotency-Key` e qualquer metadado de transporte (correlationId,
   timestamps, messageId do SQS etc.) ficam de fora do hash de propósito, porque não são parte do
   "o que o provedor pediu para acontecer", só de como o pedido chegou. `Money` entra como
   `{amount, currency}` (strings), nunca como `number`, para não introduzir diferença de precisão
   de ponto flutuante no hash.
2. **Inbox de mensageria** (`InboxMessage`, chave `(consumerName, messageId)`) — dedup de entrega do
   *broker*, independente da idempotência de negócio. Protege contra redelivery do SQS mesmo depois
   que a transação já foi 100% processada e commitada, sem precisar reprocessar o use case inteiro.
   A chave usada é o `messageId` do **corpo** da mensagem (identificador de negócio que o produtor
   define), não o `MessageId` que o SQS atribui automaticamente — um reenvio do produtor pode gerar
   um novo `MessageId` do SQS para o mesmo evento de negócio, e a garantia de dedup de entrega só faz
   sentido na identidade que o produtor controla.

Ambas participam da **mesma transação SQL** da mutação financeira — não há janela onde uma falha
parcial deixe o sistema num estado "processado mas não marcado como processado".

**Claim atômico**: `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`. Quem ganha
processa; os demais buscam a linha existente e retornam replay (payload igual) ou
`IdempotencyConflictError` (payload diferente, HTTP 409).

## 6. Mensageria e recuperação de falhas

### 6.1 Filas

| Fila | Direção | Quem publica | Quem consome |
|---|---|---|---|
| `wager-transactions.fifo` | entrada | provedores de jogos | `SqsConsumerService` |
| `wager-transactions-dlq.fifo` | entrada (DLQ) | redrive policy (5 tentativas) ou envio direto em erro permanente | operação/investigação manual |
| `wager-integration-events.fifo` | saída | `OutboxPublisherWorker` | consumidores externos (fora de escopo) |

A fila de saída **não é especificada por nome no desafio** — a seção 10 só nomeia as filas de
entrada; a seção 11 fala em "publica os eventos pendentes" sem definir destino. Criamos
`wager-integration-events.fifo` para deixar a direção explícita e não misturar entrada/saída na
mesma fila.

### 6.2 Outbox transacional

A persistência da transação, a alteração de saldo, o lançamento no ledger, o registro de inbox e o
evento de integração são atômicos — `IntegrationEvent`s são gravados na tabela `outbox_messages`
dentro da mesma transação que o resto (nunca publicados diretamente no SQS pelo use case).

`OutboxPublisherWorker` roda a cada 5s (`@Interval`) em **toda instância**. Usa
`SELECT ... FOR UPDATE SKIP LOCKED` (`LockMode.PESSIMISTIC_PARTIAL_WRITE`) para pegar um lote de
mensagens pendentes — publishers concorrentes de instâncias diferentes pegam lotes disjuntos, sem
duplicar nem travar um no outro. Falha ao publicar → `scheduleRetry()` (backoff exponencial, base
2s, cap 5min); sucesso → `markPublished()`. O lock fica retido durante a chamada de rede ao SQS —
trade-off aceito do padrão outbox + `SKIP LOCKED`, comum na prática.

Cenário de recuperação após crash (processo morre depois do commit, antes de publicar): validado
fazendo um app context nunca chamar seu próprio `OutboxPublisherWorker` e um segundo app context
("outra instância") publicar o que ficou pendente — consistência final (`wallet.balance == ledger
reconstruído`) confirmada via `ReconcileWalletUseCase` depois.

### 6.3 Consumer

`SqsConsumerService` reusa o **mesmo** `ProcessWagerTransactionUseCase` da entrada HTTP — a única
diferença é o `InboxContext` (dedup de entrega) passado como terceiro parâmetro.

1. Long-poll (`WaitTimeSeconds: 10`) em lotes de até 10 mensagens.
2. Parse + validação do envelope via `class-validator` (mesmas classes de DTO reaproveitadas da
   camada HTTP: `MoneyDto`, `SubmittableWagerTransactionKind`).
3. Chama o use case. **Ack (delete) só depois do use case retornar com sucesso** — ou seja, só depois
   do commit da transação SQL. `PROCESSED`, `REJECTED` e `PENDING_REFERENCE` são todos desfechos
   terminais do ponto de vista do consumer: ack incondicional (não são "erros" a reter).
4. Classificação de erro (`classifyConsumerError`):
   - **Payload malformado** (JSON inválido, falha de validação do envelope) → manda direto pra DLQ +
     deleta da fila de origem, sem gastar as 5 tentativas do redrive policy (nunca vai se resolver).
   - **Erros de aplicação não-recuperáveis** (`RequestValidationError`, `IdempotencyConflictError`,
     `MissingReferenceError`, `InvalidMoneyError`, `CurrencyMismatchError`) → mesmo tratamento:
     permanente, DLQ imediata.
   - **Qualquer outro erro** (infra, deadlock, `WalletNotFoundError` — pode se resolver se a wallet
     for criada logo depois) → transitório: não deleta, deixa o visibility timeout expirar
     naturalmente; o redrive policy da fila move pra DLQ automaticamente após 5 tentativas.
5. `SIGTERM`: `OnModuleDestroy` para de puxar mensagens novas e espera o lote em andamento terminar
   (`app.enableShutdownHooks()` habilitado em `main.ts`). Como o long-poll usa `WaitTimeSeconds: 10`,
   o shutdown pode levar até ~10s para drenar — trade-off aceito em troca de não fazer polling
   agressivo.

Redelivery da mesma mensagem de negócio (`messageId` igual, `MessageId` novo do SQS) foi testada
contra o SQS real: dedup via inbox, sem efeito duplicado.

**Cenário "worker morto depois do commit e antes do ack"**: como o ack real só acontece depois do
use case retornar, esse cenário é reproduzido processando a mesma mensagem duas vezes com o mesmo
`InboxContext` — indistinguível, para o sistema, de uma redelivery real nesse ponto exato. Sem efeito
duplicado.

### 6.4 Um ciclo de módulos, resolvido com um módulo de composição

`ProcessWagerTransactionUseCase` vive em `WalletsModule`, que já importa `MessagingModule` (para
`OUTBOX_PORT`/`INBOX_PORT`). O `SqsConsumerService` precisa dos dois — o cliente SQS de
`MessagingModule` e o use case de `WalletsModule`. Registrá-lo dentro de qualquer um dos dois módulos
criaria um ciclo de import. Resolvido com um terceiro módulo, `SqsConsumerModule`, que importa ambos
e não é importado por nenhum deles — assimetria deliberada para manter a direção de dependência
limpa (`wallets` depende de `messaging`, nunca o inverso). O mesmo padrão se repete em
`MetricsModule` (seção 9), sem dependências de `wallets`/`messaging`, importado por ambos.

### 6.5 Reprocessamento de `PENDING_REFERENCE`

Quando `REFUND`/`ROLLBACK` chega antes da transação que referencia (seção 7.1 do desafio), o
`PendingReferenceReprocessorWorker` reprocessa periodicamente até resolver ou esgotar o limite.

**Backoff**: exponencial, base 5s, cap 5min, **10 tentativas** — janela total de aproximadamente 25
minutos (5+10+20+40+80+160+300+300+300+300s). Referências fora de ordem em produção tipicamente se
resolvem em segundos a poucos minutos (latência de rede/processamento entre provedor e o serviço, não
indisponibilidade prolongada); 25 minutos é generoso o suficiente para cobrir atraso real sem deixar
uma transação `PENDING_REFERENCE` órfã indefinidamente. Esgotado o limite: `REJECTED` com
`REFERENCE_TIMEOUT_EXCEEDED` (distinto de `REFERENCE_NOT_FOUND`, usado quando a referência existe mas
está num estado terminal negativo que nunca vai se resolver).

**Reuso de lógica**: `retryPendingReference()` é um método público do **mesmo**
`ProcessWagerTransactionUseCase`, reaproveitando os métodos privados de resolução de referência e
aplicação de movimento já usados pelo fluxo HTTP/SQS. Isso exigiu isolar o efeito colateral de
"marcar `PENDING_REFERENCE` + publicar o evento" para fora da função de resolução pura — senão o
retry republicaria o evento a cada tentativa falha, não só na primeira vez que a transação fica
pendente. A função de resolução só resolve; cada chamador decide o que fazer com o resultado
`'pending'`: o fluxo inicial marca+publica uma única vez, o retry agenda o próximo backoff sem
republicar nada.

**Seleção do lote em duas fases** (worker): uma transação curta seleciona os IDs elegíveis com
`FOR UPDATE SKIP LOCKED` e é commitada; cada id é processado depois em sua própria transação,
sequencialmente. Evita depender de `em.transactional()` aninhado — comportamento que o MikroORM
parece suportar (chamadas aninhadas reusam o contexto de transação ambiente via `AsyncLocalStorage`),
mas que não foi exercitado/validado explicitamente neste código, então preferimos não confiar nele.
A pequena janela entre as duas fases onde outra instância poderia teoricamente pegar a mesma linha é
inofensiva: `retryPendingReference()` re-trava e revalida o status atual antes de agir.

Validado contra Postgres real: `ROLLBACK` enviado referenciando uma `BET` inexistente vira
`PENDING_REFERENCE`, com `reference_retry_count`/`next_reference_check_at` avançando a cada passada
do worker; ao criar a `BET` referenciada, a passada seguinte resolve o `ROLLBACK` sozinho, com
`reference_transaction_id` preenchido e o saldo da wallet corretamente revertido.

## 7. API HTTP

Mapeamento de status HTTP — a API distingue com clareza, e de forma consistente entre endpoints,
payload inválido / conflito de idempotência / rejeição de negócio / aceite pendente / falha
transitória:

| Situação | HTTP |
|---|---|
| Payload inválido (formato, `Money` malformado) | `400` |
| Conflito de idempotência (mesma key, payload diferente) | `409` |
| Transação processada com sucesso (nova) | `201` |
| Replay idempotente de uma transação já `PROCESSED` | `200` |
| Rejeição por regra de negócio (`REJECTED`) — request válido, resultado de negócio | `200` (corpo traz `status: "REJECTED"` + `failureCode`) |
| Aceite pendente de referência (`PENDING_REFERENCE`) | `202` |
| Falha transitória de infraestrutura | `503` |

## 8. Autenticação

Keycloak (OIDC) real, protegendo os endpoints HTTP com um guard JWT validando contra o realm via
JWKS — implementado para deixar o cenário mais próximo de um caso real.

**Setup**: serviço `keycloak` no `docker-compose.yml` sobe com `start-dev --import-realm`,
importando `docker/keycloak/realm-export.json` — realm `jungle-gaming`, client `wagering-api`
(confidential, `serviceAccountsEnabled: true` para suportar o grant `client_credentials`, o fluxo
natural para um provedor de jogos como client machine-to-machine, sem usuário humano envolvido) com
um protocol mapper de audience garantindo que os tokens emitidos carreguem `"wagering-api"` em `aud`.

**Validação**: `KeycloakJwtStrategy` (`passport-jwt` + `jwks-rsa`) busca as chaves públicas de
`${issuer}/protocol/openid-connect/certs` dinamicamente (com cache), valida assinatura RS256,
`issuer` e `audience`. `KeycloakJwtGuard` aplicado **globalmente** via `APP_GUARD` — todo endpoint
exige token válido por padrão, exceto os marcados com `@Public()` (`/health/*`). `/metrics` exige
token como qualquer outro endpoint — não há motivo de negócio para expô-lo sem autenticação, e um
scraper pode obter um token via `client_credentials` como qualquer client machine-to-machine.

**Escopo deliberadamente limitado a autenticação**, sem autorização/RBAC: o guard só responde "esta
chamada tem um token válido de um client registrado no realm?" — não faz checagem cruzada entre a
identidade do token e o `providerId` do corpo da requisição. O desafio não pede isso, e inventar uma
camada de autorização não solicitada seria escopo além do necessário.

Testado com Keycloak real (realm importado, token obtido via `client_credentials` contra o endpoint
real): sem header `Authorization` → 401; token malformado → 401; token válido → passa. `/health/*`
confirmado aberto sem token; `/metrics` confirmado exigindo token como qualquer outro endpoint.

## 9. Observabilidade

**Logs estruturados** (`nestjs-pino`, JSON): `app.useLogger(app.get(Logger))` em `main.ts` faz até o
`Logger` padrão do NestJS sair em JSON. Nos pontos de negócio — `ProcessWagerTransactionUseCase`,
`SqsConsumerService`, `OutboxPublisherWorker`, `PendingReferenceReprocessorWorker`,
`GlobalExceptionFilter` — usamos `PinoLogger` (`@InjectPinoLogger`) diretamente, passando um objeto
estruturado como primeiro argumento (`correlationId`, `causationId`, `messageId`, `transactionId`,
`walletId`, `providerId`, `status`, `failureCode`), nunca uma string interpolada — os campos ficam
pesquisáveis/filtráveis no agregador de log. **Nunca logamos o valor monetário da operação** nem o
corpo completo da requisição (só IDs), e o header `Authorization` é redigido (`redact` do
`pino-http`) para nunca vazar o token JWT nos logs automáticos de request/response.

**Métricas** (`prom-client`, `/metrics` em texto Prometheus, público): `MetricsService` centraliza os
contadores/histogramas numa `Registry` própria (não a global do `prom-client`).

| Métrica | O que mede |
|---|---|
| `wager_transactions_total{kind,status}` | transações por status final |
| `wager_transactions_idempotent_replay_total` | duplicatas de **negócio** detectadas (mesma idempotencyKey) |
| `inbox_duplicate_deliveries_total` | duplicatas de **entrega** detectadas (redelivery do broker, distinto do anterior) |
| `wager_transaction_processing_seconds` | latência de processamento (histograma) |
| `outbox_publish_attempts_total{outcome}` | tentativas de publicação da outbox (sucesso/retry) |
| `outbox_publish_lag_seconds` | outbox lag: tempo entre o evento ocorrer e ser publicado (histograma) |
| `sqs_dlq_messages_total{reason}` | mensagens em DLQ, por motivo (malformed/permanent_error) |
| `sqs_message_retries_total` | mensagens deixadas para retry por erro transitório |
| `infra_transient_errors_total{source}` | erros transitórios de infra (deadlock, conexão indisponível) — o proxy mais próximo de "conflitos de lock" que a seção 12 pede, já que não instrumentamos tempo de espera de lock diretamente |

**Health**: `GET /health/live` (processo vivo) e `GET /health/ready` (Postgres + SQS alcançáveis),
sem autenticação (seção 9 do desafio).

`GlobalExceptionFilter` é um provider `APP_FILTER` gerenciado pelo Nest (não instanciado
manualmente) — necessário para poder injetar `MetricsService`/`PinoLogger` nele, o que permite
contar `infra_transient_errors_total{source="http"}` quando um erro não mapeado cai no branch 503.

## 10. Testes

94 testes, todos passando: **66 de unidade** (`bun run test` = `bun test src test/unit`, sem
containers) + **17 de integração** + **11 de concorrência** (`bun run test:integration` /
`bun run test:concurrency`, contra Postgres e LocalStack **reais**, subidos via
`docker compose up -d postgres localstack`). Nenhum mock substitui Postgres/SQS (proibido pela seção
13) — os testes de integração/concorrência sobem o `AppModule` de produção inteiro
(`NestFactory.createApplicationContext`, via `test/support/test-app.ts`), incluindo o
`SqsConsumerService` e os workers agendados rodando de verdade, não uma versão fatiada só para teste.

**Unidade — domínio puro** (`src/**/*.spec.ts`, 55 testes): `Money` (validação/escala/arredondamento),
`Wallet` (invariantes), `WagerTransaction` (transições de estado, `ledgerDirectionFor`, backoff de
retry), `WalletLedgerEntry` (imutabilidade estrutural, `isBalanced`), conflito de moeda, hash
canônico do payload.

**Unidade — regras de negócio do use case** (`test/unit/`, 11 testes): `ProcessWagerTransactionUseCase`
com repositórios fake em memória (`test/support/fakes.ts` — sem Postgres, sem `EntityManager` real,
só um `.transactional()` que executa o callback direto). Cobre especificamente o que os testes de
domínio isolado não alcançam: conflito de idempotência com payload divergente, replay sem
reprocessar, `WalletNotFoundError`, conflito de moeda, `LOSS` nunca travando a wallet, e as quatro
validações de resolução de referência de `REFUND`/`ROLLBACK` (tipo de kind inválido, dono
diferente, valor diferente, referência já revertida, referência ainda não chegou). As mesmas regras
já eram exercitadas contra Postgres real nos testes de integração/concorrência; isolar isso em
unidade com fakes também os deixa rodando em ~300ms, sem depender de containers de pé.

**Integração** (17 testes): migrations/constraints (11 testes automatizando as checagens SQL da
seção 3.3 — saldo negativo, unicidade de wallet/idempotência, índice parcial de reversão, trigger de
imutabilidade, FK); atomicidade (wallet+ledger+outbox committados juntos; `REJECTED` sem lançamento
no ledger; `wallet.balance == ledger reconstruído` depois de uma sequência de operações mistas);
inbox/redelivery com SQS real; mensagem malformada indo direto pra DLQ.

**Concorrência** (11 testes, os 8 cenários da seção 13, paralelismo real via `Promise.all`, nunca
sequencial): o cenário obrigatório da seção 8 (100→duas apostas de 80 concorrentes); 50 requisições
paralelas da mesma aposta; wallets diferentes em paralelo; **3 instâncias reais** (3
`NestFactory.createApplicationContext` separados — não simplificado como "3 chamadas no mesmo
processo"); `REFUND`/`ROLLBACK` chegando antes da referência (resolução automática + esgotamento de
tentativas); worker morto entre o commit e o ack; **dois publishers concorrentes** de instâncias
diferentes sobre o mesmo lote da outbox; **reinício do serviço** com uma "instância morta" deixando a
outbox pendente e outra assumindo — estes dois últimos vivem em `test/concurrency/` (não em
`test/integration/`), porque são conceitualmente cenários de concorrência/recuperação, não checagens
estruturais de schema.

**Invariante final verificada nos testes relevantes**: `wallet.balance == saldo reconstruído pelo
ledger`.

## 11. Limitações conhecidas / fora de escopo

- **Teste de carga**: não implementado.
- **Ledger de partidas dobradas** (double-entry bookkeeping): fora de escopo.
- **Reversão parcial de `REFUND`/`ROLLBACK`**: fora de escopo.
- **Sem `Dockerfile` da aplicação**: a API roda fora do `docker-compose` (via `bun run start`), que
  sobe só a infraestrutura (Postgres, LocalStack, Keycloak). Ver `README.md`.
- **Autorização/RBAC**: fora de escopo deliberadamente — ver seção 8.
