import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateWalletUseCase } from '../application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../application/use-cases/get-wallet.use-case';
import { GetWalletLedgerUseCase } from '../application/use-cases/get-wallet-ledger.use-case';
import { ReconcileWalletUseCase } from '../application/use-cases/reconcile-wallet.use-case';
import { newId } from '../../../shared/infra/id';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { toLedgerEntryResponse, toWalletResponse } from './dto/responses';

const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;

@ApiTags('wallets')
@ApiBearerAuth('jwt')
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @ApiOperation({ summary: 'Cria uma wallet para um player (uma por player+currency).' })
  @ApiResponse({ status: 201, description: 'Wallet criada — se initialBalance.amount > 0, com um lançamento OPENING já aplicado.' })
  @ApiResponse({ status: 409, description: 'Já existe wallet para esse playerId+currency.' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateWalletDto) {
    return this.createWalletUseCase.execute(
      { playerId: dto.playerId, initialBalance: dto.initialBalance },
      { correlationId: newId() },
    );
  }

  @ApiOperation({ summary: 'Consulta uma wallet por id.' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Wallet encontrada.' })
  @ApiResponse({ status: 404, description: 'Wallet não existe.' })
  @Get(':walletId')
  async getById(@Param('walletId', ParseUUIDPipe) walletId: string) {
    const wallet = await this.getWalletUseCase.execute(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet "${walletId}" not found`);
    }
    return toWalletResponse(wallet);
  }

  @ApiOperation({ summary: 'Extrato paginado da wallet (cursor opaco, mais recente primeiro).' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor opaco retornado em nextCursor da página anterior.' })
  @ApiQuery({ name: 'limit', required: false, description: `Padrão ${DEFAULT_LEDGER_LIMIT}, máximo ${MAX_LEDGER_LIMIT}.` })
  @ApiResponse({ status: 200, description: 'Página do ledger.' })
  @ApiResponse({ status: 400, description: 'Cursor malformado.' })
  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = clampLimit(limit);
    const page = await this.getWalletLedgerUseCase.execute(walletId, cursor, parsedLimit);
    return {
      entries: page.entries.map(toLedgerEntryResponse),
      nextCursor: page.nextCursor,
    };
  }

  @ApiOperation({ summary: 'Recalcula o saldo a partir do ledger e compara com wallet.balance.' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Resultado da reconciliação (consistent: boolean, saldo esperado vs. armazenado).' })
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.reconcileWalletUseCase.execute(walletId);
  }
}

function clampLimit(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_LEDGER_LIMIT;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LEDGER_LIMIT;
  }
  return Math.min(parsed, MAX_LEDGER_LIMIT);
}
