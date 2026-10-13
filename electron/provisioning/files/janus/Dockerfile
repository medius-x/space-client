# OAK janus: default configs + token_auth = true + runtime-substituted admin_secret.
#
# Two stock files are customised (both dumped from the image and edited — see the diff vs
# janus.jcfg.sample / janus.transport.http.jcfg.sample):
#   - janus.jcfg: token_auth = true + admin_secret = "@JANUS_ADMIN_SECRET@" — a PLACEHOLDER
#     the entrypoint below overwrites with the JANUS_ADMIN_SECRET env var at container start
#     (compose passes it from env/.env). The secret is per-deployment and never baked into
#     the image or the repo: it guards the Admin API on :7088 (token minting!) AND is the
#     HMAC key oak-server derives every videoroom pin/secret from.
#   - janus.transport.http.jcfg: admin_http = true — MANDATORY: with token_auth (stored tokens)
#     and no Admin/monitor transport Janus fatals at startup ("No Admin/monitor transport is
#     available, but the stored token based authentication mechanism is enabled... giving up!",
#     exit 1 with empty logs — a live half-day hunt).
# Both are BAKED IN rather than bind-mounted so the whole gateway config travels with one
# rebuildable image (a bind-mounted janus.jcfg wedges janus on Docker Desktop file sharing).
# After editing either file: docker compose build janus.
FROM canyan/janus-gateway@sha256:80970d0b1c407222e2f88d7a6d31a16686fb9a5145a491b4b4d843ee40ee4ce1
COPY janus.jcfg /usr/local/etc/janus/janus.jcfg
COPY janus.transport.http.jcfg /usr/local/etc/janus/janus.transport.http.jcfg
# Fallback for bare `docker run` without compose: compose always overrides from .env.
ENV JANUS_ADMIN_SECRET=change-me-janus-admin
ENTRYPOINT ["/bin/sh", "-c", "sed -i \"s|@JANUS_ADMIN_SECRET@|${JANUS_ADMIN_SECRET}|g\" /usr/local/etc/janus/janus.jcfg && exec /usr/local/bin/janus"]
