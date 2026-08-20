---
title: Deploying on Nebari
description: GitOps deployment of the Nebari LGTM Pack on a Nebari cluster.
---

On a GitOps-managed Nebari cluster, deploy the pack by applying an Argo CD `Application`
that sources the chart from the Nebari Helm repository. Two ready-to-edit manifests live in
[`examples/argocd-application.yaml`](https://github.com/nebari-dev/lgtm-pack/blob/main/examples/argocd-application.yaml)
— one per [Mimir deployment mode](/mimir-modes/).

:::caution[The example file holds two alternatives]
Both documents describe the *same* release. Applying the file as-is would deploy only the
last one. Copy the one you want into its own file first.
:::

## The manifest

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: lgtm-pack
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: nebari-packs
    app.kubernetes.io/managed-by: nebari-infrastructure-core
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default

  source:
    chart: nebari-lgtm-pack
    repoURL: https://raw.githubusercontent.com/nebari-dev/helm-repository/gh-pages/
    targetRevision: 0.2.0
    helm:
      releaseName: lgtm-pack
      values: |
        nebariapp:
          hostname: grafana.example.com
          keycloakHostname: keycloak.example.com

  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring

  syncPolicy:
    managedNamespaceMetadata:
      labels:
        nebari.dev/managed: "true"
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: 5
      backoff: { duration: 5s, factor: 2, maxDuration: 3m }
```

Set `nebariapp.hostname` and `nebariapp.keycloakHostname` to your cluster's values, then:

```bash
kubectl apply -f my-lgtm-application.yaml
```

## What each part is doing

**`targetRevision`** pins a published chart version. Leave it pinned; `*` would let a chart
release roll the whole observability stack unannounced.

**`managedNamespaceMetadata`** applies `nebari.dev/managed: "true"` to the destination
namespace. The nebari-operator only reconciles `NebariApp` resources in labeled namespaces,
so without this the `NebariApp` is created and then ignored — Grafana never gets a route.

**`CreateNamespace=true`** is what makes `managedNamespaceMetadata` take effect; together
they are how the namespace gets created *and* opted in without a separate manifest.

**`ServerSideApply=true`** matters because the Grafana subchart renders large dashboard
ConfigMaps. Client-side apply stores the full resource in the
`last-applied-configuration` annotation and can exceed the 256KB annotation limit.

**`prune: true` and `selfHeal: true`** mean Argo CD removes resources you delete from the
chart and reverts manual `kubectl edit`s. Expect drift to be undone.

## Distributed Mimir

Same manifest, one extra values block:

```yaml
      values: |
        nebariapp:
          hostname: grafana.example.com
          keycloakHostname: keycloak.example.com
        mimir-distributed:
          enabled: true
```

Enabling it suppresses the monolithic StatefulSet and re-points the Grafana datasource and
the OTel collector override at the gateway automatically. The bundled MinIO ships
development-grade defaults — read [Mimir deployment modes](/mimir-modes/) before running
this in production.

## Sync ordering

The chart's post-install hook rolls NIC's OTel collector DaemonSet, and it tolerates
arriving before NIC has reconciled the collector: the Job waits up to five minutes for the
DaemonSet to exist before failing. So there is no ordering constraint between this
Application and NIC's own — install in either order.

## Verifying the sync

```bash
kubectl -n argocd get application lgtm-pack
argocd app get lgtm-pack

# The namespace label the operator depends on
kubectl get namespace monitoring -o jsonpath='{.metadata.labels}'

# The route the operator produced
kubectl -n monitoring get nebariapp,httproute
```

## Upgrading

Bump `targetRevision` and commit. With `automated` sync on, Argo CD applies it; otherwise
sync manually. Helm hooks run on upgrade too, so the collector DaemonSet is rolled again
and picks up any endpoint change — which is what makes switching Mimir modes a one-line
values edit.

Note that switching modes does not migrate metrics data between the PVC and the object
store. See [Mimir deployment modes](/mimir-modes/).
