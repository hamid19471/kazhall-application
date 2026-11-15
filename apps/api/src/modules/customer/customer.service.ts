import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Customer } from './entities/customer.entity';
import { EntityManager, Repository } from 'typeorm';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import { CustomerMessages } from 'src/common/constants/customer.messages';
import { randomBytes } from 'crypto';

@Injectable()
export class CustomerService {
  constructor(
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  findOneByMobile(mobile: string) {
    return this.customerRepository.findOne({
      where: { mobile },
    });
  }

  async create(customerData: CreateCustomerDto) {
    const customer = this.customerRepository.create(customerData);
    return await this.customerRepository.save(customer);
  }

  /**
   * Transaction-aware upsert used by the POS sale.
   *
   * Everything goes through the caller's `EntityManager`. The previous POS code
   * called `findOneByMobile`/`create`, which use the *injected* repository and
   * therefore ran on a different connection outside the sale's transaction: a
   * failed sale left an orphan customer behind, and a customer created here was
   * visible to other sessions before the sale committed.
   *
   * The unique index on `customers.mobile` is the concurrency primitive: two
   * simultaneous first-time sales to the same number race on the INSERT and the
   * loser re-reads the winner's row. The INSERT is savepointed so the
   * unique-violation does not abort the surrounding sale transaction.
   */
  async findOrCreateByMobile(
    manager: EntityManager,
    input: { mobile: string; name?: string | null },
  ): Promise<Customer> {
    const repo = manager.getRepository(Customer);

    const existing = await repo.findOne({ where: { mobile: input.mobile } });
    if (existing) {
      // Fill in a name we did not have before; never blank an existing one.
      if (input.name && !existing.name) {
        existing.name = input.name;
        await repo.save(existing);
      }
      return existing;
    }

    const savepoint = `sp_cust_${randomBytes(6).toString('hex')}`;
    await manager.query(`SAVEPOINT ${savepoint}`);
    try {
      const created = repo.create({
        mobile: input.mobile,
        name: input.name ?? null,
      });
      const saved = await repo.save(created);
      await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
      return saved;
    } catch (err) {
      await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      if ((err as { code?: string })?.code !== '23505') throw err;
      const raced = await repo.findOne({ where: { mobile: input.mobile } });
      if (!raced) throw err;
      return raced;
    }
  }

  async findAll(pagination: PaginationDto) {
    const { page, limit } = pagination;

    const [data, total] = await this.customerRepository.findAndCount({
      order: { id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: number) {
    const customer = await this.customerRepository.findOne({
      where: { id },
    });
    if (!customer) {
      throw new NotFoundException(CustomerMessages.CUSTOMER_NOT_FOUND);
    }
    return customer;
  }
}
