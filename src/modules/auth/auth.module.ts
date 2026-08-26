import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { KeycloakJwtStrategy } from './keycloak-jwt.strategy';
import { KeycloakJwtGuard } from './keycloak-jwt.guard';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  providers: [
    KeycloakJwtStrategy,
    { provide: APP_GUARD, useClass: KeycloakJwtGuard },
  ],
})
export class AuthModule {}
