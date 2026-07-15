# Mimir: monolithic by default, distributed with shared object store as opt-in

**Issue:** https://github.com/nebari-dev/lgtm-pack/issues/22
**Date:** 2026-07-15
**Status:** Approved

## Problem

The chart deploys Mimir via the `mimir-distributed` subchart (separate ingester,
compactor, store-gateway, querier pods) but forces `blocks_storage.backend:
filesystem` through `structuredConfig`. The filesystem backend is only valid
when every Mimir component shares one disk. In distributed mode each component
has its own PVC, so:

- The compactor sees an empty bucket; compaction and retention never run.
- The store-gateway serves no historical blocks; only the ingester's in-memory
  head window is queryable.
- The ingester's PVC grows without bound and eventually fills, halting all
  metrics ingestion (WAL write failures, 503s from the gateway, OTel collector
  OOM loops).

Root cause detail: the upstream `mimir-distributed` chart auto-wires all
components to its bundled MinIO when `minio.enabled: true`. Our
`structuredConfig` overrides clobber that wiring with filesystem storage, and
we also set `minio.enabled: false`.

## Decision

1. **Default: monolithic Mimir.** Single-binary Mimir (`-target=all`) rendered
   by our own templates, where the filesystem backend is actually valid.
2. **Opt-in: distributed Mimir with a shared object store.** The
   `mimir-distributed` subchart gated behind `mimir-distributed.enabled`, with
   its bundled MinIO enabled by default and the broken filesystem overrides
   removed.
3. **Retention bounded in both modes:** `compactor_blocks_retention_period:
   30d` (a `limits` config in Mimir, not a `compactor` block key — verify exact
   key against Mimir docs for the pinned version during implementation).

The `mimir-distributed` chart has no monolithic mode, so monolithic requires
our own templates. This keeps the project's "no custom Docker images" rule:
the monolithic StatefulSet runs the upstream `grafana/mimir` image as-is,
pinned to the same app version the subchart ships.

## Values interface

```yaml
# Monolithic Mimir (our templates) — the default
mimir:
  enabled: true            # escape hatch: disable to bring your own Mimir
  image:
    repository: grafana/mimir
    tag: ""                # pinned default in values; matches subchart appVersion
  retention: 30d           # limits.compactor_blocks_retention_period
  persistence:
    size: 20Gi
  resources: {}
  extraConfig: {}          # deep-merged into rendered Mimir config

# Distributed Mimir (upstream subchart) — opt-in
mimir-distributed:
  enabled: false           # flip to true for distributed mode
  minio:
    enabled: true          # shared object store, auto-wired by upstream chart
  # ... existing single-replica sizing kept; filesystem structuredConfig
  #     overrides removed; retention added via structuredConfig
```

Exactly one Mimir renders per install: our monolithic templates are gated on
`mimir.enabled` AND `not mimir-distributed.enabled`, so enabling the subchart
wins without requiring the user to flip two flags. If both are disabled, no
Mimir renders and the Grafana Mimir datasource entry is omitted.

A commented example in values.yaml shows distributed mode against a real cloud
bucket: `minio.enabled: false` plus `common.storage` s3 settings via
`structuredConfig`.

## Components

### 1. Chart.yaml

- Add `condition: mimir-distributed.enabled` to the `mimir-distributed`
  dependency.
- Bump chart `version` to 0.2.0 (behavior change: default topology changes).

### 2. Monolithic templates (new: `chart/templates/mimir/`)

Gated on `mimir.enabled` and `not (index .Values "mimir-distributed" "enabled")`.

- **`configmap.yaml`** — Mimir config:
  - `multitenancy_enabled: false`
  - `blocks_storage`, `ruler_storage`, `common.storage`: filesystem backends
    under a single `/data` volume
  - `limits.compactor_blocks_retention_period` from `mimir.retention`
  - single-instance ring config (replication factor 1)
  - server on HTTP 8080 / gRPC 9095
  - `mimir.extraConfig` deep-merged last
- **`statefulset.yaml`** — 1 replica, upstream `grafana/mimir` image,
  `-target=all -config.file=/etc/mimir/mimir.yaml`, one PVC (default 20Gi)
  mounted at `/data`, config checksum annotation so config changes roll the
  pod.
- **`service.yaml`** — `<release>-mimir`, HTTP port 8080.

Exact ring/kvstore settings for single-binary mode (memberlist vs inmemory)
verified against Mimir's monolithic-mode docs during implementation.

### 3. Distributed values fixes (`chart/values.yaml`)

Under the `mimir-distributed` key:

- `enabled: false` (new).
- `minio.enabled: true` (was false) — upstream chart then auto-wires
  `blocks_storage`, `ruler_storage`, and `common.storage` to MinIO over s3.
- **Remove** the `structuredConfig` overrides for `common.storage`,
  `blocks_storage`, `ruler_storage`, and `compactor.data_dir` (the root
  cause).
- **Keep** `multitenancy_enabled: false`, `ingest_storage.enabled: false`,
  ingester push gRPC, replication factors of 1, single-replica component
  sizing, gateway, and disabled kafka/rollout-operator/alertmanager/ruler.
- **Add** retention via structuredConfig
  (`limits.compactor_blocks_retention_period: 30d`).

### 4. Endpoint switching (`chart/templates/_helpers.tpl`)

New helper `nebari-lgtm-pack.mimir-base-url`:

- monolithic → `http://<release>-mimir:8080`
- distributed → `http://<release>-mimir-gateway`

Consumers:

- `chart/templates/grafana-datasources.yaml` — Mimir datasource URL becomes
  `<base>/prometheus`; the datasource entry is omitted entirely when no Mimir
  is enabled.
- `chart/templates/otel-collector-config-patch.yaml` — `otlphttp/mimir`
  exporter endpoint becomes `<base>/otlp`.

Also update the stale `additionalServices` comment in values.yaml that
references `<release>-mimir-distributed-nginx`.

### 5. CI

- **lint.yaml**: lint + template both modes (add a leg with
  `--set mimir-distributed.enabled=true`).
- **test.yaml**: matrix over `mode: [monolithic, distributed]`. The
  distributed leg is the regression test for the issue: chart installs with
  MinIO, pods become ready, Grafana health + datasource checks pass.

### 6. Docs

- README: document the two modes, the toggle, retention default, and the
  external-bucket example.
- CLAUDE.md: update the architecture notes ("all backends run in
  single-binary/monolithic mode" now includes Mimir; distributed is opt-in).

## Error handling

- Both Mimirs enabled: impossible — subchart enablement gates our templates
  off.
- Both disabled: no Mimir renders, no dangling Grafana datasource (entry
  omitted). Dashboards referencing the Mimir datasource will show "datasource
  not found", which is the honest state.
- Config changes to the monolithic ConfigMap roll the StatefulSet via checksum
  annotation.

## Testing

- `helm template` assertions for both modes (correct datasource URL, correct
  OTel endpoint, exactly one Mimir workload set rendered).
- Full k3d deployment test in CI for both modes (existing test.yaml flow).
- Manual verification per the issue: in distributed mode, compactor logs show
  a nonzero user count from the bucket; ingester PVC usage does not grow
  monotonically.

## Out of scope

- HA / multi-replica distributed sizing (users tune via passthrough values).
- Migration tooling for existing installs moving filesystem blocks into a
  bucket. Release notes will state that existing distributed-mode metrics
  data is effectively orphaned (it was never queryable or compacted anyway).
- Loki/Tempo storage topology (both already run single-binary/local by
  default; distributed variants for them are separate work).
