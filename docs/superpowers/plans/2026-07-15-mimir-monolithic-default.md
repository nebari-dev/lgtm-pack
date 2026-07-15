# Mimir Monolithic-Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make single-binary (monolithic) Mimir the chart default and turn the `mimir-distributed` subchart into an opt-in mode backed by a shared object store (bundled MinIO), fixing https://github.com/nebari-dev/lgtm-pack/issues/22.

**Architecture:** The `mimir-distributed` dependency gets a Helm `condition` (`mimir-distributed.enabled`, default `false`). New chart-owned templates under `chart/templates/mimir/` render a single-replica StatefulSet running the upstream `grafana/mimir:3.0.1` image with `-target=all` and filesystem storage on one PVC (the only topology where filesystem storage is valid). When the subchart is enabled instead, its bundled MinIO is on and the broken `structuredConfig` filesystem overrides are removed, so the upstream chart auto-wires every component to s3. Helpers in `_helpers.tpl` switch the Grafana datasource URL and the OTel exporter endpoint between the two modes. Retention is bounded at 30d in both modes via `limits.compactor_blocks_retention_period`.

**Tech Stack:** Helm 3 umbrella chart, bash template-assertion script (`chart/tests/assert-rendering.sh`), GitHub Actions (lint + k3d e2e matrix), Tilt for local dev.

**Spec:** `docs/superpowers/specs/2026-07-15-mimir-monolithic-default-design.md`

**Verified facts (do not re-derive):**
- `mimir-distributed` 6.0.5 has appVersion **3.0.1**, image `grafana/mimir:3.0.1`, `configStorageType: ConfigMap` (rendered ConfigMap is named `<release>-mimir-config`), gateway service port **80**, bundled MinIO service `<release>-minio:9000` with buckets `mimir-tsdb`/`mimir-ruler`. Its base config template auto-wires all storage to MinIO when `minio.enabled: true`.
- Mimir retention is a **limits** key: `limits.compactor_blocks_retention_period` (not under `compactor`).
- Repo-root `CLAUDE.md` is gitignored (local-only) — edit it, never `git add` it.
- Chart source is in `chart/`; run helm commands against that path. `helm dependency update chart` populates `chart/charts/` (gitignored).

**Testing model:** every task extends `chart/tests/assert-rendering.sh` (pure `helm template` + grep, no cluster needed), runs it red first, implements, runs it green, commits. The k3d e2e matrix in Task 5 covers runtime behavior.

---

### Task 0: Prerequisites (once)

- [ ] **Step 0.1: Build chart dependencies**

Run: `helm dependency update chart`
Expected: downloads 7 subchart tgz files into `chart/charts/`, exits 0.

---

### Task 1: Gate the mimir-distributed subchart behind `mimir-distributed.enabled` (default off)

**Files:**
- Create: `chart/tests/assert-rendering.sh`
- Modify: `chart/Chart.yaml` (mimir-distributed dependency entry)
- Modify: `chart/values.yaml` (add `enabled: false` under `mimir-distributed`)

- [ ] **Step 1.1: Write the failing assertions**

Create `chart/tests/assert-rendering.sh`:

```bash
#!/usr/bin/env bash
# Template-rendering assertions for both Mimir modes (monolithic default,
# distributed opt-in). Pure `helm template` — no cluster required.
# Prerequisite: helm dependency update chart
set -euo pipefail

CHART="$(cd "$(dirname "$0")/.." && pwd)"

fail() { echo "ASSERT FAIL: $1" >&2; exit 1; }

# assert_contains <var-name> <pattern> <message>
assert_contains() {
  if ! grep -q -- "$2" <<<"${!1}"; then fail "$3"; fi
}

# assert_not_contains <var-name> <pattern> <message>
assert_not_contains() {
  if grep -q -- "$2" <<<"${!1}"; then fail "$3"; fi
}

echo "== rendering default (monolithic) mode =="
DEFAULT_OUT="$(helm template test "$CHART" --namespace default --set nebariapp.enabled=false)"

echo "== rendering distributed mode =="
DIST_OUT="$(helm template test "$CHART" --namespace default --set nebariapp.enabled=false \
  --set mimir-distributed.enabled=true)"

# --- Mode toggle: exactly one Mimir topology renders per mode ---
assert_not_contains DEFAULT_OUT 'name: test-mimir-ingester' \
  "default mode must not render mimir-distributed components"
assert_contains DIST_OUT 'name: test-mimir-ingester' \
  "distributed mode must render mimir-distributed components"
assert_contains DIST_OUT 'name: test-mimir-gateway' \
  "distributed mode must render the mimir gateway"

echo "All rendering assertions passed."
```

