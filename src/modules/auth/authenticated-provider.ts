/**
 * Identidade extraída do token JWT após validação. É a única coisa que a autenticação garante —
 * "esta é uma chamada autenticada de um client registrado no realm". Não é usada para autorização
 * cruzada com o `providerId` do corpo da requisição: o escopo é estritamente autenticação, sem uma
 * camada de autorização/RBAC por provider.
 */
export interface AuthenticatedProvider {
  subject: string;
  clientId?: string;
  raw: Record<string, unknown>;
}
