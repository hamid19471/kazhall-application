import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import { DataSource } from 'typeorm';
import { Public } from 'src/modules/auth/decorators/public.decorator';
import { successEnvelopeSchema } from 'src/configs/swagger.config';

/**
 * Liveness/readiness probe.
 *
 * `@Public()` because an orchestrator has no credentials — behind the global
 * JwtAuthGuard the probe would 401 and every container would be killed as
 * unhealthy.
 *
 * It runs a real `SELECT 1`. A process that is listening but cannot reach
 * PostgreSQL is not ready to serve traffic, and a probe that only proves the
 * event loop is alive would keep routing requests to it.
 *
 * Returns 503 (not 500) when the database is unreachable so a load balancer
 * treats it as "temporarily out of rotation" rather than a crash.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Liveness/readiness probe with a database check',
    description:
      'PUBLIC — no cookie, because an orchestrator has no credentials.\n\n' +
      'Runs a real `SELECT 1`: a process that is listening but cannot reach ' +
      'PostgreSQL is reported as not ready. The status is set on the RESPONSE ' +
      '(200 or 503); no exception is thrown, so **both** bodies are the ' +
      'SUCCESS envelope and `success` is `true` even on the 503. Decide ' +
      'readiness from the HTTP status or from `status` / `database`, never ' +
      'from `success`.',
  })
  @ApiOkResponse({
    description: 'The database answered — the process is ready to serve.',
    schema: successEnvelopeSchema({
      properties: {
        status: { type: 'string', enum: ['ok', 'error'] },
        database: { type: 'string', enum: ['up', 'down'] },
        latencyMs: { type: 'integer', example: 3 },
        uptimeSeconds: { type: 'integer', example: 41253 },
        error: {
          type: 'string',
          description:
            'The database error message. Present only when `database` is ' +
            '`down`.',
        },
      },
    }),
  })
  @ApiResponse({
    status: 503,
    description:
      'The database is unreachable — temporarily out of rotation, not a ' +
      'crash. Still the SUCCESS envelope, with `success: true`, ' +
      '`status: "error"` and `database: "down"`.',
    schema: successEnvelopeSchema({
      properties: {
        status: { type: 'string', enum: ['ok', 'error'] },
        database: { type: 'string', enum: ['up', 'down'] },
        latencyMs: { type: 'integer', example: 3 },
        uptimeSeconds: { type: 'integer', example: 41253 },
        error: {
          type: 'string',
          description:
            'The database error message. Present only when `database` is ' +
            '`down`.',
        },
      },
    }),
  })
  async check(@Res({ passthrough: true }) res: Response) {
    const startedAt = Date.now();
    let database: 'up' | 'down' = 'down';
    let error: string | undefined;

    try {
      if (!this.dataSource.isInitialized) throw new Error('not initialized');
      await this.dataSource.query('SELECT 1');
      database = 'up';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    res.status(
      database === 'up' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );

    return {
      status: database === 'up' ? 'ok' : 'error',
      database,
      latencyMs: Date.now() - startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      ...(error ? { error } : {}),
    };
  }
}
