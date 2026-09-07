# 🗂️ Service Registry — How It Works

## What Is a Service Registry?

A service registry is a database of all available backend services (upstreams). The proxy consults it to know WHERE to forward requests. Without it, the proxy would have hardcoded backend addresses.

---

## Two Registration Modes

### 1. Static Registration (proxy.yaml)
Upstreams defined at startup in config — never change while proxy is running:
```yaml
upstreams:
  - id: chess-backend
    url: "http://127.0.0.1:3009"
    healthPath: "/"
    weight: 1
```
Proxy reads this at boot, registers each upstream into the registry.

### 2. Dynamic Self-Registration (REST API)
Upstreams register themselves at runtime — no proxy restart needed:
```bash
# Service registers itself
POST /__registry/register
{ "id": "chess-backend", "url": "http://127.0.0.1:3009" }

# Service sends heartbeat (proves it's alive)
POST /__registry/heartbeat
{ "id": "chess-backend" }

# Service deregisters on shutdown
POST /__registry/deregister
{ "id": "chess-backend" }
```

---

## Disk Snapshot — Surviving Restarts

Registry is saved to `registry.json` on disk periodically. On proxy restart, it rehydrates from this snapshot — so registered services survive proxy restarts without needing to re-register:

```typescript
// On startup
const snapshot = readFileSync('./registry.json', 'utf8');
const services = JSON.parse(snapshot);
services.forEach(s => registry.register(s));
logger.info('Registry', `Rehydrated ${services.length} services from disk snapshot`);

// After every change
writeFileSync('./registry.json', JSON.stringify(registry.getAll()));
```

You saw this in logs:
```
[Registry] Rehydrated 1 services from disk snapshot
[Registry] Service REGISTERED: chess-backend → http://127.0.0.1:3009
```

---

## Registry + Load Balancer Sync

When a service registers/deregisters, load balancer is immediately updated:

```typescript
registry.on('registered', (service) => {
    lb.addUpstream(service);
    broadcastUpstreams(); // notify all workers via IPC
});

registry.on('deregistered', (service) => {
    lb.removeUpstream(service.id);
    broadcastUpstreams();
});
```

Workers receive the updated upstream list via IPC and update their local load balancer state.

---