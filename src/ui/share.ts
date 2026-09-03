import { el, clear } from "./dom";

export interface SharePanelActions {
  setShareVolume(username: string, gain: number): void;
  stopWatching(): void;
}

export interface SharePanelView {
  /** Attach the incoming remote screen track; called on watch start / reshare. */
  attachVideo(track: MediaStreamTrack): void;
  setTitle(username: string): void;
}

/**
 * The screen-share viewer panel (top of the room content). The <video> element carries
 * the remote screen; its audio rides the RoomAudio share chain, not this element.
 */
export function renderSharePanel(container: HTMLElement, username: string, actions: SharePanelActions): SharePanelView {
  clear(container);
  const video = el("video", { autoplay: true, playsinline: true }) as HTMLVideoElement;
  const head = el("div", { class: "share-panel-head" },
    el("span", {}, `📺 ${username}'s screen`),
    el("button", { class: "ghost", onclick: () => actions.stopWatching() }, "Stop watching"),
  );
  const volumeRow = el("div", { class: "tile-controls" },
    el("label", {}, "share volume"),
    (() => {
      const slider = el("input", { type: "range", min: 0, max: 200, value: 100 }) as HTMLInputElement;
      slider.addEventListener("input", () => actions.setShareVolume(username, slider.valueAsNumber / 100));
      return slider;
    })(),
  );
  const panel = el("div", { class: "share-panel" }, head, video, volumeRow);
  container.append(panel);

  return {
    attachVideo(track: MediaStreamTrack): void {
      video.srcObject = new MediaStream([track]);
      void video.play().catch(() => undefined);
    },
    setTitle(nextUsername: string): void {
      const label = head.firstChild;
      if (label) {
        label.textContent = `📺 ${nextUsername}'s screen`;
      }
    },
  };
}
