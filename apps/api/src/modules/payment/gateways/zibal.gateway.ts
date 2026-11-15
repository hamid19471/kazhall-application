import { BadGatewayException, Injectable, Logger } from '@nestjs/common';

import { PaymentConfig } from '../payment.config';
import {
  GatewayRequestInput,
  GatewayRequestResult,
  GatewayVerifyResult,
  PaymentGateway,
} from './payment-gateway.interface';

interface ZibalRequestResponse {
  result?: number;
  trackId?: number | string;
  message?: string;
}

interface ZibalVerifyResponse {
  result?: number;
  amount?: number;
  refNumber?: number | string | null;
  message?: string;
}

/**
 * Real Zibal implementation.
 *
 * Uses Node's built-in `fetch` rather than `@nestjs/axios`. That is deliberate
 * and adds no dependency: `@nestjs/axios@12` ships as `"type": "module"` with
 * an ESM-only `dist`, which Node 24 can `require()` but jest's CommonJS runtime
 * cannot load without a `transformIgnorePatterns` change in workstream A's jest
 * config. Keeping the payment path off it means the payment integration suite
 * runs today. (The mismatch still affects every other module that imports
 * `@nestjs/axios` -- reported to the lead.)
 *
 * Merchant id, base URL and callback URL all come from PaymentConfig; there are
 * no literals here. Amounts pass through as INTEGER RIAL with no multiplier
 * (docs/ARCHITECTURE.md section 0).
 */
@Injectable()
export class ZibalPaymentGateway implements PaymentGateway {
  private readonly logger = new Logger(ZibalPaymentGateway.name);

  constructor(private readonly config: PaymentConfig) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs,
    );
    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new BadGatewayException(
          `Payment gateway returned HTTP ${response.status}`,
        );
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async request(input: GatewayRequestInput): Promise<GatewayRequestResult> {
    const body = await this.post<ZibalRequestResponse>('/v1/request', {
      merchant: this.config.merchant,
      amount: input.amount,
      callbackUrl: input.callbackUrl,
      orderId: input.orderId,
      description: input.description,
      mobile: input.mobile,
    });

    if (body.result !== 100 || body.trackId === undefined) {
      this.logger.warn(
        `zibal request rejected: result=${body.result} message=${body.message}`,
      );
      throw new BadGatewayException(
        `Payment gateway rejected the request (result ${body.result ?? 'unknown'})`,
      );
    }
    return { trackId: String(body.trackId), raw: body };
  }

  async verify(input: { trackId: string }): Promise<GatewayVerifyResult> {
    const body = await this.post<ZibalVerifyResponse>('/v1/verify', {
      merchant: this.config.merchant,
      trackId: input.trackId,
    });
    return {
      result: Number(body.result ?? -1),
      amount: body.amount ?? null,
      refNumber: body.refNumber === undefined ? null : String(body.refNumber),
      raw: body,
    };
  }

  paymentUrl(trackId: string): string {
    return `${this.config.baseUrl}/start/${trackId}`;
  }
}
