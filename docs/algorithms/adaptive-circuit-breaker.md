# Google SRE Adaptive Throttling

Formula: `dropProbability = max(0, (requests - K * accepts) / (requests + 1))`

Where K=2 provides a good balance between precision and safety.
