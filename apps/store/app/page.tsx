import { redirect } from "next/navigation";

/**
 * The store app has exactly one entry point that matters: the till. Everything
 * else (sign-in, the receipt) is reached from there, so `/` is a redirect
 * rather than a landing page a cashier would have to click through.
 *
 * The redirect target is a static literal, which `typedRoutes` verifies against
 * the real route tree at build time.
 */
export default function Home() {
  redirect("/pos");
}