Then: `chmod +x chart/tests/assert-rendering.sh`

- [ ] **Step 1.2: Run to verify it fails**

Run: `bash chart/tests/assert-rendering.sh`
Expected: FAIL with `ASSERT FAIL: default mode must not render mimir-distributed components` (the subchart currently always renders).

- [ ] **Step 1.3: Add the dependency condition**

In `chart/Chart.yaml`, change the mimir-distributed dependency entry from:

```yaml
  - name: mimir-distributed
    version: 6.0.5
    repository: https://grafana.github.io/helm-charts
```

to:

```yaml
  - name: mimir-distributed
    version: 6.0.5
    repository: https://grafana.github.io/helm-charts
    condition: mimir-distributed.enabled
```

- [ ] **Step 1.4: Default the flag to false in values**

In `chart/values.yaml`, the `mimir-distributed:` section currently begins:

```yaml
mimir-distributed:
  # Lightweight config for local development — single replicas, no Kafka, filesystem storage
  mimir:
```

Change the opening to (the rest of the section is untouched in this task):

```yaml
mimir-distributed:
  # Opt-in distributed Mimir. Default is OFF: the chart deploys monolithic
  # single-binary Mimir instead (see the `mimir` block above once Task 2 adds
  # it). Flip to true for a horizontally scalable topology backed by a shared
  # object store.
  enabled: false
  # Lightweight config for local development — single replicas, no Kafka
  mimir:
```

- [ ] **Step 1.5: Run assertions to verify they pass**

Run: `bash chart/tests/assert-rendering.sh`
Expected: `All rendering assertions passed.`

- [ ] **Step 1.6: Commit**

```bash
git add chart/Chart.yaml chart/values.yaml chart/tests/assert-rendering.sh
git commit -m "feat: gate mimir-distributed subchart behind mimir-distributed.enabled (default off)"
```

Note: after this task the default install has no Mimir at all — intentional intermediate state; Task 2 adds the monolithic default.

---

### Task 2: Monolithic Mimir templates (the new default)

**Files:**
- Modify: `chart/values.yaml` (new top-level `mimir:` block)
- Modify: `chart/templates/_helpers.tpl` (append config helper)
- Create: `chart/templates/mimir/configmap.yaml`
- Create: `chart/templates/mimir/statefulset.yaml`
- Create: `chart/templates/mimir/service.yaml`
- Modify: `chart/tests/assert-rendering.sh`

- [ ] **Step 2.1: Add failing assertions**

In `chart/tests/assert-rendering.sh`, insert before the final `echo "All rendering assertions passed."`. (Patterns starting with a dash are safe: the helpers pass `--` to grep.)

```bash
# --- Monolithic Mimir (default) ---
assert_contains DEFAULT_OUT '-target=all' \
  "default mode must run single-binary Mimir (-target=all)"
assert_contains DEFAULT_OUT 'name: test-mimir-config' \
  "default mode must render the monolithic Mimir ConfigMap"
assert_contains DEFAULT_OUT 'compactor_blocks_retention_period: 30d' \
  "monolithic config must bound retention (issue #22)"
assert_contains DEFAULT_OUT 'checksum/config' \
  "monolithic StatefulSet must roll on config changes"
assert_not_contains DIST_OUT '-target=all' \
  "distributed mode must not render the monolithic StatefulSet"
```

- [ ] **Step 2.2: Run to verify it fails**

Run: `bash chart/tests/assert-rendering.sh`
Expected: FAIL with `default mode must run single-binary Mimir (-target=all)`.

- [ ] **Step 2.3: Add the `mimir:` values block**

In `chart/values.yaml`, insert directly above the `# Mimir — Metrics (Prometheus-compatible)` section header:

```yaml
# =============================================================================
# Mimir — Metrics (monolithic single-binary, the default)
# =============================================================================
# Rendered by this chart's own templates (templates/mimir/) using the upstream
# grafana/mimir image — the mimir-distributed subchart has no monolithic mode.
# All Mimir components run in one process sharing one PVC, which is the only
# topology where Mimir's filesystem storage backend is valid. For horizontal
# scale, enable the mimir-distributed subchart below instead (this block is
# then ignored).
mimir:
  enabled: true
  image:
    repository: grafana/mimir
    # Kept in lockstep with the mimir-distributed subchart's appVersion so
    # both modes run the same Mimir release.
    tag: "3.0.1"
  # How long the compactor keeps blocks before deleting them. Unset would mean
  # keep-forever and unbounded disk growth (issue #22).
  retention: 30d
  persistence:
    size: 20Gi
  resources: {}
  # Deep-merged over the rendered Mimir config (templates/mimir/configmap.yaml)
  # for advanced tuning, e.g.:
  # extraConfig:
  #   limits:
  #     ingestion_rate: 100000
  extraConfig: {}
```

