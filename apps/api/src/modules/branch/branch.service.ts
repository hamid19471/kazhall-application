import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Branch } from './entities/branch.entity';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { BranchQueryDto } from './dto/branch-query.dto';
import {
  BranchErrorCodes,
  BranchMessages,
} from 'src/common/constants/branch.messages';
import { AuditService, AuditActor } from 'src/modules/audit/audit.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';

export interface BranchListRow {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  /** Staff whose `users.branchId` points here, active accounts only. */
  activeStaffCount: number;
  /** Staff including deactivated accounts — the number that blocks a delete. */
  totalStaffCount: number;
  /** Orders that still reference this branch at all. */
  orderCount: number;
  /** Orders that are neither finished nor reversed, i.e. still operational. */
  openOrderCount: number;
  createdAt: Date;
}

export interface BranchStaffRow {
  id: number;
  identifier: string;
  mobile: string | null;
  isActive: boolean;
  roles: string[];
}

export interface BranchDetail extends BranchListRow {
  staff: BranchStaffRow[];
}

/**
 * Statuses that mean "this order is still moving". A branch with any of these
 * is one an operator should look at before retiring it — the deactivation is
 * still allowed (it only stops NEW sales), but the screen says so rather than
 * letting the manager find out from a confused cashier.
 */
const OPEN_ORDER_STATUSES = ['pending', 'paid', 'processing', 'shipped'];

@Injectable()
export class BranchService {
  constructor(
    @InjectRepository(Branch)
    private readonly branchRepository: Repository<Branch>,
    private readonly audit: AuditService,
  ) {}

  // =========================================================================
  // Reads
  // =========================================================================

