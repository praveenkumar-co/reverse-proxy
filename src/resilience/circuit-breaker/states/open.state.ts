export class OpenState {
  readonly name = 'OPEN' as const;
  isRecoverable(lastFailureTime: number, recoveryTimeMs: number): boolean {
    return Date.now() - lastFailureTime > recoveryTimeMs;
  }
}
