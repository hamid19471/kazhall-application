/**
 * Single-flight refresh coordinator.
 *
 * The API rotates the refresh token on every successful `POST /auth/<audience>/refresh`
 * (single-use rotation: both cookies are replaced). If two concurrent 401s each
 * fired their own refresh, the second would present an already-rotated token and
 * sign the user out. So: **at most one refresh is ever in flight**, and every
 * concurrent 401 awaits that same promise.
 *
 * A monotonically increasing `generation` closes the second half of the race: a
 * request that started before a refresh completed and 401'd afterwards does not
 * need another refresh — it only needs to retry with the cookies it now has.
 *
 * ## Why signed-IN is an event and not just a flag
 *
 * `signOut` has always been observable, because things have to be torn down
 * when it happens — the realtime client subscribes to it and closes its socket.
 * The reverse transition was only a flag (`signedOut = false`), so nothing
 * could be brought back UP, and one consequence was severe enough to name:
 *
 * An anonymous storefront visit probes the session with `GET /auth/.../me`.
 * That 401s, the 401 goes through {@link AuthCoordinator.ensureFresh}, the
 * refresh has no cookie to rotate and fails, and `signOut("refresh-failed")`
 * fires — so a guest page load STOPPED the realtime client. Signing in from
 * that same page (the storefront navigates with `router.replace`, which keeps
 * the provider mounted) set `signedOut = false` and told nobody, leaving the
 * customer with an open basket, a live session and no socket until a hard
 * reload. The whole point of the socket — a till sale reaching an untouched
 * tab in milliseconds — was dead on exactly the path a real customer takes.
 *
 * So the transition INTO the signed-in state is now published too, and the
 * realtime client restarts on it. Both directions are events; neither side
 * has to poll a flag to notice.
 */

export type SignedOutReason =
  | "refresh-failed"
  | "logout"
  | "session-invalidated"
  | "account-deactivated";

export interface AuthCoordinatorOptions {
  /** Performs `POST /auth/<audience>/refresh`. Resolves true when new cookies were set. */
  refresh: () => Promise<boolean>;
  /** Called once per transition into the signed-out state. */
  onSignedOut?: (reason: SignedOutReason) => void;
}

/**
 * Why a session became live again.
 *
 *  - `login` — an explicit credential exchange (`markSignedIn` after a
 *    password login or an OTP verification).
 *  - `refreshed` — a refresh that succeeded after the coordinator had already
 *    given up, i.e. the session recovered without a new credential.
 */
export type SignedInReason = "login" | "refreshed";

export class AuthCoordinator {
  private inFlight: Promise<boolean> | null = null;
  private generationCounter = 0;
  private signedOut = false;
  private readonly listeners = new Set<(reason: SignedOutReason) => void>();
  private readonly signedInListeners = new Set<(reason: SignedInReason) => void>();

  private readonly options: AuthCoordinatorOptions;

  /**
   * `options` is assigned explicitly rather than declared as a TypeScript
   * parameter property. The front-end unit tests run on Node's own runner
   * (`node --test lib/*.test.ts`), which STRIPS types instead of compiling
   * them, and a parameter property is the one piece of TypeScript that strip
   * -only mode cannot erase — it has to emit an assignment. Sugaring this
   * constructor therefore makes the module unimportable from
   * `lib/realtime-session-lifecycle.test.ts`, which is exactly where the
   * sign-out/sign-in contract is pinned.
   */
  constructor(options: AuthCoordinatorOptions) {
    this.options = options;
    if (options.onSignedOut) this.listeners.add(options.onSignedOut);
  }

  /**
   * Snapshot taken BEFORE a request is sent. Compare it after a 401 to decide
   * whether a refresh has already happened in the meantime.
   */
  get generation(): number {
    return this.generationCounter;
  }

  /** True once a refresh has failed (or `signOut` was called). */
  get isSignedOut(): boolean {
    return this.signedOut;
  }

  /** Subscribe to signed-out transitions. Returns an unsubscribe function. */
  onSignedOut(listener: (reason: SignedOutReason) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to signed-in transitions. Returns an unsubscribe function.
   *
   * Fires on every call to {@link markSignedIn} and on a refresh that revives
   * an already-signed-out coordinator — NOT on an ordinary successful refresh
   * of a session that was never lost, which is not a transition and would make
   * a subscriber tear down a perfectly good socket every fifteen minutes.
   */
  onSignedIn(listener: (reason: SignedInReason) => void): () => void {
    this.signedInListeners.add(listener);
    return () => {
      this.signedInListeners.delete(listener);
    };
  }

  /** Clear the signed-out flag after a successful login. */
  markSignedIn(): void {
    this.signedOut = false;
    this.generationCounter += 1;
    this.announceSignedIn("login");
  }

  private announceSignedIn(reason: SignedInReason): void {
    for (const listener of this.signedInListeners) {
      try {
        listener(reason);
      } catch {
        // A listener must never break the request pipeline.
      }
    }
  }

  /** Enter the signed-out state and notify listeners exactly once. */
  signOut(reason: SignedOutReason): void {
    if (this.signedOut) return;
    this.signedOut = true;
    this.generationCounter += 1;
    for (const listener of this.listeners) {
      try {
        listener(reason);
      } catch {
        // A listener must never break the request pipeline.
      }
    }
  }

  /**
   * Ensure the session is fresh, single-flight.
   *
   * @param observedGeneration the value of {@link generation} captured before
   *        the request that just 401'd was sent.
   * @returns `true` when it is worth retrying the request once.
   */
  async ensureFresh(observedGeneration: number): Promise<boolean> {
    // Someone else already refreshed (or signed out) since this request started.
    if (this.generationCounter !== observedGeneration) {
      return !this.signedOut;
    }
    if (this.signedOut) return false;
    return this.runRefresh();
  }

  /** Force a refresh, still single-flight. */
  runRefresh(): Promise<boolean> {
    const existing = this.inFlight;
    if (existing) return existing;

    const promise = (async () => {
      try {
        const ok = await this.options.refresh();
        if (ok) {
          this.generationCounter += 1;
          // Only a REVIVAL is a transition. A refresh of a session that was
          // never lost changes nothing a subscriber needs to react to.
          const revived = this.signedOut;
          this.signedOut = false;
          if (revived) this.announceSignedIn("refreshed");
        } else {
          this.signOut("refresh-failed");
        }
        return ok;
      } catch {
        this.signOut("refresh-failed");
        return false;
      }
    })().finally(() => {
      this.inFlight = null;
    });

    this.inFlight = promise;
    return promise;
  }
}
