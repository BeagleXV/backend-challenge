import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // Necessário para os OnModuleDestroy (ex.: SqsConsumerService) rodarem em SIGTERM/SIGINT —
  // sem isso o processo mata as conexões na hora, sem terminar mensagens em voo.
  app.enableShutdownHooks();

  // SwaggerModule serve /docs via middleware Express puro, fora do roteamento do Nest — não passa
  // pelo KeycloakJwtGuard global, então não precisa de @Public() aqui.
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Distributed Wagering Processor')
      .setDescription(
        'Serviço financeiro de apostas — carteiras (wallets) e transações de apostas (wager transactions) ' +
          'com idempotência, concorrência segura e mensageria assíncrona via SQS. Ver ARCHITECTURE.md no repo ' +
          'para as decisões de design por trás de cada regra.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token do Keycloak — ver README.md, seção Autenticação.' },
        'jwt',
      )
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
