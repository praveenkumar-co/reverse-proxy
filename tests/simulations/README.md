# tests/simulations/

These files model distributed-systems concepts from *Designing Data-Intensive
Applications* (DDIA) — replication, quorum consistency, fencing tokens, SAGA
rollback, lost-update prevention — using classes defined entirely within the
test files themselves. They do **not** exercise the reverse proxy's `src/`
code and must not be counted in any proxy test total, pass count, or listed
as a proxy feature in the README. Run them with `npm run test:simulations`.
