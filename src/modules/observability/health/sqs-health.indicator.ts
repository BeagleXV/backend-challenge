import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from '../../messaging/infrastructure/sqs-client.provider';

@Injectable()
export class SqsHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly config: ConfigService,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.config.get<string>('SQS_WAGER_TRANSACTIONS_QUEUE_URL'),
          AttributeNames: ['QueueArn'],
        }),
      );
      return indicator.up();
    } catch (err) {
      return indicator.down({ message: (err as Error).message });
    }
  }
}
