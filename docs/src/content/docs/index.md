---
title: Introduction
description: Documentation for the Nebari LGTM Pack - the Grafana LGTM observability stack (Loki, Grafana, Tempo, Mimir) on a Nebari cluster.
---

The Nebari LGTM Pack deploys the Grafana **LGTM** observability stack — **L**oki
for logs, **G**rafana for dashboards, **T**empo for traces, and **M**imir for
metrics — on a Kubernetes cluster, with optional [Nebari](https://nebari.dev)
platform integration for routing and Keycloak SSO.

:::note[Documentation in progress]
This site is the scaffolding for the pack's documentation. Content is being
written; until it lands here, the
[repository README](https://github.com/nebari-dev/lgtm-pack#readme)
is the reference for installing and configuring the pack.
:::

## Components

| Component | Purpose |
| --------- | ------- |
| Grafana   | Dashboards and visualization |
| Loki      | Log aggregation |
| Tempo     | Distributed tracing |
| Mimir     | Prometheus-compatible metrics |

## Contributing to these docs

Pages live in `docs/src/content/docs/`. See the
[docs README](https://github.com/nebari-dev/lgtm-pack/blob/main/docs/README.md)
for how to run the site locally and add a page.
