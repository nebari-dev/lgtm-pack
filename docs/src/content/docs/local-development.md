---
title: Local development
description: Run the full LGTM stack on your laptop with k3d and Tilt.
---

## Prerequisites

- Docker
- [ctlptl](https://github.com/tilt-dev/ctlptl) — creates and deletes the k3d cluster
- [Tilt](https://docs.tilt.dev/install.html) — the dev loop
- [Helm](https://helm.sh) 3+

## Up and down

```bash
make up     # ctlptl apply + tilt up
make down   # tilt down + delete the k3d cluster
```

`make up` is idempotent: `ctlptl apply` creates the cluster only if it does not exist, and
the target detects an already-running Tilt rather than starting a second one.

| URL | What |
|---|---|
| `http://localhost:10350` | Tilt UI — per-resource logs and status |
| `http://localhost:3000` | Grafana (`admin` / `admin`) |

## What the dev stack changes

The Tiltfile installs the same chart with one override:

```python
k8s_yaml(helm('chart', name='lgtm-pack', namespace='default',
              set=['nebariapp.enabled=false']))
```

`nebariapp.enabled=false` because there is no nebari-operator on a bare k3d cluster, so
there is nothing to reconcile a `NebariApp`. Everything else — Grafana, Loki, Tempo,
monolithic Mimir, Promtail, kube-state-metrics, node-exporter — runs exactly as it would in
a cluster install.

Two guardrails worth knowing about:

- `allow_k8s_contexts('k3d-nebari-dev')` means Tilt refuses to deploy anywhere else. If you
  renamed the cluster in `ctlptl-config.yaml`, update this too or Tilt will stop you.
- `update_settings(k8s_upsert_timeout_secs=600)` raises the apply timeout, because the
  first run pulls a large set of upstream images.

The chart is deployed to the `default` namespace locally, not `monitoring`.

## Working on the chart

Tilt watches `chart/` and re-runs `helm template` on every save, so editing a template or a
value re-applies within seconds. Watch the affected resource in the Tilt UI for the rollout.

The Mimir StatefulSet carries a `checksum/config` annotation over its ConfigMap, so config
changes roll the pod automatically.

To render without deploying:

```bash
helm template lgtm-pack chart --set nebariapp.enabled=false | less
```

To check both Mimir modes render:

```bash
bash chart/tests/assert-rendering.sh
```

## Verifying a change end to end

```bash
# Are logs flowing? Promtail should already be shipping container logs.
#   In Grafana: Explore -> Loki -> {namespace="default"}

# Is Mimir accepting writes?
kubectl exec -it sts/lgtm-pack-mimir -- wget -qO- localhost:8080/ready

# Are the dashboards provisioned?
kubectl get cm -l grafana_dashboard=1
```

For traces, send an OTLP payload to `lgtm-pack-tempo:4318` from a pod, or port-forward the
receiver and use [`telemetrygen`](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/cmd/telemetrygen):

```bash
kubectl port-forward svc/lgtm-pack-tempo 4317:4317
telemetrygen traces --otlp-insecure --otlp-endpoint localhost:4317 --traces 5
```

## Testing distributed Mimir locally

It fits on a laptop — the chart's `mimir-distributed` defaults are single replicas with
replication factor 1 — but it is a lot more pods and PVCs than monolithic mode. Add the
flag to the Tiltfile's `set` list, or install by hand:

```bash
helm install lgtm-pack chart -n default \
  --set nebariapp.enabled=false \
  --set mimir-distributed.enabled=true
```

## Docs site

The docs you are reading build from `docs/`:

```bash
make docs              # dev server with hot reload at http://localhost:4321
make docs-build        # static build into docs/dist/
make docs-preview      # serve the production build
make docs-test         # unit tests
make docs-check-links  # build, then verify every internal link resolves
```

Pages live in `docs/src/content/docs/` — each `.md` or `.mdx` file becomes a page, and the
sidebar is configured in `docs/astro.config.mjs`. Merges to `main` publish to
[packs.nebari.dev/lgtm-pack/](https://packs.nebari.dev/lgtm-pack/); pull requests that
touch `docs/` get a preview URL posted as a comment.
