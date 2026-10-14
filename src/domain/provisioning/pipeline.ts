/**
 * The provisioning pipeline (round C): everything a fresh Ubuntu server needs
 * to become a running OAK deployment — Docker, /opt/oak with the compose
 * stack, per-deployment secrets, a TLS certificate, a firewall and the OWNER
 * account — driven over SSH from the client's main process.
 *
 * The pipeline is a PURE function of its seams: the transport (exec/writeFile/
 * readFile — ssh2 in production, a scriptable fake in tests), the file
 * templates and the random source. The caller (electron/provisioning.ts) owns
 * connecting, the jar bytes, the TOFU pin registration and the IPC events.
 *
 * Idempotency contract: a live /opt/oak/docker-compose.yml switches the run
 * into ADOPT mode — templates are refreshed and the stack is rebuilt, but the
 * .env secrets and the self-signed certificate are NEVER touched (client pins
 * survive), and `docker compose down -v` is never run.
 */
import { buildEnvFile, generateEnvSecrets, type RandomHexSource } from "./env-file";
import type { ProvisioningParams } from "./params";
import {
  caddyFileForMode,
  composeImageRefs,
  extractJsonObject,
  parseCurlWithStatus,
  parseOpensslFingerprint,
  selfSignedSan,
} from "./artifacts";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The SSH seam — implemented by Ssh2Transport in the main process. */
export interface ProvisioningTransport {
  exec(command: string, options?: { timeoutMs?: number }): Promise<ExecResult>;
  writeFile(remotePath: string, contents: string | Uint8Array): Promise<void>;
  readFile(remotePath: string): Promise<string | null>;
  /** Streams a LOCAL file to the remote path (the image archives: hundreds of
   *  megabytes must never be buffered in memory). */
  writeLocalFile(localPath: string, remotePath: string): Promise<void>;
}

/** The bundled image set (files/images/*, manifest.json) — the registry-free
 *  fallback: digest-pinned references the compose stack uses, each with its
 *  docker-save archive. Missing images deploy from here BEFORE any pull. */
export interface ProvisioningImageSet {
  manifest: Array<{ ref: string; archive: string; bytes: number }>;
  /** The local directory holding the archives (main passes it in). */
  directory: string;
}

/** The deployment file set, read from electron/provisioning/files by the host. */
export interface ProvisioningFiles {
  composeFile: string;
  dockerfileServer: string;
  janusDockerfile: string;
  janusConfig: string;
  janusHttpConfig: string;
  caddyFileTemplate: string;
  /** The LOCAL path of the server jar — it uploads through the SAME
   *  streaming writeLocalFile path as the image archives (one code path for
   *  every large file: identical speed and behaviour by construction). */
  jarLocalPath: string;
  /** Null when the build ships no bundled images (the pull ladder then owns
   *  the registry path on its own). */
  images: ProvisioningImageSet | null;
}

export type ProvisioningStage =
  | "probe"
  | "docker"
  | "layout"
  | "upload"
  | "env"
  | "certificate"
  | "firewall"
  | "compose"
  | "wait"
  | "register";

export interface ProvisioningStepEvent {
  stage: ProvisioningStage;
  state: "start" | "done" | "log" | "failed";
  detail?: string;
}

/** The terminal outcome handed to the renderer for the automatic login. */
export interface ProvisioningOutcome {
  hostUrl: string;
  /** The self-signed certificate's normalized SHA-256 pin — null on a domain
   *  deployment (CA-signed, nothing to pin). */
  certFingerprint: string | null;
  /** True when the admin account accepts the password the user typed (fresh
   *  registration, or an adopt re-run whose existing account logged in). */
  ownerReady: boolean;
  /** The registered Space account login (the automatic login's username). */
  adminUsername: string;
}

/** A step failure carrying the stage it died on (for the UI's step list). */
export class ProvisioningFailure extends Error {
  constructor(
    public readonly stage: ProvisioningStage,
    message: string,
  ) {
    super(message);
  }
}

const REMOTE_ROOT = "/opt/oak";
const CERT_PATH = `${REMOTE_ROOT}/caddy/certs/tls.crt`;

