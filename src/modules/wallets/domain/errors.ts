import { DomainError } from '../../../shared/domain/errors';
import { WagerTransactionStatus } from './wager-transaction';

export class InsufficientBalanceError extends DomainError {
  constructor(walletId: string) {
    super(`Wallet "${walletId}" does not have sufficient balance for this operation`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(transactionId: string, currentStatus: WagerTransactionStatus) {
    super(
      `Transaction "${transactionId}" is in terminal state "${currentStatus}" and cannot transition`,
    );
  }
}

export class MissingReferenceError extends DomainError {
  constructor(kind: string) {
    super(`Transaction kind "${kind}" requires a referenceExternalTransactionId`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  constructor(entryId: string) {
    super(`Ledger entry "${entryId}" arithmetic does not balance: balanceBefore ± money !== balanceAfter`);
  }
}
