---
title: Configuration
description: Values reference for the Nebari LGTM Pack Helm chart.
---

The chart wraps upstream Grafana Labs charts, so most of its surface is pass-through. This
page covers the values this chart *owns*; anything under a subchart key belongs to that
subchart's own documentation.

## Subchart pass-through

| Key | Chart | Version | Upstream values |
|---|---|---|---|
| `grafana.*` | grafana | 10.5.15 | [values](https://github.com/grafana/helm-charts/tree/main/charts/grafana) |
| `loki.*` | loki | 6.53.0 | [values](https://github.com/grafana/helm-charts/tree/main/charts/loki) |
| `tempo.*` | tempo | 1.24.4 | [values](https://github.com/grafana/helm-charts/tree/main/charts/tempo) |
| `mimir-distributed.*` | mimir-distributed | 6.0.5 | [values](https://github.com/grafana/helm-charts/tree/main/charts/mimir-distributed) |
| `promtail.*` | promtail | 6.17.1 | [values](https://github.com/grafana/helm-charts/tree/main/charts/promtail) |
| `kube-state-metrics.*` | kube-state-metrics | 7.1.0 | [values](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-state-metrics) |
| `prometheus-node-exporter.*` | prometheus-node-exporter | 4.51.1 | [values](https://github.com/prometheus-community/helm-charts/tree/main/charts/prometheus-node-exporter) |
| `mimir.*` | *this chart* | — | monolithic mode, below |

## `mimir` — monolithic Mimir

Rendered by this chart, not a subchart. Ignored entirely when
`mimir-distributed.enabled` is true.

| Value | Default | Purpose |
|---|---|---|
| `mimir.enabled` | `true` | Render the single-binary StatefulSet. |
| `mimir.image.repository` | `grafana/mimir` | Image. |
| `mimir.image.tag` | `3.0.1` | Kept in lockstep with the `mimir-distributed` appVersion so both modes run the same release. |
| `mimir.retention` | `30d` | Compactor block retention. Unset would mean keep-forever and unbounded disk growth. |
| `mimir.persistence.size` | `20Gi` | The single data PVC. |
| `mimir.resources` | `{}` | Container resources. |
| `mimir.extraConfig` | `{}` | Deep-merged over the rendered Mimir config. |

See [Mimir deployment modes](/mimir-modes/) for the trade-offs.

## `nebariapp` — Nebari integration

| Value | Default | Purpose |
|---|---|---|
| `nebariapp.enabled` | `true` | Render the `NebariApp`. Set false outside Nebari. |
| `nebariapp.hostname` | — | **Required when enabled.** Grafana's external hostname. |
| `nebariapp.keycloakHostname` | — | Required when auth is enabled. |
| `nebariapp.keycloakBasePath` | `""` | `/auth` for legacy Keycloak (< v17). |
| `nebariapp.keycloakRealm` | `nebari` | Realm name. |
| `nebariapp.service.name` | `<release>-grafana` | Backend service. |
| `nebariapp.service.port` | `80` | Backend port. |
| `nebariapp.routing.routes` | `[{pathPrefix: /}]` | Route table. |
| `nebariapp.auth.*` | see below | Keycloak client and Grafana OAuth. |
| `nebariapp.landingPage.*` | disabled | Nebari landing-page tile. |
| `nebariapp.additionalServices` | unset | Expose Loki/Tempo/Mimir push endpoints through the same host. |

Auth defaults: `enabled: true`, `provider: keycloak`, `provisionClient: true`,
`enforceAtGateway: false`, `redirectURI: /login/generic_oauth`, scopes
`openid profile email groups`, groups `admin` and `viewer`.

Full detail, including why gateway enforcement is off and how group membership maps to
Grafana roles, is in [Nebari integration](/nebari-integration/).

## `otelCollectorOverrides` — telemetry routing

| Value | Default | Purpose |
|---|---|---|
| `otelCollectorOverrides.enabled` | `true` | Render the override ConfigMap and rollout hook. |
| `otelCollectorOverrides.namespace` | `monitoring` | Where NIC's collector DaemonSet lives. |
| `otelCollectorOverrides.daemonSetName` | `opentelemetry-collector-agent` | DaemonSet rolled post-install/upgrade. |
| `otelCollectorOverrides.rolloutImage` | `alpine/k8s:1.30.4` | Needs `kubectl`. Community image — override if you require a vetted registry. |
| `otelCollectorOverrides.imagePullPolicy` | `IfNotPresent` | Pull policy for the rollout Job. |

See [OpenTelemetry collector wiring](/otel-collector/).

## Values this chart sets on subcharts

These are chart defaults you may want to know about before overriding them.

### Grafana

| Value | Default here | Why |
|---|---|---|
| `grafana.adminUser` / `adminPassword` | `admin` / `admin` | Development convenience. **Override for any shared cluster.** |
| `grafana.sidecar.datasources.enabled` | `true` | Picks up the chart's datasource ConfigMap. |
| `grafana.sidecar.dashboards.searchNamespace` | `ALL` | Lets other packs contribute dashboards from their own namespaces. |
| `grafana.sidecar.dashboards.folderAnnotation` | `grafana_folder` | Honors the folder annotation; required with `foldersFromFilesStructure`. |
| `grafana.sidecar.dashboards.provider.foldersFromFilesStructure` | `true` | Without it every dashboard lands in General. |
| `grafana.service.type` | `ClusterIP` | Routing is the `NebariApp`'s job. |
| `grafana.envFromConfigMaps` | `grafana-oauth-config` (optional) | Injects the OAuth environment when Keycloak is configured. |

### Loki

SingleBinary mode, one replica, `auth_enabled: false`, replication factor 1, TSDB schema
v13 on filesystem storage, 10Gi PVC. The read, write, backend, gateway, chunks-cache, and
results-cache components are all disabled — they belong to the scalable deployment modes.

### Tempo

Local trace storage at `/var/tempo/traces` with a WAL at `/var/tempo/wal`, 10Gi PVC, OTLP
receivers on `0.0.0.0:4317` (gRPC) and `0.0.0.0:4318` (HTTP).

### Promtail

Client URL templated to `http://{{ .Release.Name }}-loki:3100/loki/api/v1/push`. The
default scrape config handles the CRI log format and enriches with pod, namespace, and
container labels.

### kube-state-metrics and prometheus-node-exporter

Both carry `prometheus.io/scrape: "true"` pod annotations (ports 8080 and 9100
respectively) so the OTel collector's `role: pod` discovery finds them. The Kubernetes
Views dashboards depend on both.

## Common overrides

```yaml
# Production-ish install
grafana:
  adminPassword: <from a secret, not here>
  persistence:
    enabled: true
    size: 10Gi

loki:
  singleBinary:
    persistence:
      size: 100Gi

tempo:
  persistence:
    size: 50Gi

mimir:
  retention: 90d
  persistence:
    size: 200Gi
  resources:
    requests: { cpu: 500m, memory: 2Gi }

nebariapp:
  hostname: grafana.example.com
  keycloakHostname: keycloak.example.com
  landingPage:
    enabled: true
```

:::caution[Do not put secrets in values]
`grafana.adminPassword` and any object-store credentials should come from a Kubernetes
Secret, not from a values file committed to a GitOps repository. For Mimir's object store,
inject credentials with `global.extraEnvFrom` — see
[Mimir deployment modes](/mimir-modes/#using-a-cloud-bucket).
:::

## Inspecting the rendered output

```bash
helm template lgtm-pack chart --set nebariapp.enabled=false | less
helm get values lgtm-pack -n monitoring          # what you overrode
helm get values lgtm-pack -n monitoring --all    # everything, defaults included
```
