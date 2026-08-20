---
title: Getting started
description: Install the Nebari LGTM Pack on a Kubernetes cluster and reach Grafana.
---

## Prerequisites

- A Kubernetes cluster. For a laptop, [k3d](https://k3d.io) is enough — see
  [Local development](/local-development/).
- [Helm](https://helm.sh) 3+.
- A default StorageClass. Loki, Tempo, and Mimir each claim a PVC.
- For Nebari integration only: the
  [nebari-operator](https://github.com/nebari-dev/nebari-operator) (it provides the
  `NebariApp` CRD) and a Keycloak realm.

## Install

Add the Nebari Helm repository and install:

```bash
helm repo add nebari https://raw.githubusercontent.com/nebari-dev/helm-repository/gh-pages/
helm repo update nebari

helm install lgtm-pack nebari/nebari-lgtm-pack \
  --namespace monitoring --create-namespace \
  --set nebariapp.enabled=false
```

Or from a clone of this repository:

```bash
helm dependency update chart
helm install lgtm-pack chart --namespace monitoring --create-namespace \
  --set nebariapp.enabled=false
```

`nebariapp.enabled=false` skips the `NebariApp` resource. Leave it on (the default) only
when the nebari-operator is installed and you can supply `nebariapp.hostname` — the chart
fails to render without it. See [Nebari integration](/nebari-integration/).

## What gets deployed

| Workload | Kind | Purpose |
|---|---|---|
| `lgtm-pack-grafana` | Deployment | UI on service port `80` (container `3000`) |
| `lgtm-pack-loki` | StatefulSet | Logs, SingleBinary mode, 10Gi PVC |
| `lgtm-pack-tempo` | StatefulSet | Traces, 10Gi PVC |
| `lgtm-pack-mimir` | StatefulSet | Metrics, `-target=all`, 20Gi PVC |
| `lgtm-pack-promtail` | DaemonSet | Ships container logs to Loki |
| `lgtm-pack-kube-state-metrics` | Deployment | Kubernetes object metrics |
| `lgtm-pack-prometheus-node-exporter` | DaemonSet | Node CPU, memory, disk, network |

Resource names follow the Helm release name, so a release named `obs` produces
`obs-grafana`, `obs-loki`, and so on. Every endpoint this chart templates uses
`.Release.Name`, so custom release names work throughout.

## Reach Grafana

Without Nebari routing, port-forward:

```bash
kubectl -n monitoring port-forward svc/lgtm-pack-grafana 3000:80
```

Open `http://localhost:3000` and sign in with `admin` / `admin`.

:::caution[Change the default credentials]
`grafana.adminUser` and `grafana.adminPassword` default to `admin`/`admin` for local
development. Override both for any shared cluster, or turn on Keycloak OAuth so Grafana
logins go through the realm — see [Nebari integration](/nebari-integration/).
:::

## Verify

```bash
# Everything should be Running / Ready
kubectl -n monitoring get pods

# The three datasources Grafana provisions from the sidecar ConfigMap
kubectl -n monitoring get cm lgtm-pack-datasources -o yaml

# Mimir reports ready once its single process has started every target
kubectl -n monitoring exec sts/lgtm-pack-mimir -- wget -qO- localhost:8080/ready
```

In Grafana, **Connections → Data sources** should list Loki (default), Tempo, and Mimir,
and **Dashboards** should show a `Kubernetes` folder with four views plus a `Nebari` folder
containing *Nebari Gateway Traffic*.

## Send it some telemetry

Container logs arrive on their own — Promtail is already scraping every node. Metrics and
traces need a producer. The push endpoints are:

| Signal | Endpoint | Protocol |
|---|---|---|
| Logs | `http://lgtm-pack-loki:3100/loki/api/v1/push` | Loki push API |
| Logs (OTLP) | `http://lgtm-pack-loki:3100/otlp` | OTLP/HTTP |
| Traces | `http://lgtm-pack-tempo:4317` | OTLP/gRPC |
| Traces | `http://lgtm-pack-tempo:4318` | OTLP/HTTP |
| Metrics | `http://lgtm-pack-mimir:8080/api/v1/push` | Prometheus remote-write |
| Metrics (OTLP) | `http://lgtm-pack-mimir:8080/otlp` | OTLP/HTTP |

On a cluster deployed by
[nebari-infrastructure-core](https://github.com/nebari-dev/nebari-infrastructure-core),
the existing OpenTelemetry collector is redirected to these endpoints automatically — see
[OpenTelemetry collector wiring](/otel-collector/).

In distributed Mimir mode the metrics endpoint becomes
`http://lgtm-pack-mimir-gateway:80`; the Grafana datasource and OTel exporter follow the
mode on their own. See [Mimir deployment modes](/mimir-modes/).

## Uninstall

```bash
helm uninstall lgtm-pack -n monitoring
```

PVCs created by StatefulSet volume claim templates survive the uninstall — delete them
explicitly if you want the data gone:

```bash
kubectl -n monitoring delete pvc -l app.kubernetes.io/instance=lgtm-pack
```

If the OTel collector override was in use, note that NIC's collector keeps the
previously-resolved config until its pods restart. See
[Uninstall behavior](/otel-collector/#uninstall-behavior).
