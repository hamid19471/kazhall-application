/**
 * Which application this client speaks for.
 *
 * Cookies are scoped by host, not by port, so the storefront, the admin console
 * and the till all shared one cookie pair and each authenticated as whoever had
 * signed in last. The API now issues a separate, audience-bound session per
 * surface; a client must therefore say which surface it is, and it says so once
 * — at construction — so no call site can pick the wrong one.
 */
export const API_AUDIENCES = ["storefront", "admin", "pos"] as const;

export type ApiAudience = (typeof API_AUDIENCES)[number];

/** The auth routes for one surface. There is deliberately no shared `/auth/*`. */
export function authRoutes(audience: ApiAudience) {
  const base = `/auth/${audience}`;
  return {
    me: `${base}/me`,
    refresh: `${base}/refresh`,
    logout: `${base}/logout`,
    logoutAll: `${base}/logout-all`,
    /** The storefront's password door is review-only; staff use `login`. */
    login: audience === "storefront" ? `${base}/review-login` : `${base}/login`,
    sendOtp: `${base}/send-otp`,
    verifyOtp: `${base}/verify-otp`,
    /**
     * Self-service password change. Reachable while
     * `mustChangePassword` is set — it is the only thing that clears it.
     */
    changePassword: `${base}/change-password`,
  } as const;
}
