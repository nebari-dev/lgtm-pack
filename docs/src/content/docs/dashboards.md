---
title: Dashboards
description: The dashboards this pack provisions, and how another Nebari pack contributes its own.
---

## What ships

Grafana comes up with two folders already populated.

| Folder | Dashboard | Source |
|---|---|---|
| Kubernetes | Kubernetes / Views / Global | grafana.com ID 15757 |
| Kubernetes | Kubernetes / Views / Namespaces | grafana.com ID 15758 |
| Kubernetes | Kubernetes / Views / Nodes | grafana.com ID 15759 |
| Kubernetes | Kubernetes / Views / Pods | grafana.com ID 15760 |
| Nebari | Nebari Gateway Traffic | `chart/dashboards/nebari-gateway-traffic.json` |

The Kubernetes views are downloaded by the grafana subchart at render time and pinned to
specific revisions, with `DS_PROMETHEUS` bound to the Mimir datasource. They depend on
kube-state-metrics and prometheus-node-exporter, both of which this chart deploys.

*Nebari Gateway Traffic* charts the Envoy Gateway data plane: request rate by response
code, active connections, total requests, request duration, bytes in/out, and certificate
expiry in days remaining.

## Provisioned datasources

Dashboards reference datasources by `uid`, not by name:

| uid | Type | Signal |
|---|---|---|
| `loki` | loki | Logs — Grafana's default datasource |
| `tempo` | tempo | Traces, with `tracesToLogsV2` linking to `loki` |
| `mimir` | prometheus | Metrics — present only when a Mimir mode is enabled |

A panel pointing at a uid that does not exist renders empty rather than erroring, so a
dashboard that assumes `mimir` will silently show nothing on an install with both Mimir
modes disabled.

## Contributing a dashboard from another pack

Any Nebari software pack can ship a Grafana dashboard that is auto-provisioned alongside
this pack's. No edits to this chart, and no hard dependency in either direction.

Grafana's dashboard sidecar runs with `grafana.sidecar.dashboards.searchNamespace: ALL`. It
watches **every** namespace for ConfigMaps (or Secrets) labeled `grafana_dashboard` and
live-loads the JSON they contain within about 30 seconds — no Grafana restart. The grafana
subchart grants the sidecar cluster-wide ConfigMap list/watch via a ClusterRole when
`searchNamespace` is `ALL`.

### The contract

Render a ConfigMap in **your own** namespace:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-pack-dashboards
  namespace: my-pack            # your pack's namespace, not monitoring
  labels:
    grafana_dashboard: "1"      # discovery key the sidecar matches on
  annotations:
    grafana_folder: "My Pack"   # optional: groups the dashboard into a folder
data:
  my-dashboard.json: |          # key must end in .json
    { ...grafana dashboard model... }
```

In a Helm chart, glob a `dashboards/` directory so adding a dashboard is just dropping in
a file — the same pattern this chart uses:

```yaml
# templates/grafana-dashboard.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "my-pack.fullname" . }}-dashboards
  namespace: {{ .Release.Namespace }}
  labels:
    grafana_dashboard: "1"
  annotations:
    grafana_folder: "My Pack"
data:
{{- range $path, $bytes := .Files.Glob "dashboards/*.json" }}
  {{ base $path }}: |-
{{ $.Files.Get $path | indent 4 }}
{{- end }}
```

### Point panels at the existing datasources

The sidecar loads dashboards; it does not create datasources. Reference the ones this pack
already provisions, by uid:

```json
"datasource": { "type": "prometheus", "uid": "mimir" }
```

### Folders

Landing in a named folder requires two things the chart already sets:
`sidecar.dashboards.folderAnnotation: grafana_folder` and
`sidecar.dashboards.provider.foldersFromFilesStructure: true`. Without both, the sidecar
ignores the annotation and every dashboard falls into General.

### It is a soft dependency

If this pack — and therefore Grafana — is not installed, the contributing pack's ConfigMap
simply sits unused. No error, no coupling. Exactly like the
[OTel override ConfigMap](/otel-collector/) when no collector is present.

## Restricting discovery

To stop watching other namespaces, point the sidecar at the release namespace (or a
comma-separated list):

```yaml
grafana:
  sidecar:
    dashboards:
      searchNamespace: monitoring
```

Only this pack's own dashboards are then provisioned.

## Adding a dashboard to this pack

Drop a `.json` file into `chart/dashboards/`. The `grafana-dashboards.yaml` template globs
the directory, so no template edit is needed. Export from Grafana with **Share → Export →
Export for sharing externally** unchecked, then replace any `${DS_*}` placeholders with the
literal uids above so the panel binds without a datasource prompt.
