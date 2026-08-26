import { Type } from 'class-transformer';
import { IsUUID, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from './money.dto';

export class CreateWalletDto {
  @ApiProperty({ example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' })
  @IsUUID()
  playerId!: string;

  @ApiProperty({ type: MoneyDto, description: 'Se amount > 0, gera um lançamento OPENING na mesma transação.' })
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
