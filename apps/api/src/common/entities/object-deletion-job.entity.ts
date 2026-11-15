import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** See migration 0035 for why this table exists and why `abandoned` is kept. */
export enum ObjectDeletionStatus {
  /** To be attempted at or after `nextAttemptAt`. */
  PENDING = 'pending',
  /** Terminal. Past the attempt ceiling; the bytes are still there. */
  ABANDONED = 'abandoned',
}

/** Where the job came from. Diagnostics only; nothing branches on it. */
export enum ObjectDeletionOrigin {
  /** An image dropped from a product's `images` array. */
  DETACHED = 'detached',
  /** An abandoned, never-attached upload removed by the sweeper. */
  ORPHAN_SWEEP = 'orphan_sweep',
  /** The object was stored but its database row could not be written. */
  UPLOAD_COMPENSATION = 'upload_compensation',
}

/**
 * A durable instruction to delete one object.
 *
 * WRITTEN IN THE SAME TRANSACTION that destroys the row which held the key.
 * That is the whole design: the key is never in a local variable only. Either
 * the image row is gone and this job exists, or neither happened.
 */
@Entity('object_deletion_jobs')
export class ObjectDeletionJob {
  @PrimaryGeneratedColumn()
  id: number;

  /** The object key inside the configured bucket. Unique. */
  @Column({ type: 'varchar', length: 512 })
  objectKey: string;

  @Column({
    type: 'enum',
    enum: ObjectDeletionStatus,
    default: ObjectDeletionStatus.PENDING,
  })
  status: ObjectDeletionStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** Last failure, truncated and stripped of signature material. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'varchar', length: 32 })
  origin: ObjectDeletionOrigin;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
