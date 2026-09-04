# 🔒 TLS / HTTPS — How It Works

## What Is TLS?

TLS (Transport Layer Security) is a cryptographic protocol that encrypts TCP connections. HTTPS = HTTP over TLS. `wss://` = WebSocket over TLS.

Without TLS: data travels as plain text — anyone on the network can read it.  
With TLS: data is encrypted — only client and server can read it.

---

## How TLS is Set Up in the Proxy

### Step 1 — Load Certificates at Startup

```typescript
// master.ts ~line 336
let sslOptions: { key: Buffer; cert: Buffer } = { key: Buffer.alloc(0), cert: Buffer.alloc(0) };
const tlsExplicitlyEnabled = Boolean(ACTIVE_CONFIG.tls?.enabled);

try {
    const keyPath = ACTIVE_CONFIG.tls?.key || "./key.pem";
    const certPath = ACTIVE_CONFIG.tls?.cert || "./cert.pem";

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        sslOptions = {
            key: readFileSync(keyPath),   // private key
            cert: readFileSync(certPath), // public certificate
        };
    } else if (tlsExplicitlyEnabled) {
        throw new Error(`Certificate files not found`);
    }
} catch (err) {
    if (tlsExplicitlyEnabled) throw err; // hard fail if TLS explicitly required
    // else: silently skip TLS, run HTTP only
}
```

**Key design decision:** TLS is optional. If `tls.enabled: false` and no cert files found → proxy starts in HTTP-only mode without crashing. If `tls.enabled: true` and certs missing → hard crash with clear error message.

---

### Step 2 — Create HTTPS Server

```typescript
// master.ts ~line 760
let httpsServer: https.Server | undefined;
if (sslOptions.key.length > 0) {
    httpsServer = https.createServer(sslOptions, requestHandler);
}
```

`https.createServer()` is Node.js built-in. It wraps every incoming TCP connection in a TLS handshake before passing it to the request handler.

---

### Step 3 — HTTP → HTTPS Redirect

```typescript
// httpServer handles port 8080
httpServer.on("request", (req, res) => {
    // Redirect all plain HTTP to HTTPS
    res.writeHead(301, { Location: `https://localhost:8443${req.url}` });
    res.end();
});
```

Anyone going to `http://localhost:8080` gets redirected to `https://localhost:8443`.

---

## What is cert.pem and key.pem?

| File | What it is | Who sees it |
|------|-----------|-------------|
| `cert.pem` | Public certificate — contains your public key + identity info | Sent to every browser that connects |
| `key.pem` | Private key — used to decrypt data encrypted with public key | NEVER leaves your server |

For local development, these are **self-signed** — created by you, not a Certificate Authority (CA). That's why Chrome shows "Not Secure" warning — it can't verify the identity. Click "Advanced → Proceed" to bypass.

In production: use Let's Encrypt or a real CA to get a trusted certificate.

---

## TLS Handshake — What Happens When Browser Connects

```
Browser                         Proxy (HTTPS Server)
   |                                     |
   |──── ClientHello (TLS version, ciphers supported) ──────►|
   |                                     |
   |◄─── ServerHello (chosen cipher) ────────────────────────|
   |◄─── Certificate (cert.pem) ─────────────────────────────|
   |                                     |
   | (Browser verifies cert — self-signed → warning shown)    |
   |                                     |
   |──── ClientKeyExchange (session key encrypted) ──────────►|
   |                                     |
   |◄─── Finished (encryption starts) ───────────────────────|
   |                                     |
   |  All further data is encrypted AES   |
```

After this handshake, the socket is a `TLSSocket` — all bytes are automatically encrypted/decrypted by Node.js `tls` module before your code sees them.

---

## proxy.yaml TLS Config

```yaml
tls:
  enabled: true          # must be true to activate HTTPS server
  cert: "./cert.pem"     # path relative to where you RUN the proxy
  key: "./key.pem"       # same
  redirectHttp: true     # auto-redirect port 8080 → 8443
  httpsPort: 8443        # HTTPS listens on this port
```

---
