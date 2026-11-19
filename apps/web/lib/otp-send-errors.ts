/**
 * What the sign-in screen does after a failed `POST /auth/storefront/send-otp`.
 *
 * Kept as a pure function (no React) so every server answer can be pinned by
 * `node --test`, and so the ONLY source of a wait time stays the server's own
 * `retryAfterSeconds`. Nothing here invents a number: when the server gives
 * none, the existing countdown is left exactly as it was.
 *
 * | status | code                     | countdown            | step       |
 * |--------|--------------------------|----------------------|------------|
 * | 429    | OTP_COOLDOWN             | server figure        | → code     |
 * | 429    | OTP_SEND_RATE_LIMITED    | server figure        | unchanged  |
 * | 503    | OTP_DELIVERY_UNCERTAIN   | server figure        | → code     |
 * | 503    | OTP_DELIVERY_FAILED      | server figure (0 ⇒ none, resend now) | unchanged |
 * | other  | —                        | unchanged            | unchanged  |
 *
 * UNCERTAIN moves to the code step because the SMS may still arrive and the
 * code it carries stays valid server-side; FAILED does not, because no code
 * can arrive. A FAILED answer with a NON-zero figure (the server could not
 * release the challenge) is honoured as given rather than assumed to be 0.
 */
export type SendOtpErrorLike = {
  status: number;
  code?: string | undefined;
  retryAfterSeconds?: number | undefined;
};

export type SendOtpFailureAction = {
  /** Seconds to count down from; `0` clears; `undefined` leaves it alone. */
  cooldownSeconds: number | undefined;
  /** Move to the code-entry step. */
  showCodeStep: boolean;
};

export const OTP_DELIVERY_FAILED = "OTP_DELIVERY_FAILED";
export const OTP_DELIVERY_UNCERTAIN = "OTP_DELIVERY_UNCERTAIN";
export const OTP_COOLDOWN = "OTP_COOLDOWN";

export function sendOtpFailureAction(error: SendOtpErrorLike): SendOtpFailureAction {
  const serverWait =
    typeof error.retryAfterSeconds === "number" &&
    Number.isFinite(error.retryAfterSeconds) &&
    error.retryAfterSeconds >= 0
      ? error.retryAfterSeconds
      : undefined;

  if (error.status === 429) {
    return { cooldownSeconds: serverWait, showCodeStep: error.code === OTP_COOLDOWN };
  }

  if (error.status === 503 && error.code === OTP_DELIVERY_UNCERTAIN) {
    return { cooldownSeconds: serverWait, showCodeStep: true };
  }

  if (error.status === 503 && error.code === OTP_DELIVERY_FAILED) {
    return { cooldownSeconds: serverWait, showCodeStep: false };
  }

  return { cooldownSeconds: undefined, showCodeStep: false };
}
