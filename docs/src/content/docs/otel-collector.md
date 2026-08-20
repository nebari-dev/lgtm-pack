---
title: OpenTelemetry collector wiring
description: How the pack redirects a NIC-managed OTel collector into Loki, Tempo, and Mimir.
---

On a cluster deployed by
[nebari-infrastructure-core](https://github.com/nebari-dev/nebari-infrastructure-core)
(NIC), an OpenTelemetry collector is already running — with debug exporters, discarding
everything it receives. Installing this pack redirects it into Loki, Tempo, and Mimir. No
edits to the GitOps repository, no coordination with NIC.

This is on by default (`otelCollectorOverrides.enabled: true`).

## How it works

1. NIC's collector chart mounts an **optional** ConfigMap named
   `opentelemetry-collector-overrides` and passes it to the collector as an additional
   `--config` file. An init container resolves the override file, falling back to an empty
   `{}` when no software pack has supplied one.
2. This chart renders that ConfigMap, with exporter endpoints templated from
   `.Release.Name` and `.Release.Namespace` so DNS resolves even when the collector lives
   in a different namespace than the LGTM release.
3. The collector deep-merges NIC's base config with the override at startup. The override's
   pipelines replace the base `[debug]` exporter lists with `[otlphttp/loki]`,
   `[otlp/tempo]`, and `[otlphttp/mimir]`.
4. A post-install/post-upgrade Job rolls NIC's collector DaemonSet so the init container
   re-resolves the file.

Step 4 is not optional. The DaemonSet's `checksum/config` annotation is derived from NIC's
own Helm values, not from this external ConfigMap, so without an explicit rollout the new
config would not be picked up until some unrelated pod restart.

## The rendered override

```yaml
exporters:
  otlphttp/loki:
    endpoint: http://<release>-loki.<namespace>.svc.cluster.local:3100/otlp
    tls: { insecure: true }
  otlp/tempo:
    endpoint: http://<release>-tempo.<namespace>.svc.cluster.local:4317
    tls: { insecure: true }
  otlphttp/mimir:
    endpoint: http://<mimir-host>.<namespace>.svc.cluster.local:<port>/otlp
    tls: { insecure: true }
service:
  pipelines:
    logs:    { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlphttp/loki] }
    traces:  { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlp/tempo] }
    metrics: { receivers: [otlp, prometheus], processors: [memory_limiter, batch], exporters: [otlphttp/mimir] }
```

The Mimir host and port come from the same helpers the Grafana datasource uses, so the
override follows the [Mimir deployment mode](/mimir-modes/) automatically —
`<release>-mimir:8080` monolithic, `<release>-mimir-gateway:80` distributed.

The metrics pipeline keeps the `prometheus` receiver alongside `otlp`, which is how
kube-state-metrics and node-exporter reach Mimir: both subcharts set
`prometheus.io/scrape` pod annotations, and the collector's scrape job discovers them via
`role: pod`.

## Why a separate ConfigMap

An earlier design tried to patch NIC's chart-rendered collector ConfigMap in place, with
Argo CD `ignoreDifferences` protecting the patch. That hits upstream bug
[argo-cd#7478](https://github.com/argoproj/argo-cd/issues/7478): the apply step writes the
full rendered resource on every sync regardless of `ignoreDifferences`, clobbering the
patch.

Keeping the override in its own ConfigMap means NIC and this chart never write to the same
Kubernetes resource, so Argo CD is never asked to choose between conflicting desired
states.

## The rollout Job

The Job is a Helm `post-install,post-upgrade` hook with a ServiceAccount, Role, and
RoleBinding created alongside it (all `hook-delete-policy: before-hook-creation,hook-succeeded`).

Its RBAC is deliberately narrow: `get` and `patch` restricted by `resourceNames` to the
one DaemonSet, plus namespace-scoped `list` and `watch` — `resourceNames` does not apply
to list/watch verbs in Kubernetes RBAC, and `kubectl rollout status` needs an informer.

If the DaemonSet does not exist yet — LGTM installed before NIC has reconciled its
collector — the Job waits up to 5 minutes for it rather than failing, then restarts it and
waits up to 3 minutes for the rollout to complete.

## Configuration

| Value | Default | Purpose |
|---|---|---|
| `otelCollectorOverrides.enabled` | `true` | Render the override and the rollout hook. |
| `otelCollectorOverrides.namespace` | `monitoring` | Where NIC's collector DaemonSet lives; the ConfigMap is rendered here too. |
| `otelCollectorOverrides.daemonSetName` | `opentelemetry-collector-agent` | DaemonSet rolled after install/upgrade. |
| `otelCollectorOverrides.rolloutImage` | `alpine/k8s:1.30.4` | Needs `kubectl`. An unofficial community image — override if your organization requires a vetted registry. |
| `otelCollectorOverrides.imagePullPolicy` | `IfNotPresent` | Pull policy for the rollout Job. |

The default DaemonSet name matches what NIC's OTel collector chart renders with release
name `opentelemetry-collector` in daemonset mode — the chart's fullname helper collapses
when the release name contains the chart name, giving just `<release>-agent`.

## Disabling

```yaml
otelCollectorOverrides:
  enabled: false
```

Use this when NIC is not managing a collector — a standalone LGTM install against a
collector you configure yourself. Without the override ConfigMap, NIC's collector runs
with debug exporters only, which is to say it discards telemetry.

## Uninstall behavior

`helm uninstall` removes the `opentelemetry-collector-overrides` ConfigMap, but NIC's
collector pods keep using the config they resolved at startup. They revert to debug
exporters the next time they restart for any reason. To force it immediately:

```bash
kubectl -n monitoring rollout restart daemonset opentelemetry-collector-agent
```

## Troubleshooting

```bash
# Did the override land?
kubectl -n monitoring get cm opentelemetry-collector-overrides -o yaml

# Did the rollout hook succeed?
kubectl -n monitoring get jobs -l app.kubernetes.io/component=otel-rollout
kubectl -n monitoring logs job/lgtm-pack-otel-rollout

# Is the collector actually exporting, or still on debug?
kubectl -n monitoring logs ds/opentelemetry-collector-agent | grep -i exporter
```

If the ConfigMap exists but telemetry is not arriving, the usual cause is that the
collector pods predate the ConfigMap and the rollout Job did not run — check the Job, then
restart the DaemonSet by hand.
