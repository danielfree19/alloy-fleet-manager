# Deployment

## Docker

```bash
docker build -t alloy-fleet-manager:latest -f apps/fleet-manager/Dockerfile .
docker run -d --name fleet-manager \
  --env-file .env \
  -p 9090:9090 \
  alloy-fleet-manager:latest
```

The container runs migrations on startup (`node-pg-migrate up`) and then
starts the server.

## docker-compose

The repo `docker-compose.yml` brings up Postgres + the Fleet Manager +
(optionally) a real Alloy bound to the bootstrap config:

```bash
docker compose up -d                       # postgres + fleet-manager
docker compose --profile with-alloy up -d  # adds an Alloy DaemonSet-style container
```

## Kubernetes

`examples/k8s/alloy-daemonset.yaml` shows the **agent-side** manifest: a
DaemonSet that runs `grafana/alloy:latest` with a mounted bootstrap
ConfigMap that contains the `remotecfg` block. The Fleet Manager itself is
deployed with whatever standard Node.js app pattern you already use
(Deployment + Service + Secret for the tokens).

Sketch of a `fleet-manager` Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: fleet-manager, namespace: observability }
spec:
  replicas: 1
  selector: { matchLabels: { app: fleet-manager } }
  template:
    metadata: { labels: { app: fleet-manager } }
    spec:
      containers:
        - name: manager
          image: your-registry/alloy-fleet-manager:latest
          ports: [{ containerPort: 9090 }]
          envFrom:
            - secretRef: { name: fleet-manager-env }
---
apiVersion: v1
kind: Service
metadata: { name: fleet-manager, namespace: observability }
spec:
  selector: { app: fleet-manager }
  ports: [{ port: 9090, targetPort: 9090 }]
```

The secret `fleet-manager-env` must provide `DATABASE_URL`, `ADMIN_TOKEN`,
`REGISTRATION_TOKEN`, `AGENT_BEARER_TOKEN`. For the Alloy DaemonSet, the
DaemonSet's `alloy-fleet-bearer` Secret must match the manager's
`AGENT_BEARER_TOKEN`.

## systemd (legacy agent only)

If you're running the **legacy** `apps/fleet-agent` on bare metal instead of
using `remotecfg`, see
[`apps/fleet-agent/systemd/alloy-fleet-agent.service`](../apps/fleet-agent/systemd/alloy-fleet-agent.service).
For the primary path you just run Alloy's own systemd unit with the
bootstrap file at `/etc/alloy/config.alloy`.

## Env vars

| Var                    | Scope          | Purpose                                                          |
|------------------------|----------------|------------------------------------------------------------------|
| `DATABASE_URL`         | manager        | Postgres connection string                                       |
| `FLEET_MANAGER_HOST`   | manager        | default `0.0.0.0`                                                |
| `FLEET_MANAGER_PORT`   | manager        | default `9090`                                                   |
| `ADMIN_TOKEN`          | manager        | Bearer for primary admin REST + legacy admin REST                |
| `REGISTRATION_TOKEN`   | manager        | Bearer for legacy `POST /legacy/collectors/register`             |
| `AGENT_BEARER_TOKEN`   | manager + Alloy| Shared bearer for `remotecfg` calls                              |
| `LOG_LEVEL`            | manager        | `info` / `debug`                                                 |

Plus for the legacy agent (`apps/fleet-agent`):

| Var                    | Purpose                                                              |
|------------------------|----------------------------------------------------------------------|
| `FLEET_MANAGER_URL`    | e.g. `http://fleet-manager:9090`                                     |
| `FLEET_REGISTRATION_TOKEN` | must match server's `REGISTRATION_TOKEN`                         |
| `AGENT_HOSTNAME`       | defaults to `os.hostname()`                                          |
| `AGENT_LABELS`         | JSON, e.g. `{"role":"edge"}`                                         |
| `AGENT_STATE_FILE`     | where to persist per-collector api_key and last-applied version     |
| `ALLOY_CONFIG_PATH`    | target config file (default `/etc/alloy/config.alloy`)               |
| `ALLOY_RELOAD_URL`     | e.g. `http://localhost:12345/-/reload`                               |
| `AGENT_POLL_INTERVAL_SECONDS` | default `30`                                                  |

## Security posture

- All endpoints require a bearer. Unauthenticated requests get 401 with a
  Connect-shape error body (JSON) even for the binary-proto endpoints.
- Run behind TLS termination (nginx, a Kubernetes ingress, or a cloud LB)
  in production. Bearer tokens in cleartext over HTTP are not acceptable
  outside localhost/dev.
- Per-collector bearer tokens are **future work** for the primary path. The
  legacy path already has them (`collectors.api_key_hash`).
