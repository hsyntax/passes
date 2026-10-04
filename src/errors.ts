import { Data, PlatformError } from "effect";

export class PassesError extends Data.TaggedError("PassesError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function message(error: unknown): string {
  // PlatformError.message omits the native cause (including a child's exit signal).
  if (PlatformError.isPlatformError(error) && error.cause instanceof Error)
    return `${error.message}: ${error.cause.message}`;
  return error instanceof Error ? error.message : String(error);
}
