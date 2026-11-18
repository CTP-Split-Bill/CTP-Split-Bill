// The API-facing split: allocate.ts's arithmetic, with its input errors
// reported as the standard 400 (bills/split-allocation.md).
import {
  SplitInputError,
  allocateSplit as allocate,
  toCents as parseCents,
  type MemberAllocation,
  type SplitInput,
} from "./allocate";
import { ApiError } from "./errors";

export { centsToMoney, type MemberAllocation, type SplitInput } from "./allocate";

function asApiError<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof SplitInputError) throw new ApiError("INVALID_INPUT", e.message, 400);
    throw e;
  }
}

export function toCents(value: string): bigint {
  return asApiError(() => parseCents(value));
}

export function allocateSplit(input: SplitInput): MemberAllocation[] {
  return asApiError(() => allocate(input));
}
