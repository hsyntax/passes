export class PassesError extends Error {
  override readonly name = "PassesError";
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