- [ ] **Step 2.4: Add the config helper**

Append to `chart/templates/_helpers.tpl`:

```yaml
{{/*
Monolithic Mimir base configuration. mimir.extraConfig is deep-merged over
this in templates/mimir/configmap.yaml. Filesystem storage is valid here
because a single process owns the single /data volume — unlike distributed
mode, where a filesystem "bucket" is invisible to every other component
(issue #22).
*/}}
{{- define "nebari-lgtm-pack.mimir-monolithic-config" -}}
multitenancy_enabled: false

server:
  http_listen_port: 8080
  grpc_listen_port: 9095

# Classic architecture (no Kafka-backed ingest), matching the distributed
# mode's settings.
ingest_storage:
  enabled: false

# Single-process rings: every component talks to itself.
ingester:
  ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: memberlist
    replication_factor: 1

distributor:
  ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: memberlist

store_gateway:
  sharding_ring:
    replication_factor: 1

blocks_storage:
  backend: filesystem
  filesystem:
    dir: /data/blocks
  bucket_store:
    sync_dir: /data/tsdb-sync
  tsdb:
    dir: /data/tsdb

compactor:
  data_dir: /data/compactor
  sharding_ring:
    kvstore:
      store: memberlist

ruler_storage:
  backend: filesystem
  filesystem:
    dir: /data/rules

# Default filepath (./metrics-activity.log) is not writable by the non-root
# container user; keep it on the data volume.
activity_tracker:
  filepath: /data/metrics-activity.log

limits:
  # Bound disk usage — unset means keep blocks forever (issue #22).
  compactor_blocks_retention_period: {{ .Values.mimir.retention }}
{{- end }}
```

- [ ] **Step 2.5: Create the ConfigMap template**

Create `chart/templates/mimir/configmap.yaml`:

```yaml
{{- if and .Values.mimir.enabled (not (index .Values "mimir-distributed" "enabled")) }}
{{- $config := include "nebari-lgtm-pack.mimir-monolithic-config" . | fromYaml }}
{{- $merged := mustMergeOverwrite $config (deepCopy .Values.mimir.extraConfig) }}
apiVersion: v1
kind: ConfigMap
metadata:
  # Same name the mimir-distributed subchart uses for its rendered config, so
  # tooling (and the CI test) can read <release>-mimir-config in either mode.
  # No collision: the two modes are mutually exclusive.
  name: {{ .Release.Name }}-mimir-config
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "nebari-lgtm-pack.labels" . | nindent 4 }}
    app.kubernetes.io/component: mimir
data:
  mimir.yaml: |
    {{- toYaml $merged | nindent 4 }}
{{- end }}
```

- [ ] **Step 2.6: Create the StatefulSet template**

Create `chart/templates/mimir/statefulset.yaml`:

```yaml
{{- if and .Values.mimir.enabled (not (index .Values "mimir-distributed" "enabled")) }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ .Release.Name }}-mimir
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "nebari-lgtm-pack.labels" . | nindent 4 }}
    app.kubernetes.io/component: mimir
spec:
  replicas: 1
  serviceName: {{ .Release.Name }}-mimir
  selector:
    matchLabels:
      {{- include "nebari-lgtm-pack.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: mimir
  template:
    metadata:
      labels:
        {{- include "nebari-lgtm-pack.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: mimir
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/mimir/configmap.yaml") . | sha256sum }}
    spec:
      securityContext:
        fsGroup: 10001
        runAsGroup: 10001
        runAsNonRoot: true
        runAsUser: 10001
      containers:
        - name: mimir
          image: "{{ .Values.mimir.image.repository }}:{{ .Values.mimir.image.tag }}"
          imagePullPolicy: IfNotPresent
          args:
            - -target=all
            - -config.file=/etc/mimir/mimir.yaml
          ports:
            - name: http-metrics
              containerPort: 8080
            - name: grpc
              containerPort: 9095
          readinessProbe:
            httpGet:
              path: /ready
              port: http-metrics
            initialDelaySeconds: 15
            timeoutSeconds: 5
          resources:
            {{- toYaml .Values.mimir.resources | nindent 12 }}
          volumeMounts:
            - name: config
              mountPath: /etc/mimir
            - name: data
              mountPath: /data
      volumes:
        - name: config
          configMap:
            name: {{ .Release.Name }}-mimir-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: {{ .Values.mimir.persistence.size }}
{{- end }}
```

