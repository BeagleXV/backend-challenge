import { Matches } from 'class-validator';
import { AMOUNT_PATTERN, CURRENCY_PATTERN } from '../../../../shared/domain/money';

/**
 * Validação estrutural na borda (fail-fast, mensagem clara). `Money.from()` no domínio continua
 * sendo a autoridade final — mesma fonte de verdade dos padrões (AMOUNT_PATTERN/CURRENCY_PATTERN),
 * não uma regra duplicada e potencialmente divergente.
 */
export class MoneyDto {
  @Matches(AMOUNT_PATTERN, { message: 'amount must be a decimal string with exactly 2 decimal places, e.g. "25.00"' })
  amount!: string;

  @Matches(CURRENCY_PATTERN, { message: 'currency must be a 3-letter uppercase ISO-4217 code, e.g. "BRL"' })
  currency!: string;
}
