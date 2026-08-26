/**
 * Identidade extraída do token JWT após validação. É a única coisa que a autenticação garante —
 * "esta é uma chamada autenticada de um client registrado no realm". Não é usada para autorização
 * cruzada com o `providerId` do corpo da requisição: o desafio não exige RBAC/autorização por
 * provider (seção 2 — autenticação não vale pontos), então mantive o escopo estritamente em
 * autenticação, sem inventar uma camada de autorização não pedida.
 */
export interface AuthenticatedProvider {
  subject: string;
  clientId?: string;
  raw: Record<string, unknown>;
}
