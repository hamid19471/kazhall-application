import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

/**
 * Self-service password change.
 *
 * `currentPassword` is required even though the caller already holds a valid
 * session: a session cookie proves the browser was signed in at some point,
 * not that the person at the keyboard is the account's owner. Without it, an
 * unattended terminal is a permanent account takeover.
 *
 * The length bound matches `LoginDto` (8..64) exactly — a policy that admits a
 * password the login form cannot accept is a way to lock somebody out of their
 * own account.
 */
export class ChangePasswordDto {
  @ApiProperty({ description: 'The password currently in use.' })
  @IsNotEmpty()
  @IsString()
  @Length(8, 64)
  currentPassword: string;

  @ApiProperty({
    description:
      'The replacement. Must differ from the current one, and must satisfy ' +
      'the same 8–64 character policy the login form enforces.',
  })
  @IsNotEmpty()
  @IsString()
  @Length(8, 64)
  newPassword: string;
}
