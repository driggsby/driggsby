// A faithful port of clap 4.6.0's "did you mean" suggestion logic so typo
// tips match the retired Rust CLI byte-for-byte: strsim 0.11.1's Jaro
// similarity (clap deliberately avoids jaro_winkler — strsim GH #4660), a
// strict > 0.7 threshold, and clap's tie behavior (a later candidate wins a
// similarity tie).

// strsim::jaro over Unicode code points.
export function jaroSimilarity(left: string, right: string): number {
  // Array.from splits on Unicode code points, matching strsim's char iteration.
  const a = Array.from(left);
  const b = Array.from(right);
  if (a.length === 0 && b.length === 0) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const searchRange = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aFlags = new Array<boolean>(a.length).fill(false);
  const bFlags = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const minBound = i > searchRange ? i - searchRange : 0;
    const maxBound = Math.min(b.length, i + searchRange + 1);
    for (let j = minBound; j < maxBound; j += 1) {
      if (a[i] === b[j] && !bFlags[j]) {
        aFlags[i] = true;
        bFlags[j] = true;
        matches += 1;
        break;
      }
    }
  }
  if (matches === 0) {
    return 0;
  }

  let transpositions = 0;
  let j = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aFlags[i]) {
      continue;
    }
    while (!bFlags[j]) {
      j += 1;
    }
    if (a[i] !== b[j]) {
      transpositions += 1;
    }
    j += 1;
  }
  transpositions = Math.floor(transpositions / 2);

  return (
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3
  );
}

// clap's did_you_mean(...).pop(): the single most similar candidate above
// the threshold, or undefined. Ties go to the later candidate.
export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestConfidence = 0;
  for (const candidate of candidates) {
    const confidence = jaroSimilarity(input, candidate);
    if (confidence > 0.7 && confidence >= bestConfidence) {
      best = candidate;
      bestConfidence = confidence;
    }
  }
  return best;
}
