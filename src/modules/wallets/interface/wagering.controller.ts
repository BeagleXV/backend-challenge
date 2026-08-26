import { BadRequestException, Body, Controller, Get, Headers, NotFoundException, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProcessWagerTransactionUseCase, ProcessWagerTransactionResult } from '../application/use-cases/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../application/use-cases/get-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { ProcessWagerTransactionDto } from './dto/process-wager-transaction.dto';
import { toTransactionResponse } from './dto/responses';

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTransactionUseCase: ProcessWagerTransactionUseCase,
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: ProcessWagerTransactionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const result = await this.processWagerTransactionUseCase.execute(
      {
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        idempotencyKey,
        playerId: dto.playerId,
        walletId: dto.walletId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: dto.kind as unknown as WagerTransactionKind,
        money: dto.money,
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
      },
      { correlationId: idempotencyKey },
    );

    res.status(statusForResult(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    const transaction = await this.getWagerTransactionUseCase.byId(transactionId);
    if (!transaction) {
      throw new NotFoundException(`Wager transaction "${transactionId}" not found`);
    }
    return toTransactionResponse(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const transaction = await this.getWagerTransactionUseCase.byProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!transaction) {
      throw new NotFoundException(
        `Wager transaction "${externalTransactionId}" for provider "${providerId}" not found`,
      );
    }
    return toTransactionResponse(transaction);
  }
}

/** Ver ARCHITECTURE.md seção 6 para a tabela completa de mapeamento de status. */
function statusForResult(result: ProcessWagerTransactionResult): number {
  if (result.idempotentReplay) {
    return 200;
  }
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    default:
      return 200;
  }
}
