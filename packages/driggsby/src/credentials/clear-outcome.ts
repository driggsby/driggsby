// The honest result of removing a stored credential: "cleared" (it existed
// and is gone), "absent" (there was nothing to remove), "failed" (it may
// still be there). Removal is a revocation path — reporting "failed" as
// "absent" would tell someone a token is gone while it keeps working, so the
// three outcomes are never collapsed.
export type ClearOutcome = "cleared" | "absent" | "failed";