// Long-running steps: the docker install pulls packages, the first compose up
// builds two images (temurin JRE base + janus), the readiness poll waits out
// Spring Boot's boot with Flyway migrations on a fresh database.
const DOCKER_INSTALL_TIMEOUT_MS = 600_000;
/** A full dist-upgrade of a fresh Ubuntu: hundreds of MB to fetch and unpack. */
const SYSTEM_UPGRADE_TIMEOUT_MS = 1_200_000;
const OPENSSL_TIMEOUT_MS = 60_000;
const FIREWALL_INSTALL_TIMEOUT_MS = 300_000;
const COMPOSE_UP_TIMEOUT_MS = 900_000;
const READINESS_TIMEOUT_MS = 420_000;
const IMAGE_LOAD_TIMEOUT_MS = 300_000;
/** One image, one pull — a big layer set on a slow path can take minutes. */
const SINGLE_PULL_TIMEOUT_MS = 600_000;

/** Parses the missing-check output ("MISSING ref" per line). */
function parseMissingImages(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("MISSING "))
    .map((line) => line.slice("MISSING ".length).trim())
    .filter((line) => line.length > 0);
}

type EmitFn = (event: ProvisioningStepEvent) => void;

export async function runProvisioningPipeline(
  transport: ProvisioningTransport,
  params: ProvisioningParams,
  files: ProvisioningFiles,
  emit: EmitFn,
  randomHex: RandomHexSource,
): Promise<ProvisioningOutcome> {
  const domainDeployment = params.domain !== null && params.domain.trim().length > 0;
  const publicHost = (domainDeployment ? params.domain! : params.host).trim();
  const hostUrl = `https://${publicHost}`;

  /** The failure's ROOT is often a few lines above the tail (a failed image
   *  pull reads as "No such image" only at the end — live VPS 2026-10-12),
   *  so keep a generous tail of the output. */
  const failureReason = (result: ExecResult): string =>
    (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`)
      .split("\n")
      .slice(-8)
      .join(" | ");

  /** Runs a command; a non-zero exit raises with the stage's name attached. */
  const must = async (
    stage: ProvisioningStage,
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<ExecResult> => {
    const result = await transport.exec(command, options);
    if (result.code !== 0) {
      throw new ProvisioningFailure(stage, failureReason(result));
    }
    return result;
  };

  try {
    // ── probe: OS + docker presence ─────────────────────────────────────
    emit({ stage: "probe", state: "start" });
    const kernel = await must("probe", "uname -s");
    const osName = kernel.stdout.trim();
    if (osName !== "Linux") {
      throw new ProvisioningFailure("probe", `Only Linux servers are supported (this host runs ${osName}).`);
    }
    const release = await transport.exec(`. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo "unknown Linux"`);
    // curl drives the readiness poll and the registration calls below — some
    // minimal cloud images ship without it.
    await must("probe", "command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl)", {
      timeoutMs: FIREWALL_INSTALL_TIMEOUT_MS,
    });

    // ── host requirements: refuse EARLY, before minutes of work ─────────
    // A host below the floors cannot hold the stack (the 2 GB VPS saga:
    // OOM races at start, live 2026-10-12) — the check up front turns a
    // 15-minute doomed run into a 5-second honest refusal (user request
    // 2026-10-13). The meminfo numbers are read ONCE here and reused by the
    // small-host swap guard below.
    const DISK_FLOOR_MB = 5_120;
    const RAM_FLOOR_KB = 1_200_000;
    const diskResult = await transport.exec("df -Pm / | awk 'NR==2 {print $4}'");
    // parseInt (not Number): an EMPTY output parses to NaN and the check is
    // skipped, while Number("") would read as 0 and refuse a healthy host.
    const diskFreeMb = Number.parseInt(diskResult.stdout.trim(), 10);
    const meminfo = await transport.exec("awk '/^MemTotal|^SwapTotal/ {print $2}' /proc/meminfo");
    const [memTotalKb, swapTotalKb] = meminfo.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    const memoryNumbersKnown = memTotalKb !== undefined && swapTotalKb !== undefined
      && Number.isFinite(memTotalKb) && Number.isFinite(swapTotalKb);
    // Some providers cap a VM below its advertised RAM through a root cgroup
    // memory limit — inside a capped VM the kernel OOM killer looks exactly
    // like missing RAM (the suspicion checked by hand on the live VPS,
    // 2026-10-13), so the cap counts against the same floor.
    const cgroupLimit = await transport.exec("cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max");
    const cgroupLimitKb = Number.parseInt(cgroupLimit.stdout.trim(), 10);
    const gigabytes = (kb: number): string => `${(kb / 1_000_000).toFixed(1)} GB`;
    if (Number.isFinite(diskFreeMb) && diskFreeMb < DISK_FLOOR_MB) {
      throw new ProvisioningFailure(
        "probe",
        `not enough disk space: ${Math.round(diskFreeMb / 1024)} GB free on /, at least ${Math.round(DISK_FLOOR_MB / 1024)} GB is required`,
      );
    }
    if (memoryNumbersKnown && memTotalKb < RAM_FLOOR_KB) {
      throw new ProvisioningFailure(
        "probe",
        `not enough memory: ${gigabytes(memTotalKb)} RAM, at least ${gigabytes(RAM_FLOOR_KB)} is required`,
      );
    }
    if (Number.isFinite(cgroupLimitKb) && cgroupLimitKb < RAM_FLOOR_KB) {
      throw new ProvisioningFailure(
        "probe",
        `the hosting provider caps this machine's memory at ${gigabytes(cgroupLimitKb)} — below the ${gigabytes(RAM_FLOOR_KB)} the stack needs`,
      );
    }

    const dockerProbe = await transport.exec("docker --version && docker compose version");
    const dockerPresent = dockerProbe.code === 0;
    emit({
      stage: "probe",
      state: "done",
      detail: `${release.stdout.trim() || "Linux"} · docker ${dockerPresent ? "present" : "missing"}`
        + (memoryNumbersKnown && Number.isFinite(diskFreeMb)
          ? ` · ${gigabytes(memTotalKb)} RAM + ${gigabytes(swapTotalKb)} swap · ${Math.round(diskFreeMb / 1024)} GB disk free`
          : ""),
    });

    // ── docker: system refresh + install when absent ─────────────────────
    // SYSTEM UPDATE FIRST (user decision, 2026-10-13): a fresh OS boots with
    // unattended-upgrades already churning in the background — it OOM-raced
    // the stack start three installs in a row on the 2 GB VPS (journal: minio
    // + unattended-upgr killed in the same minutes). The pipeline stops the
    // updater, upgrades the system DETERMINISTICALLY, and disables the
    // updater for good — package upgrades on a dedicated OAK server are the
    // owner's deliberate act, never a background one.
    emit({ stage: "docker", state: "start", detail: "stopping the background updater and upgrading system packages" });
    await must(
      "docker",
      "systemctl stop unattended-upgrades apt-daily-upgrade 2>/dev/null; "
        + "systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1; true",
    );
    // The updater may hold the dpkg lock mid-install — wait it out (a killed
    // updater also leaves half-installed packages behind; configure -a fixes).
    await must(
      "docker",
      "for attempt in $(seq 1 60); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || exit 0; sleep 5; done; echo 'the dpkg lock is still held'; exit 1",
      { timeoutMs: 360_000 },
    );
    await must("docker", "dpkg --configure -a", { timeoutMs: 600_000 });
    await must(
      "docker",
      "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get -y -qq dist-upgrade",
      { timeoutMs: SYSTEM_UPGRADE_TIMEOUT_MS },
    );
    emit({ stage: "docker", state: "log", detail: "system packages updated" });
    const rebootNeeded = await transport.exec("test -f /var/run/reboot-required && echo yes || echo no");
    if (rebootNeeded.code === 0 && rebootNeeded.stdout.trim() === "yes") {
      emit({ stage: "docker", state: "log", detail: "a reboot is recommended after the setup (a new kernel arrived)" });
    }

    if (!dockerPresent) {
      emit({ stage: "docker", state: "log", detail: "installing Docker (this can take a few minutes)" });
      await must("docker", "curl -fsSL https://get.docker.com | sh", { timeoutMs: DOCKER_INSTALL_TIMEOUT_MS });
      // The installer usually starts the daemon; make sure it is enabled too.
      await transport.exec("systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true");
      const verify = await transport.exec("docker compose version");
      if (verify.code !== 0) {
        throw new ProvisioningFailure("docker", "Docker was installed but does not answer — is the daemon running?");
      }
      emit({ stage: "docker", state: "done", detail: "system updated, Docker installed" });
    }
    if (dockerPresent) {
      emit({ stage: "docker", state: "done", detail: "system updated, Docker ready" });
    }

    // ── layout: /opt/oak + the adopt check ──────────────────────────────
    emit({ stage: "layout", state: "start" });
    await must("layout", `mkdir -p ${REMOTE_ROOT}/caddy/certs ${REMOTE_ROOT}/janus`);
    const existingCompose = await transport.readFile(`${REMOTE_ROOT}/docker-compose.yml`);
    const adopt = existingCompose !== null;
    emit({
      stage: "layout",
      state: "done",
      detail: adopt
        ? "existing deployment found — updating in place (secrets, certificate and volumes are kept)"
        : "fresh deployment",
    });

    // ── upload: templates + the server jar ──────────────────────────────
    emit({ stage: "upload", state: "start", detail: "uploading the deployment files" });
    await transport.writeFile(`${REMOTE_ROOT}/docker-compose.yml`, files.composeFile);
    await transport.writeFile(`${REMOTE_ROOT}/Dockerfile.server`, files.dockerfileServer);
    await transport.writeFile(`${REMOTE_ROOT}/janus/Dockerfile`, files.janusDockerfile);
    await transport.writeFile(`${REMOTE_ROOT}/janus/janus.jcfg`, files.janusConfig);
    await transport.writeFile(`${REMOTE_ROOT}/janus/janus.transport.http.jcfg`, files.janusHttpConfig);
    await transport.writeFile(`${REMOTE_ROOT}/caddy/Caddyfile`, caddyFileForMode(files.caddyFileTemplate, domainDeployment));
    await transport.writeLocalFile(files.jarLocalPath, `${REMOTE_ROOT}/oak-server.jar`);
    emit({
      stage: "upload",
      state: "done",
      detail: "uploaded the compose stack and the server jar",
    });

    // ── env: per-deployment secrets (never on adopt) ────────────────────
    emit({ stage: "env", state: "start" });
    if (adopt) {
      emit({ stage: "env", state: "done", detail: "kept the existing .env (secrets survive re-runs)" });
    } else {
      const secrets = generateEnvSecrets(randomHex);
      await transport.writeFile(`${REMOTE_ROOT}/.env`, buildEnvFile(publicHost, params.host.trim(), secrets));
      emit({ stage: "env", state: "done", detail: "generated .env with fresh random secrets" });
    }

    // ── certificate: self-signed on a bare IP, ACME on a domain ─────────
    emit({ stage: "certificate", state: "start" });
    let certFingerprint: string | null = null;
    if (domainDeployment) {
      emit({
        stage: "certificate",
        state: "done",
        detail: `${publicHost} — Caddy obtains a Let's Encrypt certificate automatically`,
      });
    } else {
      const existingCert = await transport.exec(`test -f ${CERT_PATH} && echo yes || echo no`);
      const hasCert = existingCert.code === 0 && existingCert.stdout.trim() === "yes";
      if (adopt && hasCert) {
        // Regenerating would invalidate every client's pinned fingerprint —
        // an adopt run READS the certificate instead.
        const read = await must("certificate", `openssl x509 -in ${CERT_PATH} -noout -fingerprint -sha256`);
        certFingerprint = parseOpensslFingerprint(read.stdout);
        if (certFingerprint === null) {
          throw new ProvisioningFailure("certificate", "could not read the existing certificate's fingerprint");
        }
        emit({ stage: "certificate", state: "done", detail: "kept the existing certificate (client pins stay valid)" });
      } else {
        const san = selfSignedSan(params.host.trim());
        // Key generation goes through `openssl ecparam` — the one-shot
        // `req -newkey ec -pkeyopt ec_paramgen_curve:…` form is rejected by
        // some OpenSSL 3.0 builds ("Key parameter error", live VPS 2026-10-12),
        // while ecparam + req -new works from OpenSSL 1.0 through 3.x.
        await must(
          "certificate",
          `cd ${REMOTE_ROOT}/caddy && openssl ecparam -name prime256v1 -genkey -noout -out certs/tls.key `
            + `&& openssl req -x509 -new -key certs/tls.key -out certs/tls.crt -days 3650 `
            + `-subj '/CN=oak' -addext '${san}'`,
          { timeoutMs: OPENSSL_TIMEOUT_MS },
        );
        const read = await must("certificate", `openssl x509 -in ${CERT_PATH} -noout -fingerprint -sha256`);
        certFingerprint = parseOpensslFingerprint(read.stdout);
        if (certFingerprint === null) {
          throw new ProvisioningFailure("certificate", "openssl did not report a SHA-256 fingerprint");
        }
        emit({ stage: "certificate", state: "done", detail: `self-signed certificate ready (${certFingerprint.slice(0, 16)}…)` });
      }
    }

    // ── firewall: ufw with exactly the deployment's public ports ────────
    // The SSH port itself comes from the form: enabling ufw without allowing
    // the port the session rides on would lock the user out of the server.
    if (params.firewall) {
      emit({ stage: "firewall", state: "start" });
      await must(
        "firewall",
        "command -v ufw >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq ufw)",
        { timeoutMs: FIREWALL_INSTALL_TIMEOUT_MS },
      );
      await must(
        "firewall",
        `ufw allow ${params.sshPort}/tcp && ufw allow 443/tcp && ufw allow 9443/tcp`
          // 34780/udp is the PRIMARY TURN transport: a TURN Allocate travels
          // as UDP first (the server also advertises ?transport=tcp, but a
          // TCP relay's headroom is a poor voice path — UDP is the one that
          // must be open for 1-on-1 calls behind strict NAT).
          + " && ufw allow 34780/tcp && ufw allow 34780/udp && ufw allow 5349/tcp"
          + " && ufw allow 2000:2300/udp && ufw allow 55000:55050/udp"
          + " && ufw --force enable",
      );
      emit({ stage: "firewall", state: "done", detail: "open: SSH, HTTPS (443/9443), TURN and voice media; everything else denied" });
    }

    // ── small-host guard: RAM + swap headroom before lifting the stack ──
    // A 2 GB VPS OOM-killed the whole stack during the start (live
    // 2026-10-12): the kernel's OOM killer took janus and the sshd with it.
    // When RAM+swap sit under ~3 GB, a persistent 2 GB swapfile absorbs the
    // start spike; the fstab line makes it survive reboots. The check is on
    // SwapTotal (read in the probe stage above), NOT on the file's existence
    // (live 2026-10-13): the provider's image ships its own thin 512 MB
    // /swapfile — a "file exists → skip" guard left that sliver in place and
    // the stack OOM'd again, so a thin swap file is REBUILT to the full 2 GB.
    const MEMORY_FLOOR_KB = 3_000_000;
    const SWAP_TARGET_KB = 2_000_000;
    if (memoryNumbersKnown && memTotalKb + swapTotalKb < MEMORY_FLOOR_KB && swapTotalKb < SWAP_TARGET_KB) {
      emit({ stage: "compose", state: "log", detail: "low memory host — enlarging the swap file to 2 GB for the start spike" });
      await must(
        "compose",
        `swapoff /swapfile 2>/dev/null; rm -f /swapfile; `
          + `fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; `
          + `chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile `
          + `&& (grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab)`,
        { timeoutMs: 180_000 },
      );
    }

    // ── compose: build the images and start the stack ───────────────────
    emit({ stage: "compose", state: "start", detail: "preparing the stack images (the first run takes a few minutes)" });
    // The image list: the bundled manifest's digest-pinned refs, or — for a
    // build without the bundled set — the image: lines of the compose file
    // itself. Every image pulls INDIVIDUALLY (user decision 2026-10-12): one
    // failing reference never aborts the others, so a partial mirror still
    // delivers everything it has.
    const bundledImages = files.images;
    const pullList = bundledImages !== null
      ? bundledImages.manifest.map((entry) => entry.ref)
      : composeImageRefs(files.composeFile);
    const missingCheck = `for IMAGE in ${pullList.map((ref) => `'${ref}'`).join(" ")}; do docker image inspect "$IMAGE" >/dev/null 2>&1 || echo "MISSING $IMAGE"; done`;
    let missingImages = parseMissingImages((await transport.exec(missingCheck)).stdout);

    if (missingImages.length === 0) {
      emit({ stage: "compose", state: "log", detail: "all stack images are in place — the registry is not needed" });
    } else {
      // A healthy host PULLS first (fast, with its own wide datacenter
      // channel) — the bundled archives only deploy as the RESCUE for what
      // no pull route could deliver, so normal networks never upload.
      let lastPullReason = "";
      const pullRound = async (refs: string[]): Promise<string[]> => {
        const stillMissing: string[] = [];
        for (const ref of refs) {
          const result = await transport.exec(`docker pull '${ref}'`, { timeoutMs: SINGLE_PULL_TIMEOUT_MS });
          if (result.code !== 0) {
            stillMissing.push(ref);
            lastPullReason = failureReason(result);
          }
        }
        if (stillMissing.length < refs.length) {
          emit({
            stage: "compose",
            state: "log",
            detail: `pulled ${refs.length - stillMissing.length} of ${refs.length} missing image(s)`,
          });
        }
        return stillMissing;
      };
      let remaining = await pullRound(missingImages);
      if (remaining.length > 0) {
        // Self-repair ladder — each step re-pulls ONLY what is still missing.
        const dnsCheck = await transport.exec("getent hosts registry-1.docker.io >/dev/null 2>&1 || echo NO_DNS");
        if (dnsCheck.code === 0 && dnsCheck.stdout.includes("NO_DNS")) {
          emit({ stage: "compose", state: "log", detail: "the Docker registry does not resolve — adding a public nameserver" });
          await transport.exec("sed -i '1i nameserver 1.1.1.1' /etc/resolv.conf");
          remaining = await pullRound(remaining);
        }
      }
      if (remaining.length > 0) {
        emit({ stage: "compose", state: "log", detail: "configuring registry mirrors (mirror.gcr.io, then docker.m.daocloud.io)" });
        await must(
          "compose",
          `python3 -c 'import json, pathlib; target = pathlib.Path("/etc/docker/daemon.json"); `
            + `data = json.loads(target.read_text()) if target.exists() else {}; `
            // ORDER MATTERS: a mirror's denied/404 is AUTHORITATIVE for
            // dockerd — the next mirror never gets asked. gcr leads (it
            // serves the common images); daocloud denies anonymous pulls
            // from some networks and must not lead (live VPS 2026-10-12:
            // it blocked the pulls gcr would have served).
            + `data["registry-mirrors"] = ["https://mirror.gcr.io", "https://docker.m.daocloud.io"]; `
            + `target.write_text(json.dumps(data))'`,
          { timeoutMs: 30_000 },
        );
        // Restarting the daemon re-creates the running containers on an adopt
        // re-run (restart: unless-stopped) — a few seconds of downtime, no
        // data loss.
        await must("compose", "systemctl restart docker 2>/dev/null || service docker restart", { timeoutMs: 120_000 });
        remaining = await pullRound(remaining);
      }
      if (remaining.length > 0) {
        // A mirror answering "denied"/404 is AUTHORITATIVE for dockerd — it
        // never falls back to the Hub (daocloud denies anonymous pulls from
        // some networks, live VPS 2026-10-12). Last registry resort: strip
        // the mirrors and pull DIRECT — by now the original Hub-side trouble
        // (an anonymous per-IP rate limit, a 6-hour window) may have passed.
        emit({ stage: "compose", state: "log", detail: "removing the mirrors and retrying direct" });
        await must(
          "compose",
          `python3 -c 'import json, pathlib; target = pathlib.Path("/etc/docker/daemon.json"); `
            + `data = json.loads(target.read_text()) if target.exists() else {}; `
            + `data.pop("registry-mirrors", None); `
            + `target.write_text(json.dumps(data))'`,
          { timeoutMs: 30_000 },
        );
        await must("compose", "systemctl restart docker 2>/dev/null || service docker restart", { timeoutMs: 120_000 });
        remaining = await pullRound(remaining);
      }
      if (remaining.length === 0) {
        emit({ stage: "compose", state: "log", detail: "images pulled from the registry" });
      } else if (bundledImages !== null) {
        // Every pull route failed — rescue from the bundled archives: upload
        // ONLY what no route could deliver (writeLocalFile streams, docker
        // load imports; the registry is bypassed entirely).
        emit({
          stage: "compose",
          state: "log",
          detail: `the registry could not deliver ${remaining.length} image(s) — deploying them from the bundled set`,
        });
        await must("compose", `mkdir -p ${REMOTE_ROOT}/images`);
        for (const ref of remaining) {
          const entry = bundledImages.manifest.find((candidate) => candidate.ref === ref);
          if (entry === undefined) {
            continue; // not bundled either — the final check below reports it
          }
          emit({
            stage: "compose",
            state: "log",
            detail: `uploading ${ref} (${Math.round(entry.bytes / 1024 / 1024)} MB)`,
          });
          await transport.writeLocalFile(`${bundledImages.directory}/${entry.archive}`, `${REMOTE_ROOT}/images/${entry.archive}`);
          await must("compose", `gunzip -c ${REMOTE_ROOT}/images/${entry.archive} | docker load`, { timeoutMs: IMAGE_LOAD_TIMEOUT_MS });
        }
        const recheck = parseMissingImages((await transport.exec(missingCheck)).stdout);
        if (recheck.length > 0) {
          throw new ProvisioningFailure("compose", `images neither pullable nor bundled: ${recheck.join(", ")}`);
        }
        emit({ stage: "compose", state: "log", detail: "bundled images deployed — the registry was not needed" });
      } else {
        throw new ProvisioningFailure("compose", `images could not be pulled (${lastPullReason}): ${remaining.join(", ")}`);
      }
    }
    // SEQUENTIAL bring-up (user request 2026-10-12): lifting one service at a
    // time smooths the start spike on small hosts — a parallel `up` is what
    // OOM-killed the 2 GB VPS. The order front-loads the dependencies
    // (compose would raise them implicitly anyway); each `up` is idempotent,
    // so re-runs and partial stacks just continue where they stopped.
    const START_ORDER = ["postgres", "minio", "minio-init", "janus", "coturn", "oak", "caddy"];
    for (const service of START_ORDER) {
      await must("compose", `cd ${REMOTE_ROOT} && docker compose up -d --build ${service}`, { timeoutMs: COMPOSE_UP_TIMEOUT_MS });
    }
    // Every rebuild with a CHANGED jar leaves the previous image dangling
    // (<none>, ~the jar layer each) — re-runs must not slowly fill the disk.
    // Only UNTAGGED images go; tagged ones in use are untouched, and the
    // build cache stays (it is what makes the next rebuild fast).
    await must("compose", "docker image prune -f");
    emit({ stage: "compose", state: "done", detail: "containers are up" });

    // ── wait: the server answers over localhost HTTPS ────────────────────
    // The poll runs ON the server (curl -k against https://localhost with the
    // PUBLIC Host header): it measures the stack itself, immune to the
    // client's network path and the certificate trust not established yet.
    // The Host header is not cosmetic — Caddy routes by Host, and a bare
    // "localhost" matches NO site block: Caddy answers an EMPTY 200, which the
    // poll would mistake for readiness and register would read as "HTTP 200"
    // instead of 201/409 (live VPS 2026-10-13). The self-signed certificate's
    // SAN covers localhost, so the TLS handshake still succeeds.
    // The PROXY codes (502/503/504) are Caddy speaking while oak is still
    // booting — an answer from the proxy is NOT readiness (live VPS
    // 2026-10-13: the poll took a 502 for a ready server and register died
    // with "registration failed (HTTP 502)"); only the application's own
    // codes count.
    emit({ stage: "wait", state: "start", detail: "waiting for the server to come up" });
    const pollCommand = `for attempt in $(seq 1 80); do `
      + `code=$(curl -sko /dev/null -w '%{http_code}' --max-time 3 -H "Host: ${publicHost}" https://localhost/api/server 2>/dev/null); `
      + `if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" != "502" ] && [ "$code" != "503" ] && [ "$code" != "504" ]; then echo "HTTP $code"; exit 0; fi; `
      + `sleep 5; done; echo 'the server did not answer within 400 seconds'; exit 1`;
    const pollResult = await must("wait", pollCommand, { timeoutMs: READINESS_TIMEOUT_MS });
    emit({ stage: "wait", state: "done", detail: `server answers (${pollResult.stdout.trim()})` });

    // ── register: the OWNER account + the advertised connection info ────
    // Bodies travel as FILES (writeFile), never on the command line — the
    // account password must not appear in any shell history or process list.
    emit({ stage: "register", state: "start", detail: "creating the owner account" });
    const statusMarker = `-w '\\n__STATUS__%{http_code}'`;
    let ownerReady = false;

    const registerBody = JSON.stringify({
      username: params.adminLogin,
      password: params.adminPassword,
      // The nickname rides along when it differs from the login; the server
      // defaults a missing one to the login anyway.
      ...(params.adminNickname !== null && params.adminNickname !== params.adminLogin
        ? { nickname: params.adminNickname }
        : {}),
    });
    await transport.writeFile(`${REMOTE_ROOT}/.provision-register.json`, registerBody);
    const registerResponse = await must(
      "register",
      `curl -sk -X POST https://localhost/api/auth/register -H "Host: ${publicHost}" `
        + `-H 'Content-Type: application/json' -d @${REMOTE_ROOT}/.provision-register.json ${statusMarker}`,
    );
    const registerOutcome = parseCurlWithStatus(registerResponse.stdout);
    let accessToken: string | null = null;
    if (registerOutcome === null) {
      throw new ProvisioningFailure("register", "the server did not answer the registration request");
    }
    /** Logs the typed credentials in and sets the token; a non-200 login is
     *  NOT fatal (a re-run's admin may carry a different password — the user
     *  then logs in manually; returns whether the automatic login worked). */
    const loginForToken = async (): Promise<boolean> => {
      const loginBody = JSON.stringify({ username: params.adminLogin, password: params.adminPassword });
      await transport.writeFile(`${REMOTE_ROOT}/.provision-login.json`, loginBody);
      const loginResponse = await must(
        "register",
        `curl -sk -X POST https://localhost/api/auth/login -H "Host: ${publicHost}" `
          + `-H 'Content-Type: application/json' -d @${REMOTE_ROOT}/.provision-login.json ${statusMarker}`,
      );
      const loginOutcome = parseCurlWithStatus(loginResponse.stdout);
      if (loginOutcome === null || loginOutcome.status !== 200) {
        return false;
      }
      accessToken = authResponseToken(extractJsonObject(loginOutcome.body));
      if (accessToken === null) {
        throw new ProvisioningFailure("register", "login succeeded but returned no access token");
      }
      return true;
    };
    if (registerOutcome.status === 201) {
      emit({ stage: "register", state: "log", detail: `account ${params.adminLogin} registered` });
      // The wire register returns the CREATED USER (UserResponse — no token):
      // the access token only ever comes from login (AuthController).
      ownerReady = await loginForToken();
      if (!ownerReady) {
        throw new ProvisioningFailure("register", "registration succeeded but the login right after it failed");
      }
    } else if (registerOutcome.status === 409) {
      // An adopt re-run: the account exists — log in with the typed password.
      ownerReady = await loginForToken();
      emit({
        stage: "register",
        state: "log",
        detail: ownerReady
          ? "the account already exists — logged in with the typed password"
          : "the admin account exists with a DIFFERENT password — automatic login is not possible",
      });
    } else {
      const detail = serverErrorDetail(registerOutcome.body);
      throw new ProvisioningFailure("register", `registration failed (HTTP ${registerOutcome.status})${detail ? `: ${detail}` : ""}`);
    }

    if (ownerReady && accessToken !== null) {
      // The advertised connection info drives invite links and the connect
      // hint (round B). The wire is UpdateConnectionInfoRequest —
      // connectionHost/connectionPort/connectionScheme, NOT host/scheme:
      // unknown fields are silently ignored and every DTO field then reads
      // as null, which the endpoint treats as "leave unchanged" — a 200 that
      // changes nothing (live VPS 2026-10-13). Port rides along so links do
      // not assemble as host:8080 under an https scheme.
      const connectionBody = JSON.stringify({
        connectionHost: publicHost,
        connectionPort: 443,
        connectionScheme: "https",
      });
      await transport.writeFile(`${REMOTE_ROOT}/.provision-connection.json`, connectionBody);
      const connectionResponse = await must(
        "register",
        `curl -sk -X PATCH https://localhost/api/server/connection -H "Host: ${publicHost}" `
          + `-H 'Content-Type: application/json' -H "Authorization: Bearer ${accessToken}" `
          + `-d @${REMOTE_ROOT}/.provision-connection.json ${statusMarker}`,
      );
      const connectionOutcome = parseCurlWithStatus(connectionResponse.stdout);
      if (connectionOutcome === null || connectionOutcome.status !== 200) {
        const status = connectionOutcome?.status ?? "no answer";
        throw new ProvisioningFailure("register", `setting the advertised address failed (HTTP ${status})`);
      }
      emit({ stage: "register", state: "log", detail: `advertised address set to ${publicHost}` });
    }
    await transport.exec(`rm -f ${REMOTE_ROOT}/.provision-register.json ${REMOTE_ROOT}/.provision-login.json ${REMOTE_ROOT}/.provision-connection.json`);
    emit({
      stage: "register",
      state: "done",
      detail: ownerReady ? "the server is ready" : "the server is ready — log in with the existing admin password",
    });

    return { hostUrl, certFingerprint, ownerReady, adminUsername: params.adminLogin };
  } catch (error) {
    // A failed register step leaves the credential FILES behind (rm normally
    // runs on the success path) — best-effort scrub on EVERY failure; the
    // connection may already be gone, and then there is nothing to scrub.
    await transport.exec(
      `rm -f ${REMOTE_ROOT}/.provision-register.json ${REMOTE_ROOT}/.provision-login.json ${REMOTE_ROOT}/.provision-connection.json`,
    );
    if (error instanceof ProvisioningFailure) {
      emit({ stage: error.stage, state: "failed", detail: error.message });
    }
    throw error;
  }
}

/** The wire AuthResponse carries the access token as `token`. */
function authResponseToken(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const token = (body as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Spring's error body shape: {"error": …, "message": …} — message wins. */
function serverErrorDetail(body: string): string | null {
  const parsed = extractJsonObject(body);
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const message = (parsed as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}
