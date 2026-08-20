---
title: Introduction
description: "Cluster observability with the Grafana LGTM stack: Loki logs, Tempo traces, Mimir metrics, and Grafana dashboards."
---

The Nebari LGTM Pack deploys the Grafana **LGTM** observability stack — **L**oki for logs,
**G**rafana for dashboards, **T**empo for traces, and **M**imir for metrics — onto a
Kubernetes cluster as a single Helm release, with optional [Nebari](https://nebari.dev)
integration for routing and Keycloak SSO.

Grafana arrives with its datasources already wired to the three backends, so there is no
"now connect Loki to Grafana" step. Point telemetry at the push endpoints and it shows up.

```
                        ┌──────────────────────────┐
                        │        Grafana UI        │
                        │  Loki · Tempo · Mimir    │
                        │  datasources pre-wired   │
                        └────────────┬─────────────┘
                                     │
            ┌────────────────────────┼────────────────────────┐
            │                        │                        │
        ┌───┴────┐              ┌────┴────┐              ┌────┴────┐
        │  Loki  │              │  Tempo  │              │  Mimir  │
        │  logs  │              │ traces  │              │ metrics │
        └───┬────┘              └────┬────┘              └────┬────┘
            │ :3100                  │ :4317 / :4318          │ :8080
            └────────────────────────┴────────────────────────┘
                             push endpoints
```

## What ships today

- **Grafana** with Loki, Tempo, and Mimir provisioned as datasources by `uid`
  (`loki`, `tempo`, `mimir`), plus four upstream Kubernetes dashboards and a Nebari
  Gateway Traffic dashboard.
- **Loki** in SingleBinary mode with filesystem storage, fed by a **Promtail** DaemonSet
  that scrapes container logs off every node.
- **Tempo** with OTLP receivers on gRPC `:4317` and HTTP `:4318`.
- **Mimir**, monolithic by default (single-binary StatefulSet, one PVC, 30-day retention)
  and horizontally scalable on demand — see [Mimir deployment modes](/mimir-modes/).
- **kube-state-metrics** and **prometheus-node-exporter** for Kubernetes object and node
  metrics, annotated for scrape discovery.
- **OpenTelemetry collector overrides** that redirect a NIC-managed collector's logs,
  traces, and metrics pipelines into this release — no GitOps edits required. See
  [OpenTelemetry wiring](/otel-collector/).
- A **`NebariApp`** resource giving Grafana a hostname, TLS, Keycloak OAuth, and a
  landing-page tile. See [Nebari integration](/nebari-integration/).

## Two extension points

This pack is designed to be built on rather than forked. Both extension points are *soft*
dependencies — a pack that uses them works fine on a cluster where LGTM is not installed.

- **[Ship a dashboard](/dashboards/)** — any pack can render a ConfigMap labeled
  `grafana_dashboard`, in its own namespace, and Grafana live-loads it within ~30s.
- **[Route telemetry](/otel-collector/)** — the collector override ConfigMap is picked up
  by NIC's collector without either side writing to the other's resources.

## In this guide

- **[Getting started](/getting-started/)** — install the chart and reach Grafana
- **[Deploying on Nebari](/deployment/)** — the GitOps path with Argo CD
- **[Nebari integration](/nebari-integration/)** — hostname, Keycloak SSO, and the
  landing-page tile
- **[Local development](/local-development/)** — k3d and Tilt on your laptop

## Guides

- **[Mimir deployment modes](/mimir-modes/)** — monolithic vs. distributed, and why
  filesystem storage is invalid in one of them
- **[OpenTelemetry collector wiring](/otel-collector/)** — how telemetry reaches the
  backends on a NIC cluster
- **[Dashboards](/dashboards/)** — what ships, and how another pack contributes one

## Reference

- **[Configuration](/configuration/)** — the values this chart owns, plus the subchart
  pass-through map
- **[Architecture](/architecture/)** — components, data flow, and storage topology
