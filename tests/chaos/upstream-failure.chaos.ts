export async function runChaosTest(upstreamUrl: string, durationMs: number): Promise<void> {
  console.log(`Running chaos test against ${upstreamUrl} for ${durationMs}ms`);
}
