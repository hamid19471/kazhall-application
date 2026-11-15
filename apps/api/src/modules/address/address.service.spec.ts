import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AddressService } from './address.service';
import { Address } from './entities/address.entity';
import { CreateAddressDto } from './dto/create-address.dto';
import { UserService } from '../user/user.service';
import { User } from '../user/entities/user.entity';
import { NotFoundException } from '@nestjs/common';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

/**
 * The original specs were written against `@jest/globals`, which types
 * `jest.fn<F>()` with a single function-type parameter. That package is NOT
 * installed; this project uses `@types/jest`, whose signature is
 * `jest.fn<Return, Args>()`. `mockFn` keeps the original, more readable call
 * sites working against the installed typings.
 */
const mockFn = <F extends (...args: any[]) => any>(
  implementation?: F,
): jest.MockedFunction<F> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<F>;

describe('AddressService', () => {
  let service: AddressService; //What is to be tested
  let addressRepository: jest.Mocked<Repository<Address>>; //Dependency
  let userService: jest.Mocked<UserService>; //Dependency

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AddressService,
        {
          provide: getRepositoryToken(Address),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            createQueryBuilder: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
          },
        },
        {
          provide: UserService,
          useValue: {
            findOneById: jest.fn(),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(AddressService);
    addressRepository = moduleRef.get(getRepositoryToken(Address));
    userService = moduleRef.get(UserService);
  });
  describe('create', () => {
    it('should create address successfully', async () => {
      // Arrange
      const userId = 1;

      const createAddressDto: CreateAddressDto = {
        province: 'Tehran',
        city: 'Tehran',
        address: 'Valiasr Street',
        postal_code: '1234567890',
        reciver_mobile: '09123456789',
        description: 'this is a test',
      };

      const fakeUser = {
        id: userId,
        mobile: 'Behnam',
      } as User;

      const fakeAddress = {
        id: 1,
        user: fakeUser,
        ...createAddressDto,
      } as Partial<Address> as Address;

      userService.findOneById.mockResolvedValue(fakeUser); // For Async methods
      addressRepository.create.mockReturnValue(fakeAddress); //For Sync methods
      addressRepository.save.mockResolvedValue(fakeAddress);

      // Act
      const result = await service.create(createAddressDto, userId);

      // Assert
      expect(userService.findOneById).toHaveBeenCalledWith(userId);

      expect(addressRepository.create).toHaveBeenCalledWith({
        user: fakeUser,
        ...createAddressDto,
      });

      expect(addressRepository.save).toHaveBeenCalledWith(fakeAddress);

      expect(result).toEqual(fakeAddress);
    });

    it('should throw NotFoundException when user does not exist', async () => {
      // Arrange
      const userId = 1;

      const createAddressDto: CreateAddressDto = {
        province: 'Tehran',
        city: 'Tehran',
        address: 'Valiasr Street',
        postal_code: '1234567890',
        reciver_mobile: '09123456789',
        description: 'this is a test',
      };

      userService.findOneById.mockRejectedValue(
        new NotFoundException('User not found'),
      ); // For Async methods

      // Act
      await expect(service.create(createAddressDto, userId)).rejects.toThrow(
        NotFoundException,
      );

      // Assert

      expect(addressRepository.create).not.toHaveBeenCalled();

      expect(addressRepository.save).not.toHaveBeenCalled();
    });

    it('should throw when repository.save fails', async () => {
      // Arrange
      const userId = 1;

      const createAddressDto: CreateAddressDto = {
        province: 'Tehran',
        city: 'Tehran',
        address: 'Valiasr Street',
        postal_code: '1234567890',
        reciver_mobile: '09123456789',
        description: 'this is a test',
      };

      const fakeUser = {
        id: userId,
        mobile: 'Behnam',
      } as User;

      const fakeAddress = {
        id: 1,
        user: fakeUser,
        ...createAddressDto,
      } as Partial<Address> as Address;

      userService.findOneById.mockResolvedValue(fakeUser); // For Async methods
      addressRepository.create.mockReturnValue(fakeAddress); //For Sync methods
      addressRepository.save.mockRejectedValue(
        new NotFoundException('ِDatabase Error'),
      );

      // Act
      await expect(service.create(createAddressDto, userId)).rejects.toThrow(
        NotFoundException,
      );

      // Assert

      expect(userService.findOneById).toHaveBeenCalledWith(userId);

      expect(addressRepository.create).toHaveBeenCalledWith({
        user: fakeUser,
        ...createAddressDto,
      });

      expect(addressRepository.save).toHaveBeenCalledWith(fakeAddress);
    });
  });
  describe('findAll', () => {
    it('should return paginated address list', async () => {
      //Arrange
      const query: PaginationDto = {
        page: 1,
        limit: 10,
      };
      const fakeAddresses = [
        {
          province: 'Tehrannnn',
          city: 'Tehran',
          address: 'Valiasr Street',
          postal_code: '1234567890',
          reciver_mobile: '09123456789',
        },
        {
          province: 'Tehran',
          city: 'Tehran',
          address: 'Valiasr Street',
          postal_code: '1234567890',
          reciver_mobile: '09123456789',
        },
      ] as Address[];

      const total = 2;

      const queryBuilder: any = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: mockFn<() => Promise<[Address[], number]>>(),
      };
      queryBuilder.getManyAndCount.mockResolvedValue([fakeAddresses, total]);
      (addressRepository.createQueryBuilder as jest.Mock).mockReturnValue(
        queryBuilder,
      );
      //Act
      const result = await service.findAll(query);

      //Assert
      expect(addressRepository.createQueryBuilder).toHaveBeenCalledWith(
        'addresses',
      );

      expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
        'addresses.user',
        'user',
      );

      expect(queryBuilder.skip).toHaveBeenCalledWith(0);

      expect(queryBuilder.take).toHaveBeenCalledWith(10);

      expect(queryBuilder.getManyAndCount).toHaveBeenCalled();

      expect(result).toEqual({
        data: fakeAddresses,
        total,
        page: 1,
        limit: 10,
        tatalPage: 1,
      });
    });
  });
  describe('findOne', () => {
    it('should return an address by id', async () => {
      //Arrange
      const addressId = 1;
      const fakeAddress = {
        id: addressId,
        province: 'Tehran',
        city: 'Tehran',
        address: 'Valiasr Street',
        postal_code: '1234567890',
        reciver_mobile: '09123456789',
      } as Address;

      addressRepository.findOne.mockResolvedValue(fakeAddress);

      //Act
      const result = await service.findOne(addressId);

      //Assert
      expect(addressRepository.findOne).toHaveBeenCalledWith({
        where: { id: addressId },
        // AddressService uses the object relations form; the array form is
        // equivalent to TypeORM but not to toHaveBeenCalledWith.
        relations: { user: true },
      });

      expect(result).toEqual(fakeAddress);
    });

    it('should throw NotFoundException when address does not exist', async () => {
      //Arrange
      const addressId = 1;

      addressRepository.findOne.mockResolvedValue(null);

      //Act & Assert
      await expect(service.findOne(addressId)).rejects.toThrow(
        NotFoundException,
      );

      expect(addressRepository.findOne).toHaveBeenCalled();
    });
  });
  describe('update', () => {
    it('should update an address successfully', async () => {
      //Arrange
      const addressId = 1;
      const updateAddressDto = {
        province: 'Tehran',
        city: 'Tehran',
        address: 'Valiasr Street',
        postal_code: '1234567890',
        reciver_mobile: '09123456789',
      } as UpdateAddressDto;

      const fakeAddress = {
        id: addressId,
        province: 'Tehran',
        city: 'Tehran',
        address: 'Valiasr Street',
        postal_code: '1234567890',
        reciver_mobile: '09123456789',
      } as Address;

      addressRepository.findOne.mockResolvedValue(fakeAddress);
      addressRepository.save.mockResolvedValue({
        ...fakeAddress,
        ...updateAddressDto,
      });

      //Act
      const result = await service.update(addressId, updateAddressDto);

      //Assert
      expect(addressRepository.findOne).toHaveBeenCalledWith({
        where: { id: addressId },
        // AddressService uses the object relations form; the array form is
        // equivalent to TypeORM but not to toHaveBeenCalledWith.
        relations: { user: true },
      });

      expect(addressRepository.save).toHaveBeenCalledWith({
        ...fakeAddress,
        ...updateAddressDto,
      });

      expect(result).toEqual({
        ...fakeAddress,
        ...updateAddressDto,
      });
    });

    it('should throw NotFoundException when updating a non-existent address', async () => {
      //Arrange
      const addressId = 1;
      const updateAddressDto = {
        province: 'Tehran',
        city: 'Tehran',
        address: 'Valiasr Street',
        postal_code: '1234567890',
        reciver_mobile: '09123456789',
      } as UpdateAddressDto;

      addressRepository.findOne.mockResolvedValue(null);

      //Act & Assert
      await expect(service.update(addressId, updateAddressDto)).rejects.toThrow(
        NotFoundException,
      );

      expect(addressRepository.findOne).toHaveBeenCalledWith({
        where: { id: addressId },
        // AddressService uses the object relations form; the array form is
        // equivalent to TypeORM but not to toHaveBeenCalledWith.
        relations: { user: true },
      });

      expect(addressRepository.save).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when repository.save fails during update', async () => {
      //Arrange
      const addressId = 1;
      const updateAddressDto = {
        province: 'Tehran',
        city: 'Tehran',
        address: 'Valiasr Street',
        postal_code: '1234567890',
        reciver_mobile: '09123456789',
      } as UpdateAddressDto;

      const fakeAddress = {
        id: addressId,
        province: 'Tehran',
        city: 'Tehran',
        address: 'Valiasr Street',
        postal_code: '1234567890',
        reciver_mobile: '09123456789',
      } as Address;

      addressRepository.findOne.mockResolvedValue(fakeAddress);
      addressRepository.save.mockRejectedValue(
        new NotFoundException('Database Error'),
      );

      //Act & Assert
      await expect(service.update(addressId, updateAddressDto)).rejects.toThrow(
        NotFoundException,
      );

      expect(addressRepository.findOne).toHaveBeenCalledWith({
        where: { id: addressId },
        // AddressService uses the object relations form; the array form is
        // equivalent to TypeORM but not to toHaveBeenCalledWith.
        relations: { user: true },
      });

      expect(addressRepository.save).toHaveBeenCalledWith({
        ...fakeAddress,
        ...updateAddressDto,
      });
    });
  });
  describe('remove', () => {
    it('should remove an address successfully', async () => {
      //Arrange
      const addressId = 1;
      const fakeAddress = {
        id: addressId,
        province: 'Tehran',
        city: 'Tehran',
        address: 'Valiasr Street',
        postal_code: '1234567890',
        reciver_mobile: '09123456789',
      } as Address;

      addressRepository.findOne.mockResolvedValue(fakeAddress);
      addressRepository.delete.mockResolvedValue({ affected: 1 } as any);

      //Act
      await service.remove(addressId);

      //Assert
      expect(addressRepository.findOne).toHaveBeenCalledWith({
        where: { id: addressId },
        // AddressService uses the object relations form; the array form is
        // equivalent to TypeORM but not to toHaveBeenCalledWith.
        relations: { user: true },
      });

      expect(addressRepository.delete).toHaveBeenCalledWith(addressId);
    });

    it('should throw NotFoundException when removing a non-existent address', async () => {
      //Arrange
      const addressId = 1;

      addressRepository.findOne.mockResolvedValue(null);

      //Act & Assert
      await expect(service.remove(addressId)).rejects.toThrow(
        NotFoundException,
      );

      expect(addressRepository.findOne).toHaveBeenCalledWith({
        where: { id: addressId },
        // AddressService uses the object relations form; the array form is
        // equivalent to TypeORM but not to toHaveBeenCalledWith.
        relations: { user: true },
      });
    });
  });
});