- [ ] **Step 2.7: Create the Service template**

Create `chart/templates/mimir/service.yaml`:

```yaml
{{- if and .Values.mimir.enabled (not (index .Values "mimir-distributed" "enabled")) }}
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-mimir
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "nebari-lgtm-pack.labels" . | nindent 4 }}
    app.kubernetes.io/component: mimir
spec:
  type: ClusterIP
  ports:
    - name: http-metrics
      port: 8080
      targetPort: http-metrics
    - name: grpc
      port: 9095
      targetPort: grpc
  selector:
    {{- include "nebari-lgtm-pack.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: mimir
{{- end }}
```

- [ ] **Step 2.8: Run assertions to verify they pass**

Run: `bash chart/tests/assert-rendering.sh && helm lint chart --set nebariapp.enabled=false`
Expected: `All rendering assertions passed.` and `1 chart(s) linted, 0 chart(s) failed`.

- [ ] **Step 2.9: Commit**

```bash
git add chart/values.yaml chart/templates/_helpers.tpl chart/templates/mimir/ chart/tests/assert-rendering.sh
git commit -m "feat: add monolithic single-binary Mimir as the default deployment"
```

---

### Task 3: Fix distributed mode — shared object store (MinIO) + bounded retention

**Files:**
- Modify: `chart/values.yaml` (`mimir-distributed` section)
- Modify: `chart/tests/assert-rendering.sh`

- [ ] **Step 3.1: Add failing assertions**

In `chart/tests/assert-rendering.sh`, insert before the final `echo`:

```bash
# --- Distributed mode: shared object store, no filesystem "buckets" ---
assert_contains DIST_OUT 'name: test-minio' \
  "distributed mode must deploy the bundled MinIO"
assert_contains DIST_OUT 'bucket_name: mimir-tsdb' \
  "distributed blocks storage must point at the MinIO bucket"
assert_not_contains DIST_OUT 'dir: /data/mimir-blocks' \
  "distributed mode must not use filesystem blocks storage (issue #22)"
assert_contains DIST_OUT 'compactor_blocks_retention_period: 30d' \
  "distributed config must bound retention (issue #22)"
```

- [ ] **Step 3.2: Run to verify it fails**

Run: `bash chart/tests/assert-rendering.sh`
Expected: FAIL with `distributed mode must deploy the bundled MinIO`.

- [ ] **Step 3.3: Rewrite the mimir-distributed values section**

In `chart/values.yaml`, replace the `mimir:` and `minio:` parts of the `mimir-distributed:` section. The current content (as left by Task 1) is:

```yaml
  # Lightweight config for local development — single replicas, no Kafka
  mimir:
    structuredConfig:
      multitenancy_enabled: false
      common:
        storage:
          backend: filesystem
      ingest_storage:
        enabled: false
      ingester:
        push_grpc_method_enabled: true
        ring:
          replication_factor: 1
      store_gateway:
        sharding_ring:
          replication_factor: 1
      blocks_storage:
        backend: filesystem
        filesystem:
          dir: /data/mimir-blocks
      compactor:
        data_dir: /data/mimir-compactor
      ruler_storage:
        backend: filesystem
        filesystem:
          dir: /data/mimir-rules
```

Replace it with:

```yaml
  # Shared object store. The upstream chart auto-wires blocks, ruler, and
  # alertmanager storage of every component to this bundled MinIO. Filesystem
  # storage is NOT valid in distributed mode: each component would see only
  # its own PVC, so compaction/retention never run and the ingester disk
  # grows until ingestion halts (issue #22).
  #
  # To use a real cloud bucket instead, disable minio and supply the s3
  # config, e.g.:
  # minio:
  #   enabled: false
  # mimir:
  #   structuredConfig:
  #     common:
  #       storage:
  #         backend: s3
  #         s3:
  #           endpoint: s3.us-east-1.amazonaws.com
  #           region: us-east-1
  #           access_key_id: ${AWS_ACCESS_KEY_ID}
  #           secret_access_key: ${AWS_SECRET_ACCESS_KEY}
  #     blocks_storage:
  #       s3:
  #         bucket_name: my-mimir-blocks
  #     ruler_storage:
  #       s3:
  #         bucket_name: my-mimir-ruler
  minio:
    enabled: true
  # Lightweight config for local development — single replicas, no Kafka
  mimir:
    structuredConfig:
      multitenancy_enabled: false
      ingest_storage:
        enabled: false
      ingester:
        push_grpc_method_enabled: true
        ring:
          replication_factor: 1
      store_gateway:
        sharding_ring:
          replication_factor: 1
      limits:
        # Bound bucket usage — unset means keep blocks forever (issue #22).
        compactor_blocks_retention_period: 30d
```

