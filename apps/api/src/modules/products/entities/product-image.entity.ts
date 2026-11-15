import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Product } from './product.entity';

@Entity('product_images')
export class ProductImage {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Browser-reachable URL, built at upload time from `S3_PUBLIC_BASE_URL`.
   *
   * A CACHED VALUE, not the source of truth. Repointing the public base (a new
   * CDN, a new domain) does not rewrite these rows, so a deployment that moves
   * the asset host must rebuild them from {@link objectKey}. That is the right
   * way round: the key is stable and the URL is a rendering of it.
   */
  @Column()
  url: string;

  /**
   * The object's key inside the bucket. This is what identifies the stored
   * bytes, and the only thing any deletion path is allowed to act on.
   *
   * NULLABLE only for rows written before migration 0034, which do not know
   * their key. Nothing deletes an object for such a row — see the migration.
   */
  @Column({ type: 'varchar', length: 512, nullable: true })
  objectKey?: string | null;

  @Column({ type: 'integer', nullable: true })
  sortOrder?: number | null;

  /**
   * When the row was written. Exists so the orphan sweeper can tell an
   * abandoned detached upload from one that is four seconds old and about to
   * be attached by the form that made it.
   *
   * The index that serves the sweep is PARTIAL (`WHERE "productId" IS NULL`)
   * and is therefore declared by migration 0034 rather than by a decorator —
   * TypeORM's `@Index` cannot express a predicate, and a decorator that
   * described a different index than the one the database has would be worse
   * than none.
   */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => Product, (product) => product.images, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  product: Product;
}
