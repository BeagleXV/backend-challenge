import { BadRequestException, Body, Controller, Get, Headers, NotFoundException, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProcessWagerTransactionUseCase, ProcessWagerTransactionResult } from '../application/use-cases/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../application/use-cases/get-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { ProcessWagerTransactionDto } from './dto/process-wager-transaction.dto';
import { toTransactionResponse } from './dto/responses';

@ApiTags('wagering')
@ApiBearerAuth('jwt')
@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTransactionUseCase: ProcessWagerTransactionUseCase,
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
  ) {}

  @ApiOperation({
    summary: 'Submete uma transação de apostas (BET/WIN/LOSS/REFUND/ROLLBACK).',
    description:
      'Status HTTP varia com o desfecho: 201 PROCESSED (nova), 200 replay idempotente ou REJECTED (regra de ' +
      'negócio, request válido), 202 PENDING_REFERENCE, 400 payload/cursor inválido, 409 conflito de ' +
      'idempotência (mesma key, payload diferente). Ver ARCHITECTURE.md seção 7 para a tabela completa.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Ex.: "{providerId}:{externalTransactionId}".' })
  @ApiResponse({ status: 201, description: 'PROCESSED — nova transação aplicada.' })
  @ApiResponse({ status: 200, description: 'Replay idempotente ou REJECTED (regra de negócio).' })
  @ApiResponse({ status: 202, description: 'PENDING_REFERENCE — aguardando a transação referenciada chegar.' })
  @ApiResponse({ status: 400, description: 'Payload inválido ou Idempotency-Key ausente.' })
  @ApiResponse({ status: 409, description: 'Mesma Idempotency-Key com payload diferente.' })
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

  @ApiOperation({ summary: 'Consulta uma transação por id interno.' })
  @ApiParam({ name: 'transactionId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Transação encontrada.' })
  @ApiResponse({ status: 404, description: 'Transação não existe.' })
  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    const transaction = await this.getWagerTransactionUseCase.byId(transactionId);
    if (!transaction) {
      throw new NotFoundException(`Wager transaction "${transactionId}" not found`);
    }
    return toTransactionResponse(transaction);
  }

  @ApiOperation({ summary: 'Consulta uma transação pela chave do provedor (providerId + externalTransactionId).' })
  @ApiResponse({ status: 200, description: 'Transação encontrada.' })
  @ApiResponse({ status: 404, description: 'Transação não existe.' })
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
