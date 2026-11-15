/**
 * The storefront's password door.
 *
 * Production customer authentication is OTP and stays OTP. This exists only so
 * the application can be reviewed while no SMS provider is configured, so it is
 * off unless BOTH conditions hold: the process is not running in production,
 * and an operator has deliberately switched it on. Either one alone is an
 * accident waiting to ship.
 */
export function isReviewLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.KAZHAL_ENABLE_REVIEW_LOGIN === 'true'
  );
}
