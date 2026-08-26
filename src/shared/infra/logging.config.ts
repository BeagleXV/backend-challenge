import type { Params } from 'nestjs-pino';

/**
 * Logs JSON estruturados (seção 12 do desafio). Redige o header Authorization (nunca vaza o
 * token) e não loga corpo de requisição/resposta — os logs de negócio explícitos nos use cases só
 * incluem IDs (correlationId, transactionId, walletId, providerId, messageId), nunca valores
 * monetários ou payloads financeiros completos.
 */
export const loggerModuleParams: Params = {
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: ['req.headers.authorization'],
      censor: '[REDACTED]',
    },
    serializers: {
      req: (req: { id: unknown; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  },
};
