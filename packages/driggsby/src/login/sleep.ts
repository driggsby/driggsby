// A sleep that ends early, quietly, once its signal aborts, so a finished
// wait never holds the process open. Its abort listener goes when the
// timer fires too: a wait that sleeps every few seconds on one signal
// must not pile listeners onto it (Node warns past ten).
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
