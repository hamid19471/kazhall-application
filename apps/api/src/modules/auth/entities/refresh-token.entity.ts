import { User } from 'src/modules/user/entities/user.entity';
import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { SessionAudience } from '../audience';

@Entity('refresh_tokens')
export class RefreshToken {
  @Column({ type: 'uuid', primary: true })
  tokenId: string;

  @Column()
  userId: number;

  @ManyToOne(() => User, (user) => user.refreshToken, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  tokenHash: string;

  /**
   * Which surface this session belongs to. Bound at issue time and re-checked
   * on every rotation, so a till refresh token cannot be rotated into a
   * storefront session even though both are signed with the same secret.
   */
  @Column({ type: 'varchar', length: 16 })
  audience: SessionAudience;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ default: false })
  revoked: boolean;

  // @CreateDateColumn()
  // created_at: Date;

  // @UpdateDateColumn()
  // updated_at: Date;
}