Then delete the now-duplicate `minio:` entry further down the section. The current lines:

```yaml
  kafka:
    enabled: false
  minio:
    enabled: false
  rollout_operator:
    enabled: false
```

become:

```yaml
  kafka:
    enabled: false
  rollout_operator:
    enabled: false
```

Everything else in the section (ingester/distributor/querier/query_frontend/store_gateway/compactor replicas and persistence, gateway, overrides_exporter, ruler, alertmanager, query_scheduler) stays as-is.

- [ ] **Step 3.4: Run assertions to verify they pass**

Run: `bash chart/tests/assert-rendering.sh && helm lint chart --set nebariapp.enabled=false --set mimir-distributed.enabled=true`
Expected: `All rendering assertions passed.` and lint success.

- [ ] **Step 3.5: Commit**

```bash
git add chart/values.yaml chart/tests/assert-rendering.sh
git commit -m "fix: back distributed Mimir with shared MinIO object storage and bounded retention"
```

---

### Task 4: Mode-aware endpoints (Grafana datasource + OTel exporter)

**Files:**
- Modify: `chart/templates/_helpers.tpl` (append host/port/enabled helpers)
- Modify: `chart/templates/grafana-datasources.yaml:36-42`
- Modify: `chart/templates/otel-collector-config-patch.yaml:38-39`
- Modify: `chart/values.yaml` (stale `additionalServices` comment)
- Modify: `chart/tests/assert-rendering.sh`

- [ ] **Step 4.1: Add failing assertions**

In `chart/tests/assert-rendering.sh`, insert before the final `echo`:

```bash
# --- Mode-aware endpoints ---
assert_contains DEFAULT_OUT 'url: http://test-mimir:8080/prometheus' \
  "default datasource must point at the monolithic Mimir service"
assert_contains DEFAULT_OUT 'endpoint: http://test-mimir.default.svc.cluster.local:8080/otlp' \
  "default OTel exporter must point at the monolithic Mimir service"
assert_not_contains DEFAULT_OUT 'test-mimir-gateway' \
  "default mode must not reference the distributed gateway anywhere"
assert_contains DIST_OUT 'url: http://test-mimir-gateway:80/prometheus' \
  "distributed datasource must point at the mimir gateway"
assert_contains DIST_OUT 'endpoint: http://test-mimir-gateway.default.svc.cluster.local:80/otlp' \
  "distributed OTel exporter must point at the mimir gateway"

echo "== rendering with all Mimir disabled =="
NO_MIMIR_OUT="$(helm template test "$CHART" --namespace default --set nebariapp.enabled=false \
  --set mimir.enabled=false)"
assert_not_contains NO_MIMIR_OUT 'name: Mimir' \
  "with no Mimir enabled, the Grafana Mimir datasource must be omitted"
```

- [ ] **Step 4.2: Run to verify it fails**

Run: `bash chart/tests/assert-rendering.sh`
Expected: FAIL with `default datasource must point at the monolithic Mimir service`.

- [ ] **Step 4.3: Add endpoint helpers**

Append to `chart/templates/_helpers.tpl`:

```yaml
{{/*
Mimir service host and port — switch between the chart's monolithic Service
and the mimir-distributed gateway based on which mode is enabled. Consumers
build URLs as http://<host>:<port>/... (Grafana datasource, OTel exporter).
*/}}
{{- define "nebari-lgtm-pack.mimir-host" -}}
{{- if index .Values "mimir-distributed" "enabled" -}}
{{- .Release.Name }}-mimir-gateway
{{- else -}}
{{- .Release.Name }}-mimir
{{- end -}}
{{- end }}

{{- define "nebari-lgtm-pack.mimir-port" -}}
{{- if index .Values "mimir-distributed" "enabled" -}}80{{- else -}}8080{{- end -}}
{{- end }}

{{/*
Truthy when any Mimir (monolithic or distributed) is part of this install;
empty string otherwise, so it can be used directly in `if` conditions.
*/}}
{{- define "nebari-lgtm-pack.mimir-enabled" -}}
{{- if or .Values.mimir.enabled (index .Values "mimir-distributed" "enabled") -}}true{{- end -}}
{{- end }}
```

