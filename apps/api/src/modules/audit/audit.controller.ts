import { Controller, Get, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import { RequirePermissions } from 'src/modules/auth/permissions/permission.decorator';
import {
  ACCESS_TOKEN_SECURITY_SCHEME,
  ApiAuthRequired,
  ApiInvalidInput,
  ApiPermissionForbidden,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';
import { AuditQueryDto } from './dto/audit-query.dto';

interface AuditRow {
  id: string;
  actorUserId: number | null;
  actorDisplaySnapshot: string;
  actorAudience: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  summary: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * READ-ONLY. There is no write route, and there could not usefully be one:
 * `admin_audit_log` carries a database trigger that raises on UPDATE and
 * DELETE, so the trail is append-only regardless of what any controller
 * offers. Rows are written by `AuditService`, inside the transaction of the
 * act they describe.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Admin: audit trail')
@Controller('admin/audit')
@Audiences('admin')
@RequirePermissions('audit.read')
export class AuditController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @ApiOperation({
    summary: 'The administrative audit trail',
    description:
      'Newest first. Server-side paginated and bounded at 100 rows per page ' +
      'by `PaginationDto`; there is no unbounded mode.',
  })
  @ApiOkResponse({
    description: 'One page of audit rows.',
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
      properties: {
        total: { type: 'integer' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
        totalPages: { type: 'integer' },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('audit.read')
  @Get()
  async list(@Query() query: AuditQueryDto) {
    const where: string[] = [];
    const params: unknown[] = [];

    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    if (query.action) add(`"action" = $?`, query.action);
    if (query.targetType) add(`"targetType" = $?`, query.targetType);
    if (query.targetId) add(`"targetId" = $?`, query.targetId);
    if (query.actorUserId) add(`"actorUserId" = $?`, query.actorUserId);
    if (query.from) add(`"createdAt" >= $?::timestamptz`, query.from);
    if (query.to) add(`"createdAt" <= $?::timestamptz`, query.to);

    const predicate = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countRows = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM "admin_audit_log" ${predicate}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);

    // `id DESC` is the tiebreaker, not decoration: `createdAt` has a default of
    // `now()`, which is the TRANSACTION timestamp — several rows written in one
    // transaction share it exactly, and without the tiebreaker they would
    // shuffle between pages.
    const rows = await this.dataSource.query<AuditRow[]>(
      `SELECT "id"::text AS id, "actorUserId", "actorDisplaySnapshot",
              "actorAudience", "action", "targetType", "targetId",
              "targetLabel", "summary", "createdAt"
         FROM "admin_audit_log" ${predicate}
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, (query.page - 1) * query.limit],
    );

    return {
      data: rows,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 0,
    };
  }
}
