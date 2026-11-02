import { describe, expect, it } from "vitest";
import {
  ProvisioningFailure,
  runProvisioningPipeline,
  type ProvisioningFiles,
  type ProvisioningStepEvent,
} from "../src/domain/provisioning/pipeline";
import type { ProvisioningParams } from "../src/domain/provisioning/params";
import { DEFAULT_ACCOUNT_LOGIN } from "../src/domain/provisioning/params";
import { FakeProvisioningTransport } from "./mocks/fake-provisioning-transport";

/** 64 hex chars — a full SHA-256 fingerprint, colon-separated as openssl prints it. */
const FINGERPRINT_HEX = "AABBCCDD".repeat(8);
const FINGERPRINT_OPENSSL = `sha256 Fingerprint=${FINGERPRINT_HEX.match(/.{2}/g)!.join(":")}\n`;

function baseParams(overrides: Partial<ProvisioningParams> = {}): ProvisioningParams {
  return {
    host: "203.0.113.10",
    sshPort: 22,
    sshLogin: "root",
    sshPassword: "ssh-secret",
    sshKeyPath: null,
    sshKeyPassphrase: null,
    domain: null,
    firewall: false,
    adminLogin: "admin",
    adminNickname: null,
    adminPassword: "hunter2222",
    jarPath: null,
    backupArchivePath: null,
    ...overrides,
  };
}

function baseFiles(): ProvisioningFiles {
  return {
    composeFile: "services:\n  postgres:\n    image: postgres:16-alpine\n  minio:\n    image: minio/minio:latest\n",
    dockerfileServer: "# dockerfile",
    janusDockerfile: "# janus dockerfile",
    janusConfig: "# janus config",
    janusHttpConfig: "# janus http config",
    caddyFileTemplate: "site {\n\ttls /certs/tls.crt /certs/tls.key # provisioning:tls-file\n}\n",
    jarOverridePath: null,
    jarBundledPath: "C:/bundled/oak-server.jar",
    kitVersion: "0.4.0",
    kit: "full",
    imageManifest: [],
    images: null,
  };
}

/** A two-image bundled set for the missing-image tests. */
const MINIO_REF = "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const POSTGRES_REF = "postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
function bundledImages(): NonNullable<ProvisioningFiles["images"]> {
  return {
    directory: "C:/bundled/images",
    manifest: [
      { ref: POSTGRES_REF, archive: "postgres.tar.gz", bytes: 61_000_000 },
      { ref: MINIO_REF, archive: "minio.tar.gz", bytes: 59_000_000 },
    ],
  };
}

/** Wires the happy-path server: Ubuntu with docker, no cert yet, fresh register. */
function scriptHappyPath(transport: FakeProvisioningTransport): void {
  transport.respond("uname -s", { stdout: "Linux\n" });
  transport.respond("/etc/os-release", { stdout: "Ubuntu 22.04.3 LTS\n" });
  transport.respond("docker --version", { stdout: "Docker version 24.0.7, compose v2.21.0\n" });
  transport.respond("test -f /opt/oak/caddy/certs/tls.crt", { stdout: "no\n" });
  transport.respond("openssl req", { stdout: "" });
  transport.respond("fingerprint -sha256", { stdout: FINGERPRINT_OPENSSL });
  // Host requirements (probe): 2 GB RAM + 512 MB provider swap, 40 GB disk,
  // no provider cgroup cap.
  transport.respond("df -Pm", { stdout: "40000\n" });
  transport.respond("/proc/meminfo", { stdout: "2048000\n524288\n" });
  transport.respond("memory.max", { stdout: "max\n" });
  transport.respond("seq 1 80", { stdout: "HTTP 401\n" });
  // The wire register returns the CREATED USER (no token) — the token comes
  // from the login right after it (AuthController).
  transport.respond("api/auth/register", {
    stdout: `{"id":1,"username":"admin","displayName":"admin"}\n__STATUS__201`,
  });
  transport.respond("api/auth/login", {
    stdout: `{"token":"jwt.access.value","refreshToken":"r","expiresAt":1}\n__STATUS__200`,
  });
  transport.respond("api/server/connection", { stdout: `{}\n__STATUS__200` });
}

const fixedRandomHex = (bytes: number): string => `x${bytes}`.padEnd(bytes * 2, "0");