  /**
   * Every caller that needs a branch PICKER uses this — the till and the order
   * filter included — so it stays cheap and unpaginated-by-default is NOT an
   * option: it is paginated like every other admin collection, and the picker
   * asks for a page of 100.
   *
   * The four counts come from correlated sub-selects rather than four separate
   * round trips per row. The branch table is small (single digits in practice)
   * and each sub-select hits an index, so this is one bounded query, not an
   * N+1.
   */
  async list(query: BranchQueryDto): Promise<{
    data: BranchListRow[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.search) {
      params.push(`%${query.search.toLowerCase()}%`);
      where.push(
        `(LOWER(b."name") LIKE $${params.length} OR LOWER(COALESCE(b."address", '')) LIKE $${params.length})`,
      );
    }
    if (query.isActive !== undefined) {
      params.push(query.isActive);
      where.push(`b."isActive" = $${params.length}`);
    }
    const predicate = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRows = await this.branchRepository.manager.query<
      Array<{ count: string }>
    >(`SELECT COUNT(*)::text AS count FROM "branches" b ${predicate}`, params);
    const total = Number(countRows[0]?.count ?? 0);

    const rows = await this.branchRepository.manager.query<
      Array<{
        id: number;
        name: string;
        address: string | null;
        phone: string | null;
        isActive: boolean;
        activeStaffCount: string;
        totalStaffCount: string;
        orderCount: string;
        openOrderCount: string;
        createdAt: Date;
      }>
    >(
      `SELECT b."id", b."name", b."address", b."phone", b."isActive",
              b."createdAt",
              (SELECT COUNT(*)::text FROM "users" u
                WHERE u."branchId" = b."id" AND u."deactivatedAt" IS NULL)
                AS "activeStaffCount",
              (SELECT COUNT(*)::text FROM "users" u
                WHERE u."branchId" = b."id") AS "totalStaffCount",
              (SELECT COUNT(*)::text FROM "orders" o
                WHERE o."branchId" = b."id") AS "orderCount",
              (SELECT COUNT(*)::text FROM "orders" o
                WHERE o."branchId" = b."id"
                  AND o."status"::text = ANY($${params.length + 1}::text[])
                  AND o."voidedAt" IS NULL) AS "openOrderCount"
         FROM "branches" b
         ${predicate}
        ORDER BY b."isActive" DESC, b."name" ASC, b."id" ASC
        LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
      [
        ...params,
        OPEN_ORDER_STATUSES,
        query.limit,
        (query.page - 1) * query.limit,
      ],
    );

    return {
      data: rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        address: row.address,
        phone: row.phone,
        isActive: row.isActive,
        activeStaffCount: Number(row.activeStaffCount),
        totalStaffCount: Number(row.totalStaffCount),
        orderCount: Number(row.orderCount),
        openOrderCount: Number(row.openOrderCount),
        createdAt: row.createdAt,
      })),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 0,
    };
  }

  /** Kept for internal callers (the till resolves branch names through it). */
  async findAll(): Promise<Branch[]> {
    return this.branchRepository.find({ order: { name: 'ASC', id: 'ASC' } });
  }

  async findOne(id: number): Promise<Branch> {
    const branch = await this.branchRepository.findOne({ where: { id } });
    if (!branch) throw new NotFoundException(BranchMessages.BRANCH_NOT_FOUND);
    return branch;
  }

  /** The branch plus the staff assigned to it — what the detail screen needs. */
  async detail(id: number): Promise<BranchDetail> {
    const branch = await this.findOne(id);

    const summaryRows = await this.branchRepository.manager.query<
      Array<{
        activeStaffCount: string;
        totalStaffCount: string;
        orderCount: string;
        openOrderCount: string;
      }>
    >(
      `SELECT (SELECT COUNT(*)::text FROM "users" u
                WHERE u."branchId" = $1 AND u."deactivatedAt" IS NULL)
                AS "activeStaffCount",
              (SELECT COUNT(*)::text FROM "users" u WHERE u."branchId" = $1)
                AS "totalStaffCount",
              (SELECT COUNT(*)::text FROM "orders" o WHERE o."branchId" = $1)
                AS "orderCount",
              (SELECT COUNT(*)::text FROM "orders" o
                WHERE o."branchId" = $1
                  AND o."status"::text = ANY($2::text[])
                  AND o."voidedAt" IS NULL) AS "openOrderCount"`,
      [id, OPEN_ORDER_STATUSES],
    );
    const summary = summaryRows[0];

    // ONE query for the staff and their role names — `string_agg` rather than a
    // second round trip per user.
    const staff = await this.branchRepository.manager.query<
      Array<{
        id: number;
        username: string | null;
        mobile: string | null;
        deactivatedAt: Date | null;
        roles: string | null;
      }>
    >(
      `SELECT u."id", u."username", u."mobile", u."deactivatedAt",
              STRING_AGG(r."name", ',' ORDER BY r."name") AS roles
         FROM "users" u
         LEFT JOIN "user_roles" ur ON ur."usersId" = u."id"
         LEFT JOIN "roles" r ON r."id" = ur."rolesId"
        WHERE u."branchId" = $1
        GROUP BY u."id"
        ORDER BY u."deactivatedAt" NULLS FIRST, u."id" ASC
        LIMIT 200`,
      [id],
    );

    return {
      id: branch.id,
      name: branch.name,
      address: branch.address ?? null,
      phone: branch.phone ?? null,
      isActive: branch.isActive !== false,
      activeStaffCount: Number(summary?.activeStaffCount ?? 0),
      totalStaffCount: Number(summary?.totalStaffCount ?? 0),
      orderCount: Number(summary?.orderCount ?? 0),
      openOrderCount: Number(summary?.openOrderCount ?? 0),
      createdAt: branch.createdAt,
      staff: staff.map((row) => ({
        id: Number(row.id),
        identifier: row.username ?? row.mobile ?? `user#${row.id}`,
        mobile: row.mobile,
        isActive: row.deactivatedAt === null,
        roles: row.roles ? row.roles.split(',') : [],
      })),
    };
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async create(dto: CreateBranchDto, actor: AuditActor): Promise<Branch> {
    return this.branchRepository.manager.transaction(async (manager) => {
      const existing = await manager.getRepository(Branch).findOne({
        where: { name: dto.name },
      });
      if (existing) {
        throw new ConflictException({
          error: BranchErrorCodes.BRANCH_NAME_TAKEN,
          message: BranchMessages.BRANCH_NAME_TAKEN,
          name: dto.name,
        });
      }

      const branch = await manager
        .getRepository(Branch)
        .save(manager.getRepository(Branch).create({ ...dto, isActive: true }));

      await this.audit.record(
        {
          actor,
          action: AuditAction.BRANCH_CREATED,
          targetType: AuditTarget.BRANCH,
          targetId: branch.id,
          targetLabel: branch.name,
          summary: {
            after: {
              name: branch.name,
              address: branch.address ?? null,
              phone: branch.phone ?? null,
            },
          },
        },
        manager,
      );

      return branch;
    });
  }

  async update(
    id: number,
    dto: UpdateBranchDto,
    actor: AuditActor,
  ): Promise<Branch> {
    return this.branchRepository.manager.transaction(async (manager) => {
      const branch = await manager.getRepository(Branch).findOne({
        where: { id },
      });
      if (!branch) throw new NotFoundException(BranchMessages.BRANCH_NOT_FOUND);

      if (dto.name !== undefined && dto.name !== branch.name) {
        const clash = await manager.getRepository(Branch).findOne({
          where: { name: dto.name },
        });
        if (clash) {
          throw new ConflictException({
            error: BranchErrorCodes.BRANCH_NAME_TAKEN,
            message: BranchMessages.BRANCH_NAME_TAKEN,
            name: dto.name,
          });
        }
      }

      const before = {
        name: branch.name,
        address: branch.address ?? null,
        phone: branch.phone ?? null,
      };
      Object.assign(branch, dto);
      const saved = await manager.getRepository(Branch).save(branch);

      await this.audit.record(
        {
          actor,
          action: AuditAction.BRANCH_UPDATED,
          targetType: AuditTarget.BRANCH,
          targetId: saved.id,
          targetLabel: saved.name,
          summary: {
            before,
            after: {
              name: saved.name,
              address: saved.address ?? null,
              phone: saved.phone ?? null,
            },
          },
        },
        manager,
      );

      // Renaming does NOT rewrite history: every order carries a
      // `branchNameSnapshot` taken at sale time and it is never touched here.
      return saved;
    });
  }

  async setActive(
    id: number,
    isActive: boolean,
    actor: AuditActor,
  ): Promise<BranchDetail> {
    await this.branchRepository.manager.transaction(async (manager) => {
      const branch = await manager.getRepository(Branch).findOne({
        where: { id },
      });
      if (!branch) throw new NotFoundException(BranchMessages.BRANCH_NOT_FOUND);
      if (branch.isActive === isActive) return;

      branch.isActive = isActive;
      await manager.getRepository(Branch).save(branch);

      await this.audit.record(
        {
          actor,
          action: isActive
            ? AuditAction.BRANCH_ACTIVATED
            : AuditAction.BRANCH_DEACTIVATED,
          targetType: AuditTarget.BRANCH,
          targetId: branch.id,
          targetLabel: branch.name,
          summary: { after: { isActive } },
        },
        manager,
      );
    });

    return this.detail(id);
  }

  /**
   * HARD DELETE, and only where it is genuinely safe.
   *
   * The previous implementation was `findOne` then `remove`, with no check at
   * all: `users.branchId` and `orders.branchId` are real foreign keys, so
   * deleting a branch anybody had ever sold from surfaced the restriction as a
   * 500 — and the route's own Swagger said so. Retiring a branch is
   * `setActive(false)`; this exists only to remove a branch created by mistake
   * that nothing points at.
   *
   * The counts and the delete run in ONE transaction with the row locked, so a
   * sale landing between the check and the delete cannot slip through.
   */
  async remove(id: number, actor: AuditActor): Promise<void> {
    await this.branchRepository.manager.transaction(async (manager) => {
      const locked = await manager.query<Array<{ id: number; name: string }>>(
        `SELECT "id", "name" FROM "branches" WHERE "id" = $1 FOR UPDATE`,
        [id],
      );
      if (locked.length === 0) {
        throw new NotFoundException(BranchMessages.BRANCH_NOT_FOUND);
      }

      const rows = await manager.query<
        Array<{ staff: string; orders: string }>
      >(
        `SELECT (SELECT COUNT(*)::text FROM "users" WHERE "branchId" = $1) AS staff,
                (SELECT COUNT(*)::text FROM "orders" WHERE "branchId" = $1) AS orders`,
        [id],
      );
      const staffCount = Number(rows[0]?.staff ?? 0);
      const orderCount = Number(rows[0]?.orders ?? 0);

      if (staffCount > 0 || orderCount > 0) {
        throw new ConflictException({
          error: BranchErrorCodes.BRANCH_IN_USE,
          message: BranchMessages.BRANCH_IN_USE,
          staffCount,
          orderCount,
        });
      }

      await manager.query(`DELETE FROM "branches" WHERE "id" = $1`, [id]);

      await this.audit.record(
        {
          actor,
          action: AuditAction.BRANCH_UPDATED,
          targetType: AuditTarget.BRANCH,
          targetId: id,
          targetLabel: locked[0].name,
          summary: { after: { deleted: true } },
        },
        manager,
      );
    });
  }

  /**
   * Used by the sale path: a cashier assigned to a retired branch must not be
   * able to ring anything up. Returns the branch so the caller can name it in
   * the refusal.
   */
  async assertSellable(branchId: number): Promise<Branch> {
    const branch = await this.findOne(branchId);
    if (branch.isActive === false) {
      throw new ConflictException({
        error: BranchErrorCodes.BRANCH_INACTIVE,
        message: BranchMessages.BRANCH_INACTIVE,
        branchId,
      });
    }
    return branch;
  }
}
