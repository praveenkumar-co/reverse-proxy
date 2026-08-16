# Full Jitter Exponential Backoff

Formula: `sleep = random(0, min(maxDelay, baseDelay * 2^attempt))`

This avoids thundering herd by randomizing retry delays.