function collectEvents(): { events: ProvisioningStepEvent[]; emit: (event: ProvisioningStepEvent) => void } {
  const events: ProvisioningStepEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

describe("provisioning pipeline", () => {
  it("deploys a fresh self-signed server end to end", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    expect(outcome.hostUrl).toBe("https://203.0.113.10");
    expect(outcome.certFingerprint).toBe(FINGERPRINT_HEX);
    expect(outcome.ownerReady).toBe(true);
    expect(outcome.adminUsername).toBe(DEFAULT_ACCOUNT_LOGIN);

    // Every stage reports start + done, in order (the system refresh runs in
    // the docker stage even when Docker is already present).
    const doneStages = events.filter((event) => event.state === "done").map((event) => event.stage);
    expect(doneStages).toEqual([
      "probe", "docker", "layout", "upload", "env", "certificate", "compose", "wait", "register",
    ]);

    // Docker was present — no installer, no firewall (params.firewall=false).
    expect(transport.commandWith("get.docker.com")).toBeNull();
    expect(transport.commandWith("ufw")).toBeNull();

    // The stack comes up with the full profile build, and dangling images
    // from earlier rebuilds are pruned (re-runs must not fill the disk).
    expect(transport.commandWith("docker compose up -d --build postgres")).toContain("cd /opt/oak");
    expect(transport.commandWith("docker compose up -d --build caddy")).not.toBeNull();
    expect(transport.commandWith("docker image prune -f")).not.toBeNull();

    // The certificate covers the public IP; the key comes from ecparam (the
    // portable form — see the live VPS note in the pipeline).
    expect(transport.commandWith("openssl ecparam")).toContain("prime256v1");
    const certCommand = transport.commandWith("openssl req");
    expect(certCommand).toContain("subjectAltName=DNS:localhost,IP:127.0.0.1,IP:203.0.113.10");

    // The .env carries fresh secrets and the raw IP for TURN.
    const envFile = transport.writeToFile("/opt/oak/.env");
    expect(envFile).toContain("TURN_EXTERNAL_IP=203.0.113.10");
    expect(envFile).toContain("OAK_PUBLIC_HOST=203.0.113.10");
    expect(envFile).toContain("JWT_SECRET=x32");
    expect(envFile).not.toContain("change-me");
    // One .env write only.
    expect(transport.writes.filter((write) => write.path === "/opt/oak/.env")).toHaveLength(1);

    // All template files land under /opt/oak.
    for (const path of [
      "/opt/oak/docker-compose.yml",
      "/opt/oak/Dockerfile.server",
      "/opt/oak/janus/Dockerfile",
      "/opt/oak/janus/janus.jcfg",
      "/opt/oak/janus/janus.transport.http.jcfg",
      "/opt/oak/caddy/Caddyfile",
      "/opt/oak/oak-server.jar",
    ]) {
      expect(transport.writes.some((write) => write.path === path)).toBe(true);
    }
    // The self-signed Caddyfile keeps its tls lines (marker included).
    expect(transport.writeToFile("/opt/oak/caddy/Caddyfile")).toContain("provisioning:tls-file");

    // Registration travels as a FILE, never on the command line.
    expect(transport.writeToFile("/opt/oak/.provision-register.json"))
      .toBe(JSON.stringify({ username: "admin", password: "hunter2222" }));
    const registerCommand = transport.commandWith("api/auth/register");
    expect(registerCommand).not.toContain("hunter2222");
    // The advertised address rides a PATCH with the registration's token.
    // The body matches UpdateConnectionInfoRequest's field names (a bare
    // host/scheme body is a silent no-op — live VPS 2026-10-13).
    expect(transport.writeToFile("/opt/oak/.provision-connection.json"))
      .toBe(JSON.stringify({ connectionHost: "203.0.113.10", connectionPort: 443, connectionScheme: "https" }));
    expect(transport.commandWith("api/server/connection")).toContain("Bearer jwt.access.value");
    // Every localhost curl carries the PUBLIC Host header: Caddy routes by
    // Host, and a bare "localhost" matches no site block — the poll would see
    // an empty 200 as readiness and register would read "HTTP 200" instead of
    // 201 (live VPS 2026-10-13: "registration failed (HTTP 200)").
    expect(transport.commandWith("seq 1 80")).toContain('-H "Host: 203.0.113.10"');
    // Proxy codes are NOT readiness — caddy answers 502 while oak still boots
    // (live: register raced into a 502 and failed).
    const pollCommandText = transport.commandWith("seq 1 80") ?? "";
    expect(pollCommandText).toContain('[ "$code" != "502" ]');
    expect(pollCommandText).toContain('[ "$code" != "503" ]');
    expect(pollCommandText).toContain('[ "$code" != "504" ]');
    expect(transport.commandWith("api/auth/register")).toContain('-H "Host: 203.0.113.10"');
    expect(transport.commandWith("api/server/connection")).toContain('-H "Host: 203.0.113.10"');
    // Temp bodies are cleaned up.
    expect(transport.commandWith("rm -f /opt/oak/.provision-register.json")).not.toBeNull();
  });

  it("updates the system and disables the background updater before anything else", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    const { events, emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    // The unattended updater is stopped AND disabled for good, the dpkg lock
    // is waited out, half-installed packages are repaired, and the dist-upgrade
    // runs BEFORE the stack (the OOM race, live 2026-10-13).
    expect(transport.commandWith("systemctl disable --now unattended-upgrades")).not.toBeNull();
    expect(transport.commandWith("fuser /var/lib/dpkg/lock-frontend")).not.toBeNull();
    expect(transport.commandWith("dpkg --configure -a")).not.toBeNull();
    const upgradeCommandIndex = transport.commands.findIndex((command) => command.includes("apt-get -y -qq dist-upgrade"));
    expect(upgradeCommandIndex).toBeGreaterThan(-1);
    expect(events.some((event) => event.stage === "docker" && event.state === "log"
      && (event.detail ?? "").includes("system packages updated"))).toBe(true);
    expect(events.some((event) => event.stage === "docker" && event.state === "done")).toBe(true);
  });

  it("installs docker when the server has none", async () => {
    const transport = new FakeProvisioningTransport();
    transport.respond("uname -s", { stdout: "Linux\n" });
    // Later registrations match first: the standalone post-install verify
    // succeeds while the combined probe fails.
    transport.respond("docker compose version", { stdout: "v2.21.0\n" });
    transport.respond("docker --version && docker compose version", { code: 1 });
    transport.respond("test -f /opt/oak/caddy/certs/tls.crt", { stdout: "no\n" });
    transport.respond("fingerprint -sha256", { stdout: FINGERPRINT_OPENSSL });
    transport.respond("seq 1 80", { stdout: "HTTP 401\n" });
    transport.respond("api/auth/register", { stdout: `{"id":1,"username":"admin"}\n__STATUS__201` });
    transport.respond("api/auth/login", { stdout: `{"token":"t"}\n__STATUS__200` });
    transport.respond("api/server/connection", { stdout: `{}\n__STATUS__200` });
    const { emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    expect(transport.commandWith("curl -fsSL https://get.docker.com | sh")).not.toBeNull();
    expect(transport.commandWith("systemctl enable --now docker")).not.toBeNull();
  });

  it("adopts an existing deployment without touching secrets or the certificate", async () => {
    const transport = new FakeProvisioningTransport();
    transport.files.set("/opt/oak/docker-compose.yml", "# existing deployment");
    scriptHappyPath(transport);
    // The existing certificate answers "yes" — the pipeline must READ it.
    transport.respond("test -f /opt/oak/caddy/certs/tls.crt", { stdout: "yes\n" });
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    expect(outcome.certFingerprint).toBe(FINGERPRINT_HEX);
    // Adopt: no regeneration (client pins survive), no fresh .env.
    expect(transport.commandWith("openssl req")).toBeNull();
    expect(transport.writes.some((write) => write.path === "/opt/oak/.env")).toBe(false);
    const layoutDone = events.find((event) => event.stage === "layout" && event.state === "done");
    expect(layoutDone?.detail).toContain("existing deployment");
    // Templates are still refreshed and the stack rebuilt.
    expect(transport.commandWith("docker compose up -d --build caddy")).not.toBeNull();
  });

  it("re-runs fall back to login when the admin password changed", async () => {
    const transport = new FakeProvisioningTransport();
    transport.files.set("/opt/oak/docker-compose.yml", "# existing deployment");
    scriptHappyPath(transport);
    transport.respond("test -f /opt/oak/caddy/certs/tls.crt", { stdout: "yes\n" });
    transport.respond("api/auth/register", { stdout: `{"message":"Username already exists"}\n__STATUS__409` });
    transport.respond("api/auth/login", { stdout: `{"error":"Bad credentials"}\n__STATUS__401` });
    const { emit } = collectEvents();

    const outcome = await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    expect(outcome.ownerReady).toBe(false);
    // No token → the advertised-address PATCH never runs.
    expect(transport.commandWith("api/server/connection")).toBeNull();
    expect(transport.writeToFile("/opt/oak/.provision-login.json"))
      .toBe(JSON.stringify({ username: "admin", password: "hunter2222" }));
  });

  it("adopts an existing account when the typed password logs in", async () => {
    const transport = new FakeProvisioningTransport();
    transport.files.set("/opt/oak/docker-compose.yml", "# existing deployment");
    scriptHappyPath(transport);
    transport.respond("test -f /opt/oak/caddy/certs/tls.crt", { stdout: "yes\n" });
    transport.respond("api/auth/register", { stdout: `{"message":"Username already exists"}\n__STATUS__409` });
    transport.respond("api/auth/login", { stdout: `{"token":"adopt.token"}\n__STATUS__200` });
    const { emit } = collectEvents();

    const outcome = await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    expect(outcome.ownerReady).toBe(true);
    expect(transport.commandWith("api/server/connection")).toContain("Bearer adopt.token");
  });

  it("rejects non-Linux hosts with a probe failure", async () => {
    const transport = new FakeProvisioningTransport();
    transport.respond("uname -s", { stdout: "Darwin\n" });
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex))
      .rejects.toBeInstanceOf(ProvisioningFailure);
    const failed = events.find((event) => event.state === "failed");
    expect(failed?.stage).toBe("probe");
    expect(failed?.detail).toContain("Linux");
  });

  it("refuses a host without enough disk space before any work starts", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // 1 GB free on / — under the 5 GB floor; the refusal must land BEFORE the
    // system-update stage burns a quarter of an hour.
    transport.respond("df -Pm", { stdout: "1024\n" });
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex))
      .rejects.toBeInstanceOf(ProvisioningFailure);
    const failed = events.find((event) => event.state === "failed");
    expect(failed?.stage).toBe("probe");
    expect(failed?.detail).toContain("disk space");
    expect(transport.commandWith("apt-get -y -qq dist-upgrade")).toBeNull();
  });

  it("refuses a host with too little RAM", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // 0.8 GB RAM — under the 1.2 GB floor (the stack OOM'd even on 2 GB
    // before the JVM limit and the swap guard existed).
    transport.respond("/proc/meminfo", { stdout: "800000\n0\n" });
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex))
      .rejects.toBeInstanceOf(ProvisioningFailure);
    const failed = events.find((event) => event.state === "failed");
    expect(failed?.stage).toBe("probe");
    expect(failed?.detail).toContain("not enough memory");
  });

  it("refuses a host whose provider caps memory below the floor", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // Advertised RAM passes, but the root cgroup limit is 1 GB — inside such
    // a VM the OOM killer looks exactly like missing RAM.
    transport.respond("memory.max", { stdout: "1000000\n" });
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex))
      .rejects.toBeInstanceOf(ProvisioningFailure);
    const failed = events.find((event) => event.state === "failed");
    expect(failed?.stage).toBe("probe");
    expect(failed?.detail).toContain("caps this machine's memory");
  });

  it("configures ufw with exactly the public ports when asked", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    const { emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams({ firewall: true, sshPort: 2222 }), baseFiles(), emit, fixedRandomHex);

    const ufwCommand = transport.commandWith("ufw --force enable");
    // The SSH port itself must stay open — including a non-standard one
    // (enabling ufw without it would lock the user out of the server).
    expect(ufwCommand).toContain("ufw allow 2222/tcp");
    expect(ufwCommand).not.toContain("ufw allow 22/tcp");
    expect(ufwCommand).toContain("ufw allow 443/tcp");
    expect(ufwCommand).toContain("ufw allow 9443/tcp");
    expect(ufwCommand).toContain("ufw allow 34780/tcp");
    expect(ufwCommand).toContain("ufw allow 2000:2300/udp");
    expect(ufwCommand).toContain("ufw allow 55000:55050/udp");
  });

  it("switches to ACME and the domain address on a domain deployment", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    const { emit } = collectEvents();

    const outcome = await runProvisioningPipeline(
      transport,
      baseParams({ domain: "oak.example.com" }),
      baseFiles(),
      emit,
      fixedRandomHex,
    );

    expect(outcome.hostUrl).toBe("https://oak.example.com");
    expect(outcome.certFingerprint).toBeNull();
    // No self-signed generation, no fingerprint read.
    expect(transport.commandWith("openssl req")).toBeNull();
    expect(transport.commandWith("fingerprint -sha256")).toBeNull();
    // The Caddyfile drops its tls lines (ACME takes over).
    expect(transport.writeToFile("/opt/oak/caddy/Caddyfile")).not.toContain("provisioning:tls-file");
    // The .env advertises the domain but TURN still pins the raw IP.
    const envFile = transport.writeToFile("/opt/oak/.env");
    expect(envFile).toContain("OAK_PUBLIC_HOST=oak.example.com");
    expect(envFile).toContain("TURN_EXTERNAL_IP=203.0.113.10");
    expect(transport.writeToFile("/opt/oak/.provision-connection.json"))
      .toBe(JSON.stringify({ connectionHost: "oak.example.com", connectionPort: 443, connectionScheme: "https" }));
  });

  it("fails the stage and reports the reason when a command exits non-zero", async () => {
    const transport = new FakeProvisioningTransport();
    transport.respond("uname -s", { stdout: "Linux\n" });
    transport.respond("docker --version", { stdout: "Docker version 24.0.7\n" });
    transport.respond("mkdir -p /opt/oak", { code: 1, stderr: "mkdir: cannot create directory '/opt/oak': Permission denied\n" });
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex))
      .rejects.toBeInstanceOf(ProvisioningFailure);
    const failed = events.find((event) => event.state === "failed");
    expect(failed?.stage).toBe("layout");
    expect(failed?.detail).toContain("Permission denied");
  });

  it("registers a custom Space account with its nickname", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    const { emit } = collectEvents();

    const outcome = await runProvisioningPipeline(
      transport,
      baseParams({ adminLogin: "oakmaster", adminNickname: "Владелец" }),
      baseFiles(),
      emit,
      fixedRandomHex,
    );

    expect(outcome.adminUsername).toBe("oakmaster");
    expect(transport.writeToFile("/opt/oak/.provision-register.json"))
      .toBe(JSON.stringify({ username: "oakmaster", password: "hunter2222", nickname: "Владелец" }));
  });

  it("creates a swap file on a low-memory host", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // 2 GB RAM, no swap — under the 3 GB floor.
    transport.respond("/proc/meminfo", { stdout: "2048000\n0\n" });
    transport.respond("docker image inspect", { stdout: "" });
    const { events, emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), { ...baseFiles(), imageManifest: bundledImages().manifest, images: bundledImages() }, emit, fixedRandomHex);

    const swapCommand = transport.commandWith("swapon /swapfile");
    expect(swapCommand).toContain("fallocate -l 2G /swapfile");
    expect(swapCommand).toContain("/etc/fstab");
    expect(events.some((event) => event.stage === "compose" && event.state === "log"
      && (event.detail ?? "").includes("swap file"))).toBe(true);
  });

  it("rebuilds a thin provider swap file to the full 2 GB", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // 2 GB RAM + the hosting provider's own 512 MB /swapfile — the guard must
    // REPLACE it, not skip on its existence (live VPS 2026-10-13: the 512 MB
    // sliver OOM'd the stack start).
    transport.respond("/proc/meminfo", { stdout: "2048000\n524288\n" });
    transport.respond("docker image inspect", { stdout: "" });
    const { events, emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), { ...baseFiles(), imageManifest: bundledImages().manifest, images: bundledImages() }, emit, fixedRandomHex);

    const swapCommand = transport.commandWith("swapon /swapfile");
    expect(swapCommand).toContain("swapoff /swapfile");
    expect(swapCommand).toContain("rm -f /swapfile");
    expect(swapCommand).toContain("fallocate -l 2G /swapfile");
    expect(events.some((event) => event.stage === "compose" && event.state === "log"
      && (event.detail ?? "").includes("swap file"))).toBe(true);
  });

  it("keeps a swap that is already thick enough", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // 1.3 GB RAM + 2 GB swap: the combined 3.3 GB sits above the 3 GB floor —
    // the guard must not touch the existing swap (the host pre-flight would
    // refuse anything thinner than 1.2 GB RAM these days).
    transport.respond("/proc/meminfo", { stdout: "1300000\n2048000\n" });
    transport.respond("docker image inspect", { stdout: "" });
    const { emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), { ...baseFiles(), imageManifest: bundledImages().manifest, images: bundledImages() }, emit, fixedRandomHex);

    expect(transport.commandWith("swapon")).toBeNull();
    expect(transport.commandWith("swapoff")).toBeNull();
  });

  it("skips the swap guard on a host with enough memory", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // 8 GB RAM — the guard must not fire.
    transport.respond("/proc/meminfo", { stdout: "8192000\n0\n" });
    transport.respond("docker image inspect", { stdout: "" });
    const { emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), { ...baseFiles(), imageManifest: bundledImages().manifest, images: bundledImages() }, emit, fixedRandomHex);

    expect(transport.commandWith("swapon")).toBeNull();
  });

  it("skips the registry entirely when the bundled images are already local", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // The missing-check prints nothing — every image is already on the host.
    transport.respond("docker image inspect", { stdout: "" });
    const { events, emit } = collectEvents();

    await runProvisioningPipeline(transport, { ...baseParams() }, { ...baseFiles(), imageManifest: bundledImages().manifest, images: bundledImages() }, emit, fixedRandomHex);

    expect(transport.commandWith("docker compose pull")).toBeNull();
    // The JAR still uploads (it always does) — no IMAGE archive may travel.
    expect(transport.commands.some((command) => command.startsWith("(writeLocalFile") && command.includes("images"))).toBe(false);
    expect(transport.commandWith("docker compose up -d --build caddy")).not.toBeNull();
    expect(events.some((event) => event.stage === "compose" && event.state === "log"
      && (event.detail ?? "").includes("registry is not needed"))).toBe(true);
  });

  it("pulls from the registry first — a healthy host never uploads archives", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    transport.respond("docker image inspect", { stdout: `MISSING ${MINIO_REF}\n` });
    const { events, emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), { ...baseFiles(), imageManifest: bundledImages().manifest, images: bundledImages() }, emit, fixedRandomHex);

    // The pull succeeded on the first round — no ladder, no image-archive uploads.
    expect(transport.commandWith(`docker pull '${MINIO_REF}'`)).not.toBeNull();
    expect(transport.commands.some((command) => command.startsWith("(writeLocalFile") && command.includes("images"))).toBe(false);
    expect(transport.commandWith("docker compose up -d --build caddy")).not.toBeNull();
    expect(events.some((event) => event.stage === "compose" && event.state === "log"
      && (event.detail ?? "").includes("pulled from the registry"))).toBe(true);
  });

  it("rescues a dead registry by deploying the MISSING images from the bundled set", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // minio missing on the host; every pull route fails (the live VPS saga:
    // Hub denies the IP, mirrors deny/404) — the bundled archive saves it.
    transport.respond("docker pull", { code: 1, stderr: "error from registry: denied\n" });
    transport.respondOnce("docker image inspect", { stdout: `MISSING ${MINIO_REF}\n` });
    const { events, emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), { ...baseFiles(), imageManifest: bundledImages().manifest, images: bundledImages() }, emit, fixedRandomHex);

    // Only minio's archive travelled; postgres (present) stayed home.
    expect(transport.writes.some((write) => write.path === "/opt/oak/images/minio.tar.gz"
      && write.contents.includes("minio.tar.gz"))).toBe(true);
    expect(transport.writes.some((write) => write.path === "/opt/oak/images/postgres.tar.gz")).toBe(false);
    expect(transport.commandWith("gunzip -c /opt/oak/images/minio.tar.gz | docker load")).not.toBeNull();
    expect(transport.commandWith("docker compose up -d --build caddy")).not.toBeNull();
    expect(events.some((event) => event.stage === "compose" && event.state === "log"
      && (event.detail ?? "").includes("bundled"))).toBe(true);
  });

  it("fails listing what is neither pullable nor bundled", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    transport.respond("docker pull", { code: 1, stderr: "i/o timeout\n" });
    // coturn is missing and NOT in the manifest — nothing can deliver it.
    transport.respond("docker image inspect", { stdout: "MISSING coturn/coturn@sha256:dead\n" });
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(transport, baseParams(), { ...baseFiles(), imageManifest: bundledImages().manifest, images: bundledImages() }, emit, fixedRandomHex))
      .rejects.toBeInstanceOf(ProvisioningFailure);
    const failed = events.find((event) => event.state === "failed");
    expect(failed?.stage).toBe("compose");
    expect(failed?.detail).toContain("neither pullable nor bundled");
    expect(failed?.detail).toContain("coturn/coturn@sha256:dead");
  });

  it("repairs a broken DNS and retries the failed image pulls", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // Both images missing; postgres fails the FIRST round (DNS), minio
    // succeeds right away; after the nameserver fix the retry lands postgres.
    transport.respond("docker image inspect", { stdout: "MISSING postgres:16-alpine\nMISSING minio/minio:latest\n" });
    transport.respondOnce("docker pull 'postgres:16-alpine'", { code: 1, stderr: "no such host\n" });
    transport.respond("getent hosts registry-1.docker.io", { stdout: "NO_DNS\n" });
    const { events, emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    expect(transport.commandWith("sed -i '1i nameserver 1.1.1.1'")).not.toBeNull();
    // postgres pulled twice (fail + retry), minio once — per-image pulls.
    expect(transport.commands.filter((command) => command === "docker pull 'postgres:16-alpine'")).toHaveLength(2);
    expect(transport.commands.filter((command) => command === "docker pull 'minio/minio:latest'")).toHaveLength(1);
    // No mirror step — the DNS fix was enough.
    expect(transport.commandWith("registry-mirrors")).toBeNull();
    expect(events.some((event) => event.stage === "compose" && event.state === "log"
      && (event.detail ?? "").includes("nameserver"))).toBe(true);
  });

  it("falls through mirrors and only then succeeds direct", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // postgres fails the direct round AND the mirrored round; the
    // mirrors-removed round succeeds. minio lands on the first try.
    transport.respond("docker image inspect", { stdout: "MISSING postgres:16-alpine\nMISSING minio/minio:latest\n" });
    transport.respondOnce("docker pull 'postgres:16-alpine'", { code: 1, stderr: "toomanyrequests\n" });
    transport.respondOnce("docker pull 'postgres:16-alpine'", { code: 1, stderr: "error from registry: denied\n" });
    transport.respond("getent hosts registry-1.docker.io", { stdout: "137.1.1.1 registry\n" });
    const { events, emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    // gcr leads the mirror list; the mirrors are then STRIPPED (both routes
    // failed) and the third round pulls direct.
    expect(transport.commandWith("registry-mirrors")).toContain("mirror.gcr.io");
    expect(transport.commandWith('data.pop("registry-mirrors", None)')).not.toBeNull();
    expect(transport.commands.filter((command) => command.includes("systemctl restart docker"))).toHaveLength(2);
    expect(transport.commands.filter((command) => command === "docker pull 'postgres:16-alpine'")).toHaveLength(3);
    expect(transport.commands.filter((command) => command === "docker pull 'minio/minio:latest'")).toHaveLength(1);
    // No DNS surgery on a host whose registry resolves.
    expect(transport.commandWith("sed -i")).toBeNull();
    expect(events.some((event) => event.stage === "compose" && event.state === "done")).toBe(true);
  });

  it("fails with the pull's real reason when the ladder cannot repair it", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    transport.respond("docker image inspect", { stdout: "MISSING postgres:16-alpine\n" });
    transport.respond("docker pull 'postgres:16-alpine'", { code: 1, stderr: "i/o timeout\n" });
    transport.respond("getent hosts registry-1.docker.io", { stdout: "137.1.1.1 registry\n" });
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex))
      .rejects.toBeInstanceOf(ProvisioningFailure);
    const failed = events.find((event) => event.state === "failed");
    expect(failed?.stage).toBe("compose");
    expect(failed?.detail).toContain("i/o timeout");
    expect(failed?.detail).toContain("postgres:16-alpine");
  });

  it("surfaces the server's error message when registration is rejected", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    transport.respond("api/auth/register", { stdout: `{"message":"Password must be 8 chars"}\n__STATUS__400` });
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex))
      .rejects.toBeInstanceOf(ProvisioningFailure);
    const failed = events.find((event) => event.state === "failed");
    expect(failed?.stage).toBe("register");
    expect(failed?.detail).toContain("Password must be 8 chars");
  });

  it("surfaces live progress: the jar byte counter and the command output line", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // The system upgrade "prints" one apt line — the docker step must surface
    // it as its progress text. (Match "dist-upgrade" only: the full command is
    // "apt-get -y -qq dist-upgrade" — "apt-get dist-upgrade" is not a
    // substring of it.)
    transport.respond("dist-upgrade", {
      stdout: "done\n",
      outputLines: ["Unpacking docker-ce (23 MB) over 1/1"],
    });
    const { events, emit } = collectEvents();

    await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    // The upload step carries the jar's REAL byte counter (the fake transport
    // reports 40/80 MB then 80/80; the throttled emitter keeps the first of a
    // same-millisecond burst).
    const uploadProgress = events.filter((event) => event.stage === "upload" && event.progress !== undefined);
    expect(uploadProgress.length).toBeGreaterThanOrEqual(1);
    expect(uploadProgress[0]!.progress).toContain("oak-server.jar");
    expect(uploadProgress[0]!.progress).toContain("50%");
    // A progress-only event must not wipe the step's standing description.
    expect(uploadProgress[0]!.detail).toBeUndefined();

    // The docker step surfaces the command's output line.
    const dockerProgress = events.find((event) => event.stage === "docker" && event.progress !== undefined);
    expect(dockerProgress?.progress).toContain("Unpacking docker-ce");

    // Completion clears the slot: done events carry no progress text.
    const uploadDone = events.find((event) => event.stage === "upload" && event.state === "done");
    expect(uploadDone?.progress).toBeUndefined();
  });

  // ── restore mode (backup round 2026-10-28) ────────────────────────────────

  it("restores a backup archive instead of registering an owner", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // The restore marker poll sees the runner's success line.
    transport.respond("RESTORE COMPLETED", { stdout: "COMPLETED\n" });
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(
      transport,
      baseParams({ backupArchivePath: "C:/Users/me/Downloads/SPACE/backup/server-backup-host-1.zip" }),
      baseFiles(),
      emit,
      fixedRandomHex,
    );

    // The finish is a MANUAL login: accounts come from the archive.
    expect(outcome.restored).toBe(true);
    expect(outcome.ownerReady).toBe(false);

    // Stage order: restore replaces register entirely.
    const doneStages = events.filter((event) => event.state === "done").map((event) => event.stage);
    expect(doneStages).toEqual([
      "probe", "docker", "layout", "upload", "env", "certificate", "compose", "restore", "wait",
    ]);
    expect(events.some((event) => event.stage === "register")).toBe(false);

    // oak does NOT start with the stack — its first boot IS the restore.
    expect(transport.commandWith("docker compose up -d --build oak")).toContain("cd /opt/oak");
    const composeOakCommands = transport.commands.filter((command) => command.includes("docker compose up -d --build oak"));
    expect(composeOakCommands).toHaveLength(1); // the restore step's own bring-up only

    // The archive rides the same streaming path as the jar, into ./restore.
    expect(transport.writes.some((write) =>
      write.path === "/opt/oak/restore/backup.zip"
      && write.contents.includes("server-backup-host-1.zip"))).toBe(true);

    // The .env arms the one-shot restore and rewrites the advertised address.
    const envFile = transport.writeToFile("/opt/oak/.env");
    expect(envFile).toContain("OAK_RESTORE_FILE=/restore/backup.zip");
    expect(envFile).toContain("OAK_RESTORE_PUBLIC_HOST=203.0.113.10");
    expect(envFile).toContain("OAK_RESTORE_PUBLIC_PORT=443");

    // The marker poll watches oak-server's log.
    expect(transport.commandWith("docker logs --tail 300 oak-server")).not.toBeNull();
  });

  it("fails the restore step with the server's own reason when the marker says FAILED", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // Later registrations win: the marker poll reports the runner's failure.
    transport.respond("RESTORE FAILED", {
      code: 1,
      stdout: "[restore] RESTORE FAILED: backup schema version '16' does not match this server's schema version '17'\n",
    });
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(
      transport,
      baseParams({ backupArchivePath: "C:/backups/old.zip" }),
      baseFiles(),
      emit,
      fixedRandomHex,
    )).rejects.toThrow(ProvisioningFailure);

    const failure = events.find((event) => event.state === "failed");
    expect(failure?.stage).toBe("restore");
  });

  it("refuses a restore onto an adopted (already deployed) server", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // An existing compose file makes the layout step an ADOPT.
    transport.files.set("/opt/oak/docker-compose.yml", "services: {}");
    const { emit } = collectEvents();

    await expect(runProvisioningPipeline(
      transport,
      baseParams({ backupArchivePath: "C:/backups/archive.zip" }),
      baseFiles(),
      emit,
      fixedRandomHex,
    )).rejects.toThrow(ProvisioningFailure);
  });

  // ── connection-loss resume ladder (live 2026-10-28: a network drop 50 s into
  // a dist-upgrade killed the run while the server-side apt kept running) ────
  const instantSleep = async (): Promise<void> => undefined;

  it("resumes an interrupted dist-upgrade after the connection drops", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    transport.dropNextExec("dist-upgrade");
    // The ghost check must report NO surviving package manager (the fake's
    // unmatched default is code 0 = "alive" — which would loop the wait).
    transport.respond("pgrep", { code: 1 });
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(
      transport, baseParams(), baseFiles(), emit, fixedRandomHex, undefined, instantSleep,
    );

    expect(outcome.ownerReady).toBe(true);
    expect(transport.reconnects).toBe(1);
    // The interrupted apt command ran twice (drop + idempotent re-run), and the
    // ghost check preceded the re-run.
    expect(transport.commands.filter((command) => command.includes("dist-upgrade"))).toHaveLength(2);
    expect(transport.commandWith("pgrep")).not.toBeNull();
    // The resume is VISIBLE, not a silent miracle.
    const reconnectLine = events.find((event) => event.state === "log"
      && event.detail !== undefined && event.detail.includes("reconnecting"));
    expect(reconnectLine?.stage).toBe("docker");
  });

  it("waits out a ghost package manager before re-running the interrupted apt command", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    transport.dropNextExec("dist-upgrade");
    // First ghost poll sees apt alive, the rest see it gone (later
    // registrations are checked FIRST, so the one-shot must be registered
    // AFTER the baseline to take precedence).
    transport.respond("pgrep", { code: 1 });
    transport.respondOnce("pgrep", { code: 0 });
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(
      transport, baseParams(), baseFiles(), emit, fixedRandomHex, undefined, instantSleep,
    );

    expect(outcome.ownerReady).toBe(true);
    expect(transport.commands.filter((command) => command.includes("dist-upgrade"))).toHaveLength(2);
    const ghostLine = events.find((event) => event.state === "log"
      && event.detail !== undefined && event.detail.includes("package operation"));
    expect(ghostLine?.stage).toBe("docker");
  });

  it("fails with its own message after the reconnect budget is exhausted", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // Four drops: three resumed attempts, the fourth exhausts the budget.
    for (let dropIndex = 0; dropIndex < 4; dropIndex += 1) {
      transport.dropNextExec("dist-upgrade");
    }
    transport.respond("pgrep", { code: 1 });
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(
      transport, baseParams(), baseFiles(), emit, fixedRandomHex, undefined, instantSleep,
    )).rejects.toThrow(ProvisioningFailure);

    expect(transport.reconnects).toBe(3);
    const failure = events.find((event) => event.state === "failed");
    expect(failure?.stage).toBe("docker");
    expect(failure?.detail).toContain("kept dropping");
  });

  it("resumes an interrupted archive upload without waiting for package managers", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // The JAR upload loses the connection once — the retry re-uploads from
    // scratch (an idempotent overwrite), no ghost check involved.
    transport.localUploadDrops = 1;
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(
      transport, baseParams(), baseFiles(), emit, fixedRandomHex, undefined, instantSleep,
    );

    expect(outcome.ownerReady).toBe(true);
    expect(transport.commands.filter((command) => command.includes("(writeLocalFile C:/bundled/oak-server.jar)")))
      .toHaveLength(2);
    expect(transport.reconnects).toBe(1);
    expect(transport.commandWith("pgrep")).toBeNull();
  });

  // ── The unified big-content ladder (user decision 2026-11-02) ────────────
  // The server pulls the jar and the missing image tail from GitHub ITSELF
  // whenever it can; the client's home link joins the byte path last.

  it("lets the server download the jar from GitHub — no home-link bytes", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // The probe answers with the final hop's length; the very first poll
    // reports a complete file (the transfer already finished).
    transport.respond("curl -fsSIL", { code: 0, stdout: "Content-Length: 79999999\n" });
    transport.respond("/opt/oak/oak-server.jar", { code: 0, stdout: "79999999 0 4242\n" });
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    expect(outcome.ownerReady).toBe(true);
    // The detached transfer runs on the server (setsid + redirected stdio),
    // the size is polled by stat, and the bundled jar NEVER travels over SFTP.
    expect(transport.commandWith("setsid sh -c")).toContain("curl -fsS -C -");
    expect(transport.commandWith("setsid sh -c")).toContain("</dev/null >/dev/null");
    expect(transport.commandWith("stat -c %s")).toContain("/opt/oak/oak-server.jar");
    expect(transport.commands.some((command) => command.startsWith("(writeLocalFile"))).toBe(false);
    expect(events.some((event) => event.stage === "upload" && event.state === "log"
      && (event.detail ?? "").includes("downloading the server jar from GitHub"))).toBe(true);
    // The GitHub URL carries the version TAG, never "latest".
    expect(transport.commandWith("curl -fsSIL")).toContain("/releases/download/v0.4.0/oak-server.jar");
  });

  it("falls back to the bundled jar when the server cannot reach GitHub", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // No scripted probe: the fake's default empty answer has no usable
    // Content-Length — an unverifiable probe counts as NOT reachable.
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(transport, baseParams(), baseFiles(), emit, fixedRandomHex);

    expect(outcome.ownerReady).toBe(true);
    expect(transport.commandWith("setsid sh -c")).toBeNull();
    expect(transport.commands.some((command) => command.includes("(writeLocalFile C:/bundled/oak-server.jar)"))).toBe(true);
    expect(events.some((event) => event.stage === "upload" && event.state === "log"
      && (event.detail ?? "").includes("through this computer"))).toBe(false);
  });

  it("downloads the jar through the client as the light kit's last resort", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    const downloads: string[] = [];
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(
      transport, baseParams(), { ...baseFiles(), jarBundledPath: null, kit: "light" },
      emit, fixedRandomHex, undefined, instantSleep,
      (url) => {
        downloads.push(url);
        return Promise.resolve("C:/temp/space-provisioning-jar.jar");
      },
    );

    expect(outcome.ownerReady).toBe(true);
    expect(downloads).toEqual(["https://github.com/medius-x/oak-server/releases/download/v0.4.0/oak-server.jar"]);
    expect(transport.commands.some((command) => command.includes("(writeLocalFile C:/temp/space-provisioning-jar.jar)"))).toBe(true);
    expect(events.some((event) => event.stage === "upload" && event.state === "log"
      && (event.detail ?? "").includes("through this computer"))).toBe(true);
  });

  it("restarts a dead server-side transfer twice, then falls back to the bundled jar", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    transport.respond("curl -fsSIL", { code: 0, stdout: "Content-Length: 79999999\n" });
    // Every poll sees a DEAD transfer with an empty file — the bounded
    // restarts run out and the ladder falls through to the local jar.
    transport.respond("/opt/oak/oak-server.jar", { code: 0, stdout: "0 0 1\n" });
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(
      transport, baseParams(), baseFiles(), emit, fixedRandomHex, undefined, instantSleep,
    );

    expect(outcome.ownerReady).toBe(true);
    // The initial ensure-start plus the two manual restarts.
    expect(transport.commands.filter((command) => command.includes("setsid sh -c"))).toHaveLength(3);
    // The failure's cause is read from the transfer's log file.
    expect(transport.commandWith("tail -3")).toContain("space-dl-oak-server.jar.log");
    expect(transport.commands.some((command) => command.includes("(writeLocalFile C:/bundled/oak-server.jar)"))).toBe(true);
    expect(events.some((event) => event.stage === "upload" && event.state === "log"
      && (event.detail ?? "").includes("did not complete"))).toBe(true);
  });

  it("lets the server download the MISSING image tail from GitHub when the registry is dead", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // minio missing on the host; every pull route fails — but GitHub answers.
    transport.respond("docker pull", { code: 1, stderr: "error from registry: denied\n" });
    transport.respondOnce("docker image inspect", { stdout: `MISSING ${MINIO_REF}\n` });
    transport.respond("curl -fsSIL", { code: 0, stdout: "Content-Length: 59000000\n" });
    transport.respond("/opt/oak/oak-server.jar", { code: 0, stdout: "79999999 0 4242\n" });
    transport.respond("/opt/oak/images/minio.tar.gz", { code: 0, stdout: "59000000 0 777\n" });
    transport.respond("docker load", { stdout: "Loaded image\n" });
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(
      transport, baseParams(), { ...baseFiles(), imageManifest: bundledImages().manifest, images: bundledImages() },
      emit, fixedRandomHex,
    );

    expect(outcome.ownerReady).toBe(true);
    // Only minio ran through the GitHub leg (the MISSING-tail rule); the
    // bundled archive never travelled over SFTP.
    expect(transport.commandWith("gunzip -c /opt/oak/images/minio.tar.gz | docker load")).not.toBeNull();
    expect(transport.commands.some((command) => command.includes("setsid sh -c") && command.includes("/opt/oak/images/minio.tar.gz"))).toBe(true);
    // A foreign partial is cleared before the transfer (an exact-size leftover
    // is kept — curl -C - finishes it).
    expect(transport.commands.some((command) => command.includes('!= 59000000') && command.includes("rm -f '/opt/oak/images/minio.tar.gz'"))).toBe(true);
    expect(transport.commands.some((command) => command.startsWith("(writeLocalFile") && command.includes("images"))).toBe(false);
    expect(events.some((event) => event.stage === "compose" && event.state === "log"
      && (event.detail ?? "").includes("downloaded from GitHub"))).toBe(true);
    // The bundled rescue never ran — the GitHub leg delivered the tail.
    expect(events.some((event) => event.stage === "compose" && event.state === "log"
      && (event.detail ?? "").includes("bundled"))).toBe(false);
  });

  it("delivers the missing tail through the client when this light build has no bundled archives", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // The registry is dead AND the server-side GitHub leg is unreachable
    // (no scripted probe) — the light kit's terminal stage joins in: the
    // client downloads the archive and uploads it over SFTP.
    transport.respond("docker pull", { code: 1, stderr: "error from registry: denied\n" });
    transport.respondOnce("docker image inspect", { stdout: `MISSING ${MINIO_REF}\n` });
    transport.respond("docker load", { stdout: "Loaded image\n" });
    const downloads: string[] = [];
    const { events, emit } = collectEvents();

    const outcome = await runProvisioningPipeline(
      transport, baseParams(),
      { ...baseFiles(), kit: "light", imageManifest: bundledImages().manifest, images: null },
      emit, fixedRandomHex, undefined, instantSleep,
      (url) => {
        downloads.push(url);
        return Promise.resolve(`C:/temp/space-kit-${url.split("/").pop()}`);
      },
    );

    expect(outcome.ownerReady).toBe(true);
    expect(downloads).toEqual(["https://github.com/medius-x/oak-server/releases/download/v0.4.0/minio.tar.gz"]);
    expect(transport.commands.some((command) => command.includes("(writeLocalFile C:/temp/space-kit-minio.tar.gz)"))).toBe(true);
    expect(transport.commandWith("gunzip -c /opt/oak/images/minio.tar.gz | docker load")).not.toBeNull();
    expect(events.some((event) => event.stage === "compose" && event.state === "log"
      && (event.detail ?? "").includes("through this computer"))).toBe(true);
    expect(events.some((event) => event.stage === "compose" && event.state === "log"
      && (event.detail ?? "").includes("bundled"))).toBe(false);
  });

  it("fails a light run honestly when no delivery route exists at all", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    transport.respond("docker pull", { code: 1, stderr: "error from registry: denied\n" });
    transport.respondOnce("docker image inspect", { stdout: `MISSING ${MINIO_REF}\n` });
    // No bundled archives AND no client downloader — nothing can deliver.
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(
      transport, baseParams(),
      { ...baseFiles(), kit: "light", imageManifest: bundledImages().manifest, images: null },
      emit, fixedRandomHex, undefined, instantSleep,
    )).rejects.toThrow(ProvisioningFailure);

    const failure = events.find((event) => event.state === "failed");
    expect(failure?.stage).toBe("compose");
    expect(failure?.detail).toContain("full-bundle installer");
  });

  // ── The direct server-to-server migration leg (2026-11-02) ────────────────

  it("pulls the migration archive from the old server on the one-shot token", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // The transfer poll reports a complete file right away.
    transport.respond("/opt/oak/restore/backup.zip", { code: 0, stdout: "12345 0 999\n" });
    transport.respond("docker logs", { stdout: "[restore] RESTORE COMPLETED — 5 statement(s), 0 object(s)\n" });
    const { events, emit } = collectEvents();
    const migrationTransfer = {
      sourceUrl: "https://old.example.com",
      token: "t".repeat(43),
      archiveSha256: "a".repeat(64),
      archiveBytes: 12345,
      certificatePem: "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n",
    };

    const outcome = await runProvisioningPipeline(
      transport, baseParams({ migrationTransfer }), baseFiles(), emit, fixedRandomHex,
    );

    // The finish phase is needsLogin (restored), never an automatic login.
    expect(outcome.restored).toBe(true);
    expect(outcome.ownerReady).toBe(false);
    // The token rides a 0600 FILE (never a command line — ps would see it), the
    // pinned CA rides as the curl CA, and the URL is the token-gated endpoint.
    expect(transport.writeToFile("/opt/oak/transfer/.migration-auth"))
      .toBe(`X-Space-Migration-Token: ${"t".repeat(43)}\n`);
    expect(transport.writeToFile("/opt/oak/transfer/old-ca.pem")).toContain("BEGIN CERTIFICATE");
    const transferCommand = transport.commands.find((command) => command.includes("setsid sh -c")
      && command.includes("transfer/file"));
    expect(transferCommand).toContain("--cacert");
    expect(transferCommand).toContain("/opt/oak/transfer/old-ca.pem");
    expect(transferCommand).toContain("-H @");
    expect(transferCommand).toContain("/opt/oak/transfer/.migration-auth");
    expect(transferCommand).toContain("https://old.example.com/api/server/backup/transfer/file");
    // The transferred bytes are verified against the issued digest.
    expect(transport.commandWith("sha256sum -c")).toContain("a".repeat(64));
    // The credential files are scrubbed when the leg ends.
    expect(transport.commandWith("rm -f /opt/oak/transfer/.migration-auth /opt/oak/transfer/old-ca.pem")).not.toBeNull();
    // No archive ever travelled over SFTP (only the jar did).
    expect(transport.commands.some((command) => command.includes("(writeLocalFile") && command.includes("backup.zip"))).toBe(false);
    expect(events.some((event) => event.stage === "restore" && event.state === "log"
      && (event.detail ?? "").includes("straight from the old one"))).toBe(true);
  });

  it("refuses a direct transfer onto an adopted server, like a local restore", async () => {
    const transport = new FakeProvisioningTransport();
    scriptHappyPath(transport);
    // An existing compose file flips the layout check to adopt.
    transport.files.set("/opt/oak/docker-compose.yml", "services: {}");
    const { events, emit } = collectEvents();

    await expect(runProvisioningPipeline(
      transport, baseParams({ migrationTransfer: {
        sourceUrl: "https://old.example.com",
        token: "t".repeat(43),
        archiveSha256: "a".repeat(64),
        archiveBytes: 12345,
        certificatePem: null,
      } }),
      baseFiles(), emit, fixedRandomHex,
    )).rejects.toThrow(ProvisioningFailure);

    const failure = events.find((event) => event.state === "failed");
    expect(failure?.stage).toBe("layout");
  });
});
