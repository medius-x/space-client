/**
 * Node-env stand-in for the DOM MediaStream — SfuSession constructs these around
 * tracks; only getAudioTracks/getVideoTracks matter to it.
 */
export class FakeMediaStream {
  constructor(private readonly tracks: unknown[] = []) {}

  getAudioTracks(): { id: string; kind: string; enabled: boolean; stop(): void }[] {
    return this.tracks.filter((track) => (track as { kind?: string }).kind === "audio") as never;
  }

  getVideoTracks(): { id: string; kind: string; enabled: boolean; stop(): void }[] {
    return this.tracks.filter((track) => (track as { kind?: string }).kind === "video") as never;
  }
}

export function installFakeMediaStream(): void {
  (globalThis as { MediaStream?: unknown }).MediaStream = FakeMediaStream;
}
