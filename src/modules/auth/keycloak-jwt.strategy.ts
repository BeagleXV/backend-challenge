import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { AuthenticatedProvider } from './authenticated-provider';

@Injectable()
export class KeycloakJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    const issuer = config.getOrThrow<string>('KEYCLOAK_ISSUER_URL');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
      }),
      issuer,
      audience: config.get<string>('KEYCLOAK_AUDIENCE'),
      algorithms: ['RS256'],
    });
  }

  validate(payload: Record<string, unknown>): AuthenticatedProvider {
    return {
      subject: payload.sub as string,
      clientId: (payload.azp ?? payload.client_id) as string | undefined,
      raw: payload,
    };
  }
}
