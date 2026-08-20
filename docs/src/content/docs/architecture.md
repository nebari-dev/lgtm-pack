---
title: Architecture
description: Components, data flow, and storage topology of the Nebari LGTM Pack.
---

## The shape of the release

One Helm chart, `nebari-lgtm-pack`, wraps upstream Grafana Labs charts as subcharts and
adds the glue that makes them a coherent stack: datasource provisioning, an OAuth
environment, a Mimir monolithic mode the upstream charts do not offer, and the collector
override that feeds it all.

| Piece | Source |
|---|---|
| Grafana | `grafana` subchart, 10.5.15 |
| Loki | `loki` subchart, 6.53.0 |
| Tempo | `tempo` subchart, 1.24.4 |
| Mimir (distributed) | `mimir-distributed` subchart, 6.0.5 — conditional |
| Mimir (monolithic) | this chart's own `templates/mimir/`, image `grafana/mimir:3.0.1` |
| Promtail | `promtail` subchart, 6.17.1 |
| kube-state-metrics | `kube-state-metrics` subchart, 7.1.0 |
| prometheus-node-exporter | `prometheus-node-exporter` subchart, 4.51.1 |
| Datasources, OAuth env, dashboards, `NebariApp`, OTel override | this chart |

The Mimir image tag is deliberately kept in lockstep with the `mimir-distributed`
subchart's appVersion, so both deployment modes run the same Mimir release.

## Data flow

```
  workloads          Promtail DaemonSet ──────────────► Loki  :3100
      │                     (container logs)
      │
      └── OTLP ──► OTel collector (NIC) ──┬──────────► Loki  :3100/otlp
                        ▲                 ├──────────► Tempo :4317
                        │                 └──────────► Mimir :8080/otlp
          override ConfigMap
          rendered by this chart

  kube-state-metrics  ──┐
  node-exporter       ──┴─► scraped by the collector's prometheus receiver ─► Mimir

                       Grafana ◄── datasource ConfigMap (sidecar) ── Loki/Tempo/Mimir
```

Two independent log paths exist by design. Promtail covers every container on every node
with no application changes; the OTLP path carries structured, trace-correlated logs from
instrumented services. Both land in the same Loki.

## Provisioning, not configuration

Grafana is never configured by hand. Two sidecar-watched ConfigMaps do the work:

- **`<release>-datasources`**, labeled `grafana_datasource: "1"`, defines Loki (uid `loki`,
  set as default), Tempo (uid `tempo`), and — when any Mimir is enabled — Mimir (uid
  `mimir`). Tempo is configured with `tracesToLogsV2` pointing at the Loki uid, so a span
  links straight to its logs, and `nodeGraph` is on.
- **`<release>-dashboards`**, labeled `grafana_dashboard: "1"` and annotated
  `grafana_folder: "Nebari"`, carries every JSON file under the chart's `dashboards/`
  directory.

Because the datasource URLs are templated with `.Release.Name`, and the Mimir host and
port come from helpers that switch on the deployment mode, nothing needs re-pointing when
you rename the release or flip Mimir to distributed.

## Storage topology

| Component | Backend | Default size | Retention |
|---|---|---|---|
| Loki | filesystem, TSDB schema v13 | 10Gi | upstream default |
| Tempo | local, `/var/tempo/traces` | 10Gi | upstream default |
| Mimir monolithic | filesystem under `/data` | 20Gi | 30d (`mimir.retention`) |
| Mimir distributed | object store (bundled MinIO or S3) | per-component 10Gi | 30d (`compactor_blocks_retention_period`) |

Filesystem storage is valid for monolithic Mimir precisely because one process owns the
one volume. It is *not* valid distributed — that distinction is the subject of
[Mimir deployment modes](/mimir-modes/).

## Monolithic Mimir

The chart renders its own StatefulSet because `mimir-distributed` has no single-binary
mode. It runs `grafana/mimir` with `-target=all` and a config assembled by the
`nebari-lgtm-pack.mimir-monolithic-config` helper, deep-merged with anything you put in
`mimir.extraConfig`.

The pod is hardened: `runAsNonRoot` as uid/gid 10001, `readOnlyRootFilesystem: true`, all
capabilities dropped, no privilege escalation, seccomp `RuntimeDefault`. That posture is
why several config paths look unusual — the ruler's `rule_path` and the activity tracker's
`filepath` are both moved onto the data volume, because their defaults are relative paths
under an unwritable working directory and Mimir 3.0.1 hard-fails at startup without the
override.

A `checksum/config` annotation on the pod template rolls the StatefulSet whenever the
rendered config changes.

## Two soft extension points

The pack is built to be extended by *other* packs without either side depending on the
other being installed.

**Dashboards.** Grafana's dashboard sidecar runs with `searchNamespace: ALL`, so a
ConfigMap labeled `grafana_dashboard` in any namespace is discovered and live-loaded. A
contributing pack ships one from its own namespace; if LGTM is absent the ConfigMap just
sits there. See [Dashboards](/dashboards/).

**Telemetry routing.** The collector override lives in a ConfigMap NIC's collector mounts
optionally, rather than as a patch to NIC's own ConfigMap. Nothing breaks when the other
side is missing, and — because the two charts never write to the same Kubernetes resource
— Argo CD is never asked to reconcile conflicting desired states. See
[OpenTelemetry collector wiring](/otel-collector/).

## Authentication

Grafana authenticates against Keycloak using its generic OAuth provider. The chart renders
a `grafana-oauth-config` ConfigMap with every `GF_AUTH_GENERIC_OAUTH_*` variable derived
from `nebariapp.keycloakHostname`, `keycloakRealm`, and `keycloakBasePath`; the client
secret comes from the `<fullname>-oidc-client` Secret that the nebari-operator creates when
it provisions the client. The ConfigMap is mounted `optional: true`, so a release without
Keycloak configured simply falls back to local Grafana accounts.

Role mapping is a single JMESPath expression over the `groups` claim:

```
contains(groups[*], 'admin') && 'Admin' || 'Viewer'
```

Gateway enforcement is deliberately **off** (`auth.enforceAtGateway: false`): Grafana runs
its own OIDC flow, so an Envoy `SecurityPolicy` in front of it would double-authenticate
and break the callback. See [Nebari integration](/nebari-integration/).
