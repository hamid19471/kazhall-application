import { SessionAudience } from './audience';

/**
 * How the guard tells the passport strategy which cookie to read.
 *
 * `JwtStrategy` is constructed once, but the cookie it must extract depends on
 * the route being called, which only the guard can see. The guard resolves the
 * route's declared audiences and writes them here before delegating to passport;
 * the extractor then reads exactly one cookie, and `validate` asserts that the
 * token inside it agrees. Nothing here is client-supplied.
 */
export const AUDIENCE_REQUEST_KEY = '__kzRequiredAudiences';
export const SELECTED_AUDIENCE_REQUEST_KEY = '__kzSelectedAudience';

export interface AudienceAwareRequest {
  cookies?: Record<string, string | undefined>;
  [AUDIENCE_REQUEST_KEY]?: readonly SessionAudience[];
  [SELECTED_AUDIENCE_REQUEST_KEY]?: SessionAudience;
}
