# Kubernetes Deployment — Ninja Reverse Proxy

This directory contains production-ready Kubernetes manifests to deploy Ninja Reverse Proxy on any Kubernetes cluster.

---

## Files

| File | Purpose |
|---|---|
| `configmap.yaml` | Proxy configuration (`config.yaml`) mounted as a Kubernetes ConfigMap |
| `tls-secret.yaml` | TLS certificates (`cert.pem`, `key.pem`) stored as a Kubernetes Secret |
| `proxy-deployment.yaml` | Deployment: runs the proxy container with config and certs mounted as volumes |
| `proxy-service.yaml` | Service: exposes the proxy inside (or outside) the cluster |

---

## Prerequisites

- A running Kubernetes cluster (Minikube, EKS, GKE, AKS, etc.)
- `kubectl` configured and pointing to your cluster
- The proxy Docker image built and pushed to a registry

---

## Step 1 — Build and push the Docker image

```bash
# From the project root
docker build -t your-registry/ninja-reverse-proxy:latest .
docker push your-registry/ninja-reverse-proxy:latest
```

Update the `image:` field in `proxy-deployment.yaml` to match your registry path.

---

## Step 2 — Prepare TLS certificates

Generate a self-signed certificate (development only):

```bash
openssl req -x509 -newkey rsa:4096 \
  -keyout key.pem -out cert.pem \
  -days 365 -nodes
```

Base64-encode the certificates and paste them into `tls-secret.yaml`:

```bash
cat cert.pem | base64 -w 0   # paste as cert.pem value
cat key.pem  | base64 -w 0   # paste as key.pem value
```

---

## Step 3 — Edit the ConfigMap

Open `configmap.yaml` and replace the upstream URLs with your actual Kubernetes Service names:

```yaml
upstreams:
  - id: my-api
    url: http://my-api-svc:8000

  - id: my-frontend
    url: http://my-frontend-svc:3000
```

---

## Step 4 — Apply all manifests

```bash
kubectl apply -f k8s/tls-secret.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/proxy-deployment.yaml
kubectl apply -f k8s/proxy-service.yaml
```

Or apply the entire directory at once:

```bash
kubectl apply -f k8s/
```

---

## Step 5 — Verify the deployment

```bash
# Check pod status
kubectl get pods -l app=ninja-reverse-proxy

# Check service
kubectl get svc ninja-reverse-proxy-svc

# View logs
kubectl logs -l app=ninja-reverse-proxy -f

# Port-forward for local testing
kubectl port-forward svc/ninja-reverse-proxy-svc 8080:8080 8443:8443
```

Then test:

```bash
curl -k https://localhost:8443/__lb-stats
curl -k https://localhost:8443/__registry
```

---

## Expose outside the cluster

Change `type: ClusterIP` to `type: LoadBalancer` in `proxy-service.yaml` to provision a cloud load balancer:

```bash
kubectl apply -f k8s/proxy-service.yaml
kubectl get svc ninja-reverse-proxy-svc   # EXTERNAL-IP appears after provisioning
```

---

## Update config without redeploying

Since the config is mounted from a ConfigMap, you can update it without rebuilding the image:

```bash
kubectl edit configmap ninja-proxy-config
# Save and exit — Kubernetes will propagate the change to the pod volume
```

Then restart the pod to reload the config:

```bash
kubectl rollout restart deployment ninja-reverse-proxy
```
