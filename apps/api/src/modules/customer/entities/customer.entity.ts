import { Order } from 'src/modules/orders/entities/order.entity';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'customers' })
export class Customer {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  mobile: string;

  @Column({
    type: 'varchar',
    nullable: true,
    default: null,
  })
  name: string | null;

  @OneToMany(() => Order, (order) => order.customer)
  orders: Order[];
}
