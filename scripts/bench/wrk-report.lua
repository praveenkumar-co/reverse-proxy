-- Machine-parseable summary line for scripts/bench-vs-nginx.mjs to scrape from wrk's stdout.
-- wrk's `latency` object tracks a running histogram internally; percentile() returns
-- microseconds, hence the /1000 to report milliseconds.
done = function(summary, latency, requests)
  local errors = summary.errors.connect + summary.errors.read + summary.errors.write + summary.errors.status + summary.errors.timeout
  io.write(string.format(
    "WRK_RESULT rps=%.2f p50_ms=%.3f p99_ms=%.3f p999_ms=%.3f errors=%d requests=%d duration_us=%d " ..
    "err_connect=%d err_read=%d err_write=%d err_status=%d err_timeout=%d\n",
    summary.requests / (summary.duration / 1000000),
    latency:percentile(50) / 1000,
    latency:percentile(99) / 1000,
    latency:percentile(99.9) / 1000,
    errors,
    summary.requests,
    summary.duration,
    summary.errors.connect,
    summary.errors.read,
    summary.errors.write,
    summary.errors.status,
    summary.errors.timeout
  ))
end
