#!/usr/bin/env bash
set -euo pipefail

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# Fila de saída da outbox — eventos de integração publicados pelo OutboxPublisherWorker
# (WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged,
# WagerTransactionPendingReference). Não é especificada por nome no desafio (seção 10 só nomeia
# as filas de ENTRADA); nome escolhido para deixar clara a distinção de direção.
awslocal sqs create-queue \
  --queue-name wager-integration-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

echo "SQS queues ready."