- [ ] **Step 4.4: Switch the Grafana datasource**

In `chart/templates/grafana-datasources.yaml`, replace:

```yaml
      - name: Mimir
        uid: mimir
        type: prometheus
        access: proxy
        url: http://{{ .Release.Name }}-mimir-gateway/prometheus
        jsonData:
          httpMethod: POST
```

with:

```yaml
      {{- if include "nebari-lgtm-pack.mimir-enabled" . }}
      - name: Mimir
        uid: mimir
        type: prometheus
        access: proxy
        url: http://{{ include "nebari-lgtm-pack.mimir-host" . }}:{{ include "nebari-lgtm-pack.mimir-port" . }}/prometheus
        jsonData:
          httpMethod: POST
      {{- end }}
```

- [ ] **Step 4.5: Switch the OTel exporter endpoint**

In `chart/templates/otel-collector-config-patch.yaml`, replace:

```yaml
      otlphttp/mimir:
        endpoint: http://{{ .Release.Name }}-mimir-gateway.{{ .Release.Namespace }}.svc.cluster.local/otlp
```

with:

```yaml
      otlphttp/mimir:
        endpoint: http://{{ include "nebari-lgtm-pack.mimir-host" . }}.{{ .Release.Namespace }}.svc.cluster.local:{{ include "nebari-lgtm-pack.mimir-port" . }}/otlp
```

- [ ] **Step 4.6: Fix the stale values comment**

In `chart/values.yaml`, in the commented `additionalServices` example, replace:

```yaml
  #   - name: mimir-push
  #     service:
  #       name: <release>-mimir-distributed-nginx
  #       port: 80
```

with:

```yaml
  #   - name: mimir-push
  #     service:
  #       # monolithic: <release>-mimir port 8080
  #       # distributed: <release>-mimir-gateway port 80
  #       name: <release>-mimir
  #       port: 8080
```

- [ ] **Step 4.7: Run assertions to verify they pass**

Run: `bash chart/tests/assert-rendering.sh`
Expected: `All rendering assertions passed.`

- [ ] **Step 4.8: Commit**

```bash
git add chart/templates/_helpers.tpl chart/templates/grafana-datasources.yaml chart/templates/otel-collector-config-patch.yaml chart/values.yaml chart/tests/assert-rendering.sh
git commit -m "feat: switch Grafana datasource and OTel exporter endpoints by Mimir mode"
```

---

### Task 5: CI — lint both modes, e2e matrix with Mimir ingest/query test

**Files:**
- Modify: `.github/workflows/lint.yaml`
- Modify: `.github/workflows/test.yaml`

- [ ] **Step 5.1: Lint both modes and run the assertion script in CI**

In `.github/workflows/lint.yaml`, replace the two final steps:

```yaml
      - name: Lint chart
        run: helm lint chart --set nebariapp.enabled=false

      - name: Template chart
        run: helm template test chart --set nebariapp.enabled=false > /dev/null
```

with:

```yaml
      - name: Lint chart (monolithic default)
        run: helm lint chart --set nebariapp.enabled=false

      - name: Lint chart (distributed mode)
        run: helm lint chart --set nebariapp.enabled=false --set mimir-distributed.enabled=true

      - name: Template rendering assertions (both modes)
        run: bash chart/tests/assert-rendering.sh
```

- [ ] **Step 5.2: Add the mode matrix to test.yaml**

In `.github/workflows/test.yaml`, change the job header from:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
```

to:

```yaml
jobs:
  test:
    name: test (${{ matrix.mimir-mode }} mimir)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        mimir-mode: [monolithic, distributed]
```

- [ ] **Step 5.3: Deploy the chart in the matrix mode**

In the `Deploy chart` step, change:

```yaml
          helm install lgtm-pack chart --namespace default \
            --set nebariapp.enabled=false \
            --set grafana.envFromConfigMaps=null \
            --set grafana.envValueFrom=null \
            --set otelCollectorOverrides.enabled=true \
            --timeout 10m
```

to:

```yaml
          helm install lgtm-pack chart --namespace default \
            --set nebariapp.enabled=false \
            --set grafana.envFromConfigMaps=null \
            --set grafana.envValueFrom=null \
            --set otelCollectorOverrides.enabled=true \
            --set mimir-distributed.enabled=${{ matrix.mimir-mode == 'distributed' }} \
            --timeout 10m
