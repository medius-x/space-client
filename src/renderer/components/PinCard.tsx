import { useEffect, useState } from "react";
import { useStore } from "../hooks/useStore";
import { openChannelAtMessage } from "../runtime";
import { displayNameOf } from "../../domain/logic/display-name";
import { defaultPinIndex, pinSnippet, stepPinIndex } from "../../domain/logic/pinned-view";
import type { ConnectionSession } from "../../domain/session/connection-session";

/**
 * The channel's pinned-message card, mounted between the chat header and the
 * now-playing bar (the FIRST sibling owns the top slot — with both present the
 * audio card sits BELOW the pin, per the user's spec). A carousel: the card
 * shows the LATEST pin by default; ‹ › arrows and an "i/N" counter walk the
 * list when there is more than one. Clicking the body jumps to the shown pin
 * via the ?around= window machinery.
 */
export function PinCard({ session, channelId }: {
  session: ConnectionSession;
  channelId: number;
}): React.JSX.Element | null {
  const store = useStore(session.pinnedStore, (current) => current);
  const users = useStore(session.rosterStore, (roster) => roster.users);
  const pins = store.listFor(channelId);
  const [index, setIndex] = useState(defaultPinIndex(pins.length));

  // A channel switch (or the list shrinking past the index) restarts on the latest pin.
  useEffect(() => {
    setIndex(defaultPinIndex(pins.length));
  }, [channelId, pins.length]);

  if (pins.length === 0 || index >= pins.length) {
    return null;
  }
  const pin = pins[index]!;
  return (
    <div className="pin-card">
      <button
        className="pin-card-body"
        title="Jump to the pinned message"
        onClick={() => {
          openChannelAtMessage(channelId, pin.id);
        }}
      >
        <span className="icon mdi-pin pin-card-icon" />
        <span className="pin-card-text">
          <span className="pin-card-by">{`Pinned by ${displayNameOf(users, pin.pinnedBy)}`}</span>
          <span className="pin-card-snippet">{pinSnippet(pin)}</span>
        </span>
      </button>
      {pins.length > 1 ? (
        <span className="pin-card-nav">
          <button
            className="pin-card-arrow"
            title="Previous pin"
            onClick={() => {
              setIndex((current) => stepPinIndex(current, -1, pins.length));
            }}
          >
            <span className="icon mdi-chevron-left" />
          </button>
          <span className="pin-card-counter">{`${index + 1}/${pins.length}`}</span>
          <button
            className="pin-card-arrow"
            title="Next pin"
            onClick={() => {
              setIndex((current) => stepPinIndex(current, 1, pins.length));
            }}
          >
            <span className="icon mdi-chevron-right" />
          </button>
        </span>
      ) : null}
    </div>
  );
}
