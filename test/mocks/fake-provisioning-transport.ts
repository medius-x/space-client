/**
 * Scriptable ProvisioningTransport double: commands are captured in order,
 * responses are matched by substring/regex (first registered wins), and the
 * file side is a plain in-memory map so adopt checks see prior writes.
 */
import type { ExecResult, ProvisioningTransport } from "../../src/domain/provisioning/pipeline";

export interface ScriptedResponse {
  code?: number;
  stdout?: string;
  stderr?: string;
  /** Emulated command OUTPUT, delivered through the exec's onOutputLine —
   *  the live-progress surface (docker/compose steps). */
  outputLines?: string[];
}

export class FakeProvisioningTransport implements ProvisioningTransport {
  readonly commands: string[] = [];
  readonly writes: { path: string; contents: string }[] = [];
  readonly files = new Map<string, string>();
  closed = false;

  private readonly handlers: { match: string | RegExp; response: ScriptedResponse; once: boolean }[] = [];

  /** Registers a response for commands containing the match. Later
   *  registrations are checked FIRST — a test can script a baseline and then
   *  override one command (the way the adopt tests re-script the cert probe). */
  respond(match: string | RegExp, response: ScriptedResponse): void {
    this.handlers.unshift({ match, response, once: false });
  }

  /** A ONE-SHOT response: consumed by the first matching call, then removed —
   *  the way the pull-retry ladder tests make the first pull fail and the
   *  retry fall through to the default success. */
  respondOnce(match: string | RegExp, response: ScriptedResponse): void {
    this.handlers.unshift({ match, response, once: true });
  }

  async exec(
    command: string,
    options?: { timeoutMs?: number; onOutputLine?: (line: string) => void },
  ): Promise<ExecResult> {
    this.commands.push(command);
    if (this.closed) {
      return { code: 255, stdout: "", stderr: "connection closed" };
    }
    for (let index = 0; index < this.handlers.length; index += 1) {
      const handler = this.handlers[index]!;
      const hit = handler.match instanceof RegExp
        ? handler.match.test(command)
        : command.includes(handler.match);
      if (hit) {
        if (handler.once) {
          this.handlers.splice(index, 1);
        }
        for (const line of handler.response.outputLines ?? []) {
          options?.onOutputLine?.(line);
        }
        return { code: handler.response.code ?? 0, stdout: handler.response.stdout ?? "", stderr: handler.response.stderr ?? "" };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  async writeFile(remotePath: string, contents: string | Uint8Array): Promise<void> {
    const text = typeof contents === "string"
      ? contents
      : `(binary ${contents.byteLength} bytes)`;
    this.writes.push({ path: remotePath, contents: text });
    this.files.set(remotePath, text);
  }

  async readFile(remotePath: string): Promise<string | null> {
    return this.files.get(remotePath) ?? null;
  }

  async writeLocalFile(
    localPath: string,
    remotePath: string,
    onProgress?: (bytesSent: number, bytesTotal: number) => void,
  ): Promise<void> {
    this.commands.push(`(writeLocalFile ${localPath})`);
    this.writes.push({ path: remotePath, contents: `(local archive ${localPath})` });
    // A plausible transfer trace: halfway, then complete (the real transport
    // counts the streamed chunks — the pipeline only formats the numbers).
    if (onProgress !== undefined) {
      onProgress(40 * 1024 * 1024, 80 * 1024 * 1024);
      onProgress(80 * 1024 * 1024, 80 * 1024 * 1024);
    }
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: the first command containing the needle (or null). */
  commandWith(needle: string): string | null {
    return this.commands.find((command) => command.includes(needle)) ?? null;
  }

  /** Test helper: the last write to the path (or null). */
  writeToFile(path: string): string | null {
    const write = this.writes.find((entry) => entry.path === path);
    return write?.contents ?? null;
  }
}
