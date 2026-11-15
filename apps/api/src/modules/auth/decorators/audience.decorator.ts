import { SetMetadata } from '@nestjs/common';
import { SessionAudience } from '../audience';

export const AUDIENCES_KEY = 'session_audiences';

/**
 * Declares which application's session may reach a route.
 *
 * Ordering is significant and deliberate: a browser legitimately holds all
 * three cookie pairs at once, so "which cookie authenticates this request" must
 * be a property of the ROUTE, not of whichever cookie the parser happened to
 * yield first. The guard walks this list in the order written and uses the
 * first audience whose cookie is present.
 *
 * Handler-level declarations override class-level ones, matching `@Roles`.
 */
export const Audiences = (...audiences: SessionAudience[]) =>
  SetMetadata(AUDIENCES_KEY, audiences);