```

- [ ] **Step 5.4: Make the override-ConfigMap check mode-aware**

In the `Verify override ConfigMap rendered with correct content` step, replace:

```yaml
          grep -q 'http://lgtm-pack-mimir-gateway.default.svc.cluster.local/otlp' /tmp/overrides.yaml
```

with:

```yaml
          if [ "${{ matrix.mimir-mode }}" = "distributed" ]; then
            grep -q 'http://lgtm-pack-mimir-gateway.default.svc.cluster.local:80/otlp' /tmp/overrides.yaml
          else
            grep -q 'http://lgtm-pack-mimir.default.svc.cluster.local:8080/otlp' /tmp/overrides.yaml
          fi
```

- [ ] **Step 5.5: Add Mimir readiness, storage-backend, and ingest/query steps**

Insert the following three steps after the `Test datasource provisioning` step and before `Test Loki log push and query`:

```yaml
      - name: Wait for Mimir
        run: |
          if [ "${{ matrix.mimir-mode }}" = "distributed" ]; then
            SELECTOR="app.kubernetes.io/name=mimir"
          else
            SELECTOR="app.kubernetes.io/component=mimir"
          fi
          for i in {1..60}; do
            echo "=== Attempt $i/60 ==="
            kubectl get pods -l "$SELECTOR"
            if kubectl wait --for=condition=ready pod -l "$SELECTOR" --timeout=5s 2>/dev/null; then
              echo "Mimir pods ready!"
              exit 0
            fi
            sleep 5
          done
          echo "Timeout waiting for Mimir"
          exit 1

      - name: Verify distributed mode uses shared object storage
        if: matrix.mimir-mode == 'distributed'
        run: |
          set -e
          kubectl get configmap lgtm-pack-mimir-config \
            -o jsonpath='{.data.mimir\.yaml}' > /tmp/mimir-config.yaml
          grep -q 'backend: s3' /tmp/mimir-config.yaml
          if grep -q 'backend: filesystem' /tmp/mimir-config.yaml; then
            echo "FAIL: filesystem storage backend in distributed mode (issue #22 regression)"
            exit 1
          fi
          echo "Blocks storage correctly backed by s3 (MinIO)."

      - name: Test Mimir OTLP push and Prometheus query
        run: |
          if [ "${{ matrix.mimir-mode }}" = "distributed" ]; then
            SVC=lgtm-pack-mimir-gateway; PORT=80
          else
            SVC=lgtm-pack-mimir; PORT=8080
          fi
          kubectl port-forward svc/$SVC 9009:$PORT &
          PF_PID=$!
          sleep 5
          NOW="$(date +%s)000000000"
          echo "=== Pushing test metric via OTLP/HTTP JSON ==="
          curl -sS -f -X POST http://localhost:9009/otlp/v1/metrics \
            -H "Content-Type: application/json" \
            -d '{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"ci-test"}}]},"scopeMetrics":[{"metrics":[{"name":"ci_test_metric","gauge":{"dataPoints":[{"asDouble":42,"timeUnixNano":"'"$NOW"'"}]}}]}]}]}'
          echo ""
          echo "=== Querying it back via the Prometheus API ==="
          sleep 5
          RESP=$(curl -sS 'http://localhost:9009/prometheus/api/v1/query?query=ci_test_metric')
          echo "$RESP"
          echo "$RESP" | grep -q 'ci_test_metric'
          RESULT=$?
          kill $PF_PID 2>/dev/null || true
          exit $RESULT
```

- [ ] **Step 5.6: Extend the failure log dump**

In the final `Dump logs on failure` step, after the `=== Mimir logs ===` lines, add:

```yaml
          echo "=== Mimir (monolithic) logs ==="
          kubectl logs -l app.kubernetes.io/component=mimir --tail=100 2>/dev/null || true
          echo "=== MinIO logs ==="
          kubectl logs -l app.kubernetes.io/name=minio --tail=50 2>/dev/null || true
```

- [ ] **Step 5.7: Validate workflow syntax locally**

Run: `yq '.jobs.test.strategy.matrix' .github/workflows/test.yaml && yq '.jobs' .github/workflows/lint.yaml > /dev/null && echo OK`
Expected: prints the matrix (`mimir-mode: [monolithic, distributed]` as parsed YAML) then `OK`. (If `yq` is unavailable locally, `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/test.yaml')); yaml.safe_load(open('.github/workflows/lint.yaml')); print('OK')"`.)

- [ ] **Step 5.8: Commit**

