export type ShutdownHook = () => void | Promise<void>;

const hooks = new Set<ShutdownHook>();
let installed = false;
let shuttingDown = false;

/**
 * Registers a cleanup callback to run on SIGINT/SIGTERM. Returns an
 * unregister function — callers must call it once their resource is torn
 * down through normal control flow, so the registry doesn't accumulate
 * stale hooks over a long run.
 */
export function registerShutdownHook(hook: ShutdownHook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

/** Idempotent. Call once, early, from the CLI entrypoint. */
export function installSignalHandlers(options: { timeoutMs?: number } = {}): void {
  if (installed) return;
  installed = true;
  const timeoutMs = options.timeoutMs ?? 5000;

  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      process.stderr.write(`\nagent-skills-eval: received second ${signal}, forcing exit\n`);
      process.exit(1);
      return;
    }
    shuttingDown = true;
    const n = hooks.size;
    process.stderr.write(`\nagent-skills-eval: received ${signal}, cleaning up ${n} active subprocess(es)...\n`);
    void runShutdown(signal, timeoutMs);
  };
  process.on("SIGINT", handle);
  process.on("SIGTERM", handle);
}

async function runShutdown(signal: NodeJS.Signals, timeoutMs: number): Promise<void> {
  const settle = Promise.allSettled([...hooks].map((hook) => hook()));
  await Promise.race([settle, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  process.exit(signal === "SIGINT" ? 130 : 143);
}
