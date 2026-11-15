import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ProductAttributeValue } from './product-attribute-value.entity';

@Entity('product_attribute')
export class ProductAttribute {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  name: string;

  @OneToMany(() => ProductAttributeValue, (value) => value.attribute, {
    cascade: true,
    orphanedRowAction: 'delete',
  })
  values: ProductAttributeValue[];
}
