/**
 * The hook module registered by `test-resolver.mjs`. See that file for why
 * this exists; this one is only the mechanism.
 *
 * Runs on the loader thread, so it must stay dependency-free.
 */

/** Specifiers that already name a module format are left completely alone. */
const HAS_EXTENSION = /\.(?:[cm]?[jt]sx?|json|node|wasm)$/;

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const recoverable =
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !HAS_EXTENSION.test(specifier);

    if (!recoverable) throw error;

    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // The `.ts` guess is an ADDITION, never a replacement: if it does not
      // exist either, the caller must see the failure they actually caused.
      throw error;
    }
  }
}
