import { log } from "../../logging";

/**
 * Coalescing async refresher for the "STOMP event → refetch" pattern (oak's
 * runDaemon(loadTask)). A refresh arriving while one is in flight is queued and
 * re-run afterwards — without this, a slow snapshot response could land AFTER a
 * fresher event-triggered refetch and resurrect stale rows (the presence-race
 * class of bugs, applied to relationship/DM lists).
 */
export class CoalescingRefresher {
  private inFlight = false;
  private queued = false;

  constructor(private readonly run: () => Promise<void>) {}

  request(): void {
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    this.inFlight = true;
    void this.run()
      .catch((error: unknown) => {
        log.warn("session", `refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.inFlight = false;
        if (this.queued) {
          this.queued = false;
          this.request();
        }
      });
  }
}
