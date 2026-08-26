import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MessagingModule } from '../messaging/messaging.module';
import { WalletEntity } from './infrastructure/entities/wallet.entity';
import { WagerTransactionEntity } from './infrastructure/entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './infrastructure/entities/wallet-ledger-entry.entity';
import { MikroWalletRepository } from './infrastructure/repositories/wallet.repository';
import { MikroWagerTransactionRepository } from './infrastructure/repositories/wager-transaction.repository';
import { MikroWalletLedgerEntryRepository } from './infrastructure/repositories/wallet-ledger-entry.repository';
import { WALLET_REPOSITORY } from './application/ports/wallet-repository';
import { WAGER_TRANSACTION_REPOSITORY } from './application/ports/wager-transaction-repository';
import { WALLET_LEDGER_ENTRY_REPOSITORY } from './application/ports/wallet-ledger-entry-repository';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { GetWalletUseCase } from './application/use-cases/get-wallet.use-case';
import { GetWagerTransactionUseCase } from './application/use-cases/get-wager-transaction.use-case';
import { GetWalletLedgerUseCase } from './application/use-cases/get-wallet-ledger.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { WalletsController } from './interface/wallets.controller';
import { WageringController } from './interface/wagering.controller';
import { PendingReferenceReprocessorWorker } from './infrastructure/workers/pending-reference-reprocessor.worker';
import { MetricsModule } from '../observability/metrics/metrics.module';

@Module({
  imports: [
    MikroOrmModule.forFeature([WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity]),
    MessagingModule,
    MetricsModule,
  ],
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: WALLET_REPOSITORY, useClass: MikroWalletRepository },
    { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroWagerTransactionRepository },
    { provide: WALLET_LEDGER_ENTRY_REPOSITORY, useClass: MikroWalletLedgerEntryRepository },
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    GetWalletUseCase,
    GetWagerTransactionUseCase,
    GetWalletLedgerUseCase,
    ReconcileWalletUseCase,
    PendingReferenceReprocessorWorker,
  ],
  exports: [
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    GetWalletUseCase,
    GetWagerTransactionUseCase,
    GetWalletLedgerUseCase,
    ReconcileWalletUseCase,
  ],
})
export class WalletsModule {}
