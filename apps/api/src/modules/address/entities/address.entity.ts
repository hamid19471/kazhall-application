import { Order } from 'src/modules/orders/entities/order.entity';
import { User } from 'src/modules/user/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'addresses' })
// A UNIQUE(user, postal_code, address) was considered and left out: a
// customer may legitimately save the same street address twice under
// different receivers. (The `Unique` import went with it.)
export class Address {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  province: string;

  @Column()
  city: string;

  @Column('text')
  address: string;

  @Column({ length: 10 })
  postal_code: string;

  @Column({ length: 11 })
  reciver_mobile: string;

  @ManyToOne(() => User, (user) => user.addresses)
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * OWNER. Exposed explicitly so an ownership check is a plain column
   * comparison instead of an eager relation load — every address read on a
   * customer path is scoped by this, and a check you have to remember to join
   * for is a check that eventually gets forgotten.
   */
  @Column({ type: 'int', nullable: true })
  userId: number | null;

  @OneToMany(() => Order, (order) => order.address)
  orders: Order[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
