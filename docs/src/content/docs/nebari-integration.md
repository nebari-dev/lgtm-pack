---
title: Nebari integration
description: Give Grafana a hostname, Keycloak SSO, and a Nebari landing-page tile.
---

With `nebariapp.enabled: true` (the default), the chart renders a `NebariApp` resource.
The [nebari-operator](https://github.com/nebari-dev/nebari-operator) turns it into an
HTTPRoute, a TLS certificate, a Keycloak client, and — optionally — a tile on the Nebari
landing page.

:::caution[`hostname` is required]
`nebariapp.hostname` has no default. With `nebariapp.enabled: true` and no hostname, the
chart fails to render:
`nebariapp.hostname is required when nebariapp.enabled is true`. Set it, or install with
`--set nebariapp.enabled=false`.
:::

## Minimum configuration

```yaml
nebariapp:
  enabled: true
  hostname: grafana.example.com
  keycloakHostname: keycloak.example.com
```

The namespace must also be opted into Nebari management, or the operator ignores the
resource:

```bash
kubectl label namespace monitoring nebari.dev/managed=true
```

Under Argo CD, `syncPolicy.managedNamespaceMetadata` applies that label for you — see
[Deploying with Argo CD](/deployment/).

## What the `NebariApp` points at

By default it targets the Grafana service created by the subchart:

| Value | Default | Purpose |
|---|---|---|
| `nebariapp.service.name` | `<release>-grafana` | Backend service. |
| `nebariapp.service.port` | `80` | Service port (Grafana's container port is 3000). |
| `nebariapp.routing.routes` | `[{ pathPrefix: / }]` | Grafana owns the whole host. |

## Keycloak OAuth

When `nebariapp.auth.enabled` is true and `keycloakHostname` is set, the chart renders a
`grafana-oauth-config` ConfigMap carrying every `GF_AUTH_GENERIC_OAUTH_*` variable, and
Grafana consumes it via `envFromConfigMaps` (marked `optional: true`, so a release without
Keycloak just falls back to local accounts). The client secret is read from the
`<fullname>-oidc-client` Secret that the operator creates when it provisions the client.

| Value | Default | Purpose |
|---|---|---|
| `nebariapp.auth.enabled` | `true` | Provision a Keycloak client and turn on Grafana OAuth. |
| `nebariapp.auth.provider` | `keycloak` | Identity provider. |
| `nebariapp.auth.provisionClient` | `true` | Let the operator create the client. Set false and supply `auth.clientSecretRef` to bring your own. |
| `nebariapp.auth.enforceAtGateway` | `false` | Keep gateway enforcement off — see below. |
| `nebariapp.auth.redirectURI` | `/login/generic_oauth` | Grafana's OAuth callback path. |
| `nebariapp.auth.scopes` | `openid, profile, email, groups` | Requested scopes. |
| `nebariapp.auth.groups` | `admin, viewer` | Groups created in the realm. |
| `nebariapp.keycloakHostname` | — | Keycloak host. Required when auth is on. |
| `nebariapp.keycloakRealm` | `nebari` | Realm name. |
| `nebariapp.keycloakBasePath` | `""` | Set to `/auth` for legacy Keycloak (< v17). |

### Why gateway enforcement stays off

`enforceAtGateway: false` is deliberate. Grafana runs its own OIDC flow, so an Envoy
Gateway `SecurityPolicy` in front of it would authenticate the user a second time and
interfere with the `/login/generic_oauth` callback. Auth is enforced *inside* Grafana,
which is also what makes role mapping possible.

### Roles

Grafana derives its role from the `groups` claim with a single JMESPath expression:

```
contains(groups[*], 'admin') && 'Admin' || 'Viewer'
```

Members of `admin` become Grafana Admins; everyone else is a Viewer. `AUTO_LOGIN` is on,
so users land on Keycloak rather than Grafana's own login form, and `ALLOW_SIGN_UP` is on,
so first-time realm users get a Grafana account created for them.

### Group membership

`nebariapp.auth.keycloakConfig.groups` seeds membership. The default puts the `admin` user
in the `admin` group:

```yaml
nebariapp:
  auth:
    keycloakConfig:
      groups:
        - name: admin
          members: [admin]
        - name: viewer
          members: [alice, bob]
```

Groups named in `auth.groups` but absent from `keycloakConfig.groups` are appended
automatically with no members. A `group-membership` protocol mapper
(`oidc-group-membership-mapper`, claim `groups`, `full.path: false`) is injected
automatically whenever groups are configured and you have not supplied your own
`keycloakConfig.protocolMappers` — without it the `groups` claim never reaches Grafana and
everyone is a Viewer.

## Landing-page tile

Off by default. Turn it on to give Grafana a card on the Nebari landing page:

```yaml
nebariapp:
  landingPage:
    enabled: true
```

| Value | Default |
|---|---|
| `displayName` | `Grafana` |
| `description` | `Metrics, logs, and traces observability platform` |
| `icon` | `https://grafana.com/static/img/menu/grafana2.svg` |
| `category` | `Observability` |
| `priority` | `10` (lower sorts first, 0–1000) |
| `externalUrl` | unset — derived from `hostname` |
| `healthCheck.enabled` | `true` |
| `healthCheck.path` | `/api/health` |
| `healthCheck.intervalSeconds` | `30` (10–300) |
| `healthCheck.timeoutSeconds` | `5` (1–30) |

This requires a nebari-operator build with `LandingPageConfig` support.

## Exposing the push endpoints

By default only Grafana is routed. To make Loki, Tempo, or Mimir reachable from outside the
cluster — for an external agent shipping telemetry in — add them as
`additionalServices`:

```yaml
nebariapp:
  additionalServices:
    - name: loki-push
      service: { name: lgtm-pack-loki, port: 3100 }
      routing:
        routes:
          - pathPrefix: /loki
            pathType: Prefix
    - name: tempo-push
      service: { name: lgtm-pack-tempo, port: 4318 }
      routing:
        routes:
          - pathPrefix: /tempo
            pathType: Prefix
    - name: mimir-push
      service: { name: lgtm-pack-mimir, port: 8080 }   # distributed: -mimir-gateway, port 80
      routing:
        routes:
          - pathPrefix: /mimir
            pathType: Prefix
```

:::caution[These endpoints have no tenant isolation]
Loki runs with `auth_enabled: false` and Mimir with `multitenancy_enabled: false`. Anything
that can reach a push endpoint can write to the single tenant — and, on the read paths,
query it. Put authentication in front of any route you expose beyond the cluster.
:::

## Verifying

```bash
kubectl -n monitoring get nebariapp
kubectl -n monitoring describe nebariapp lgtm-pack

# The operator writes the client secret here once the Keycloak client exists
kubectl -n monitoring get secret lgtm-pack-oidc-client

# What Grafana actually received
kubectl -n monitoring get cm grafana-oauth-config -o yaml
```

If Grafana shows its local login form instead of redirecting to Keycloak, the usual cause
is a missing `keycloakHostname` — the OAuth ConfigMap is not rendered at all in that case,
and the `optional: true` mount means Grafana starts anyway with no indication of what is
wrong.

## Disabling Nebari integration

```bash
helm install lgtm-pack nebari/nebari-lgtm-pack --set nebariapp.enabled=false
```

No `NebariApp`, no OAuth ConfigMap. Reach Grafana by port-forward or your own Ingress, and
sign in with `grafana.adminUser` / `grafana.adminPassword`.
