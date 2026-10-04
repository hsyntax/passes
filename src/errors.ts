import { PlatformError } from "effect";

export class PassesError extends Error {
  override readonly name = "PassesError";
}

export function message(error: unknown): string {
  // PlatformError.message omits the native cause (including a child's exit signal).
  if (PlatformError.isPlatformError(error) && error.cause instanceof Error)
    return `${error.message}: ${error.cause.message}`;
  return error instanceof Error ? error.message : String(error);
}
