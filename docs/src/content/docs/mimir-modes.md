---
title: Mimir deployment modes
description: Monolithic single-binary Mimir versus the distributed topology, and how to choose.
---

Mimir ships in two topologies. The chart defaults to **monolithic** and lets you opt into
**distributed** with one value.

| | Monolithic (default) | Distributed (opt-in) |
|---|---|---|
| Value | `mimir.enabled: true` | `mimir-distributed.enabled: true` |
| Rendered by | this chart, `templates/mimir/` | upstream `mimir-distributed` subchart |
| Topology | one StatefulSet, `-target=all` | distributor, ingester, querier, query-frontend, query-scheduler, store-gateway, compactor, gateway |
| Storage | filesystem, one 20Gi PVC | shared object store (MinIO or S3) |
| Service | `<release>-mimir:8080` | `<release>-mimir-gateway:80` |
| Retention | `mimir.retention`, 30d | `compactor_blocks_retention_period`, 30d |
| Scales | vertically | horizontally |

Enabling `mimir-distributed` automatically suppresses the monolithic StatefulSet — the
template is guarded on `and .Values.mimir.enabled (not (index .Values "mimir-distributed" "enabled"))`
— so you never get both.

## Switching to distributed

```bash
helm upgrade lgtm-pack nebari/nebari-lgtm-pack \
  --namespace monitoring \
  --set mimir-distributed.enabled=true \
  --set nebariapp.enabled=false
```

Consumers follow the mode on their own. The Grafana datasource URL and the OTel
collector's metrics exporter are both built from the `mimir-host` and `mimir-port`
helpers, which switch on the same flag — nothing else needs editing.

:::caution[Switching modes does not migrate data]
The two topologies use different storage backends. Blocks written by monolithic Mimir on
its PVC are not visible to a distributed install reading from an object store, and vice
versa. Treat a mode change as starting a fresh metrics store.
:::

## Why filesystem storage is invalid distributed

This is the trap that motivated the current defaults
([issue #22](https://github.com/nebari-dev/lgtm-pack/issues/22)).

Distributed Mimir splits ingestion, compaction, and querying across separate pods, each
with its own PVC. Configure `backend: filesystem` and every component gets a private
"bucket" that no other component can see:

- The **compactor** finds no blocks to compact, so retention never runs.
- The **store-gateway** cannot serve historical blocks, so queries return only what is
  still in the ingester's memory.
- The **ingester's** disk grows without bound until it fills and ingestion halts.

Nothing errors. The stack looks healthy right up until the volume is full. Distributed
mode therefore requires a genuinely shared object store, and the chart's defaults
enable the bundled MinIO to guarantee one exists.

Monolithic mode has no such problem: one process owns the one `/data` volume, so
compaction, retention, and querying all see the same blocks.

## The bundled MinIO

`mimir-distributed.minio.enabled` defaults to `true`. The upstream chart auto-wires
blocks, ruler, and alertmanager storage of every component to it.

:::caution[MinIO defaults are development-grade]
Static credentials rendered into the Mimir config ConfigMap, and a 5Gi PVC. For anything
beyond a test cluster, override `minio.rootUser`, `minio.rootPassword`, and
`minio.persistence.size` — or use a real bucket.
:::

## Using a cloud bucket

Disable MinIO and point Mimir at S3. The subchart runs Mimir with `-config.expand-env`, so
`${...}` placeholders are expanded from the container environment; inject credentials via
`global.extraEnvFrom` rather than writing them into values.

```yaml
mimir-distributed:
  enabled: true
  minio:
    enabled: false
  global:
    extraEnvFrom:
      - secretRef:
          name: mimir-s3-credentials   # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
  mimir:
    structuredConfig:
      common:
        storage:
          backend: s3
          s3:
            endpoint: s3.us-east-1.amazonaws.com
            region: us-east-1
            access_key_id: ${AWS_ACCESS_KEY_ID}
            secret_access_key: ${AWS_SECRET_ACCESS_KEY}
      blocks_storage:
        s3:
          bucket_name: my-mimir-blocks
      ruler_storage:
        s3:
          bucket_name: my-mimir-ruler
```

## Distributed defaults are sized for development

The chart's `mimir-distributed` block is tuned for a laptop, not production: single
replicas across the board, replication factor 1 for both the ingester and store-gateway
rings, multitenancy off, Kafka-backed ingest off, and the rollout-operator, overrides
exporter, ruler, and alertmanager scaled to zero.

Raise replica counts and replication factors before relying on it for anything durable —
replication factor 1 means a single ingester restart loses the in-memory window.

## Tuning monolithic Mimir

`mimir.extraConfig` is deep-merged over the rendered config, so you can reach any Mimir
setting without templating changes:

```yaml
mimir:
  retention: 90d
  persistence:
    size: 100Gi
  resources:
    requests: { cpu: 500m, memory: 2Gi }
    limits: { memory: 4Gi }
  extraConfig:
    limits:
      ingestion_rate: 100000
      max_global_series_per_user: 2000000
```

## Disabling Mimir entirely

Setting both `mimir.enabled: false` and `mimir-distributed.enabled: false` removes the
Grafana Mimir datasource. It does **not** remove the metrics pipeline from the OTel
collector override, which will keep exporting to a service that no longer exists. Either
set `otelCollectorOverrides.enabled: false` or bring your own metrics backend.
