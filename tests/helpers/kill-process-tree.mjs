// Shared process-teardown helper for every test harness that spawns the real proxy binary.
//
// Root cause this exists to fix (found in Phase G): master.ts's own graceful-shutdown-on-
// SIGTERM handler waits Math.max(10000, readTimeoutMs + 2000)ms for its workers to drain
// in-flight requests and exit on their own, THEN calls process.exit(0) itself (see
// src/core/cluster/master.ts's gracefulShutdown()). Every test harness's own cleanup gave the
// spawned proxy only ~3 seconds before giving up and SIGKILLing *just the master PID* --
// nowhere near long enough for that drain to finish. SIGKILLing the master mid-drain kills it
// instantly but never reaches the worker (a separate process, forked by the master, with no
// logic of its own to notice its master died) -- confirmed directly: the worker survives as
// an orphan (PPID 1) every time, holding its port, breaking every subsequent run.
//
// killProcessTree() fixes both sides: it waits long enough for the documented graceful drain
// to actually finish, and -- as a safety net for a genuine hang -- explicitly enumerates and
// kills the process's own children (via `pgrep -P`) before force-killing the process itself,
// so an orphaned worker can never survive a cleanup call that falls through to SIGKILL.
import { execSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Matches master.ts's own floor (Math.max(10000, readTimeoutMs + 2000)) with headroom --
// every test config in this repo uses a readTimeoutMs well under 13s, so 15s covers the
// documented worst case for all of them with margin, without making a normal, fast shutdown
// (which resolves via the "exit" event long before this fires) any slower.
export const GRACEFUL_SHUTDOWN_GRACE_MS = 15000;

function getChildPids(pid) {
  try {
    return execSync(`pgrep -P ${pid}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function killPidTree(pid, signal) {
  for (const childPid of getChildPids(pid)) {
    killPidTree(childPid, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {}
}

/**
 * Stops a spawned child_process (expected to be the proxy's cluster master, but works for
 * any tree) gracefully, then forcefully. Resolves once the process has exited one way or
 * another; never rejects.
 *
 * @param proc a Node ChildProcess (from spawn()) -- uses proc.pid and proc.once("exit", ...)
 * @param opts.graceMs how long to wait for a graceful exit after the initial signal before
 *   escalating to a tree-wide SIGKILL (default: GRACEFUL_SHUTDOWN_GRACE_MS)
 * @param opts.signal the initial signal to send (default: SIGTERM)
 */
export async function killProcessTree(proc, opts = {}) {
  if (!proc || proc.pid == null) return;
  if (proc.exitCode !== null || proc.killed) return;
  const graceMs = opts.graceMs ?? GRACEFUL_SHUTDOWN_GRACE_MS;
  const signal = opts.signal ?? "SIGTERM";
  const pid = proc.pid;

  try {
    proc.kill(signal);
  } catch {
    return;
  }

  const exited = await Promise.race([
    new Promise((resolve) => proc.once("exit", () => resolve(true))),
    sleep(graceMs).then(() => false),
  ]);
  if (exited) return;

  // Didn't exit gracefully within budget -- safety net: find and kill every descendant
  // (children first, so a parent dying mid-fork doesn't orphan a grandchild either) before
  // the top-level process itself, then confirm.
  killPidTree(pid, "SIGKILL");
  await Promise.race([
    new Promise((resolve) => proc.once("exit", () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
}
