import paymentFailed from "./payment-failed.json";
import preCallSequence from "./pre-call-sequence.json";

/**
 * Hand-written definitions that show the format. They are illustrations, not any offer's workflows: an offer's own
 * workflows live in its rows, never in the repository.
 */
export const EXAMPLES: Record<string, unknown> = {
  "payment-failed": paymentFailed,
  "pre-call-sequence": preCallSequence,
};