```bash
git add .github/workflows/lint.yaml .github/workflows/test.yaml
git commit -m "ci: matrix e2e over monolithic/distributed Mimir with ingest+query regression test"
```

---

### Task 6: Local dev, docs, version bump

**Files:**
- Modify: `Tiltfile:47-85`
- Modify: `README.md`
- Modify: `chart/Chart.yaml` (version)
- Modify: `CLAUDE.md` (local only — gitignored, do NOT `git add`)

- [ ] **Step 6.1: Point Tilt at the monolithic workload**

In `Tiltfile`, replace the eight `k8s_resource(...)` blocks for `lgtm-pack-mimir-gateway`, `-distributor`, `-ingester`, `-querier`, `-query-frontend`, `-compactor`, `-store-gateway`, and `-query-scheduler` (lines 47-85) with a single block:

```python
k8s_resource(
    workload='lgtm-pack-mimir',
    labels=['mimir'],
)
```

- [ ] **Step 6.2: Update README**

In `README.md`:

a. Components table — replace the Mimir row:

```markdown
| **Mimir** | Metrics (Prometheus-compatible) | Monolithic (single-binary) |
```

b. Architecture diagram — replace the Mimir datasource line (`│    └── Mimir  → http://lgtm-pack-mimir-..   │`) with:

```
│    └── Mimir  → http://lgtm-pack-mimir:8080 │
```

and the push-endpoints Mimir line (`  └── Mimir  :80    /api/v1/push (Prometheus remote-write)`) with:

```
  └── Mimir  :8080  /api/v1/push (Prometheus remote-write)
```

c. Configuration table — add a row above the `mimir-distributed.*` row:

```markdown
| `mimir.*` | (this chart) | Monolithic Mimir — see `chart/values.yaml` |
```

d. Add a new section after the Configuration table (before "### Nebari Integration"):

```markdown
### Mimir deployment modes

Mimir runs **monolithic** by default: a single-binary StatefulSet (`-target=all`)
with filesystem storage on one PVC and compactor retention bounded at 30 days
(`mimir.retention`). This is the only topology where Mimir's filesystem storage
backend is valid.

For horizontal scale, switch to the **distributed** topology:

```bash
helm install lgtm-pack chart --set mimir-distributed.enabled=true
```

Distributed mode deploys the upstream `mimir-distributed` subchart backed by a
shared object store — bundled MinIO by default, or a real cloud bucket (see
the commented example under `mimir-distributed` in `chart/values.yaml`).
Filesystem storage is never used in distributed mode: with per-component PVCs
the compactor and store-gateway can't see the ingester's blocks, retention
never runs, and the ingester disk fills until ingestion halts
([issue #22](https://github.com/nebari-dev/lgtm-pack/issues/22)).

The Grafana datasource and OTel collector endpoints follow the mode
automatically.
```

(Note: the inner ```bash fence inside this section needs the outer fence in the README to be plain markdown — write the section directly into the file, not nested in another code fence.)

- [ ] **Step 6.3: Update local CLAUDE.md (do not commit)**

In `CLAUDE.md` (gitignored):
- Architecture section: note Mimir defaults to a chart-owned monolithic single-binary StatefulSet (`chart/templates/mimir/`); `mimir-distributed.enabled=true` opts into the subchart backed by bundled MinIO.
- Key Files: mention `chart/tests/assert-rendering.sh` as the template regression suite.

- [ ] **Step 6.4: Bump chart version**

In `chart/Chart.yaml`, change `version: 0.1.4` to `version: 0.2.0`.

- [ ] **Step 6.5: Final verification**

Run:

```bash
helm dependency update chart
bash chart/tests/assert-rendering.sh
helm lint chart --set nebariapp.enabled=false
helm lint chart --set nebariapp.enabled=false --set mimir-distributed.enabled=true
```

Expected: all pass.

- [ ] **Step 6.6: Commit (excluding CLAUDE.md)**

```bash
git add Tiltfile README.md chart/Chart.yaml
git commit -m "docs: document Mimir modes, update Tilt workloads, bump chart to 0.2.0"
```

---

### Post-implementation

- Push the branch and open a PR referencing https://github.com/nebari-dev/lgtm-pack/issues/22. PR body should note the release-notes caveat from the spec: existing distributed-mode installs' filesystem "blocks" are orphaned by this change (they were never queryable or compacted anyway); upgrading defaults installs to monolithic unless `mimir-distributed.enabled=true` is set.
- CI (lint + both e2e matrix legs) must be green before merge.
