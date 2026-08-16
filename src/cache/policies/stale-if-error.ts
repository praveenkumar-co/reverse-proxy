export class StaleIfError {
  shouldServeStale(errorStatus: number, staleIfErrorSeconds: number, ageSeconds: number): boolean {
    const isError = errorStatus >= 500 || errorStatus === 0;
    return isError && ageSeconds <= staleIfErrorSeconds;
  }
}
