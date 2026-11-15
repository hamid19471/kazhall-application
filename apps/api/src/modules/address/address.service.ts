import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Address } from './entities/address.entity';
import { Repository } from 'typeorm';
import { UserService } from '../user/user.service';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import { AddressMessages } from 'src/common/constants/address.messages';

@Injectable()
export class AddressService {
  private readonly logger = new Logger(AddressService.name);

  constructor(
    @InjectRepository(Address)
    private readonly addressRepository: Repository<Address>,
    private readonly userService: UserService,
  ) {}
  async create(createAddressDto: CreateAddressDto, userId: number) {
    const user = await this.userService.findOneById(userId);
    const address = this.addressRepository.create({
      user,
      ...createAddressDto,
    });
    return this.addressRepository.save(address);
  }

  async findAll(query: PaginationDto) {
    const { page, limit } = query;
    const queryBuilder = this.addressRepository
      .createQueryBuilder('addresses')
      .leftJoinAndSelect('addresses.user', 'user');

    queryBuilder.skip((page - 1) * limit).take(limit);

    const [addresses, total] = await queryBuilder.getManyAndCount();
    return {
      data: addresses,
      total,
      page,
      limit,
      tatalPage: Math.ceil(total / limit),
    };
  }

  // =========================================================================
  // OWNER-SCOPED READS AND WRITES
  //
  // `findOne` / `update` / `remove` below take an id and NOTHING ELSE. They are
  // administrative primitives and they are safe only because the only routes
  // that reach them are super-admin routes. `OrdersService.create` used to call
  // `findOne(dto.address)` with a customer-supplied id and no ownership check at
  // all, which meant any authenticated customer could ship an order to any other
  // customer's saved address just by guessing a small integer.
  //
  // Every customer-facing path now goes through the `...OwnedBy` variants, which
  // make the owner a MANDATORY parameter. That is the point: an ownership check
  // that lives in the caller is a check that eventually gets forgotten, so the
  // signature refuses to be called without one.
  // =========================================================================

  /**
   * The only address lookup a customer-facing path may use.
   *
   * A row that exists but belongs to someone else is reported as NOT FOUND, with
   * the same status and the same body as a row that does not exist. A 403 would
   * confirm the id is real and turn this into an enumeration oracle for other
   * customers' address ids. The real reason is logged server-side.
   */
  async findOneOwnedBy(id: number, userId: number): Promise<Address> {
    const address = await this.addressRepository.findOne({
      where: { id },
      select: {
        id: true,
        province: true,
        city: true,
        address: true,
        postal_code: true,
        reciver_mobile: true,
        userId: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!address) {
      throw new NotFoundException(AddressMessages.ADDRESS_NOT_FOUND);
    }
    if (address.userId !== userId) {
      this.logger.warn(
        `user ${userId} attempted to use address ${id}, which belongs to user ${String(address.userId)}`,
      );
      throw new NotFoundException(AddressMessages.ADDRESS_NOT_OWNED);
    }
    return address;
  }

  /** Every address belonging to one customer. Never returns anyone else's. */
  async findAllOwnedBy(userId: number, query: PaginationDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const [addresses, total] = await this.addressRepository.findAndCount({
      where: { userId },
      order: { id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      data: addresses,
      total,
      page,
      limit,
      totalPage: Math.ceil(total / limit),
    };
  }

  async updateOwnedBy(
    id: number,
    userId: number,
    updateAddressDto: UpdateAddressDto,
  ): Promise<Address> {
    const address = await this.findOneOwnedBy(id, userId);
    Object.assign(address, updateAddressDto);
    return this.addressRepository.save(address);
  }

  /**
   * Deleting a saved address does NOT rewrite history: since migration 0015
   * every order carries its own `addressSnapshot`, so past orders keep the
   * address they were actually shipped to even after the customer removes it
   * from their address book.
   */
  async removeOwnedBy(id: number, userId: number): Promise<void> {
    const address = await this.findOneOwnedBy(id, userId);
    await this.addressRepository.delete(address.id);
  }

  // ---- administrative primitives (super-admin routes only) ----------------

  async findOne(id: number) {
    const address = await this.addressRepository.findOne({
      where: { id },
      relations: {
        user: true,
      },
    });
    if (!address)
      throw new NotFoundException(AddressMessages.ADDRESS_NOT_FOUND);
    return address;
  }

  async update(id: number, updateAddressDto: UpdateAddressDto) {
    const address = await this.findOne(id);
    Object.assign(address, updateAddressDto);
    return this.addressRepository.save(address);
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.addressRepository.delete(id);
  }
}
