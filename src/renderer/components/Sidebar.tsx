import { useStore } from "../hooks/useStore";
import { appStore, joinVoice } from "../runtime";
import type { Channel } from "../../types";

export function Sidebar(): React.JSX.Element {
  const channels = useStore(appStore, (state) => state.channels);
  const users = useStore(appStore, (state) => state.users);
  const presence = useStore(appStore, (state) => state.presence);
  const voiceMembers = useStore(appStore, (state) => state.voiceMembers);
  const activeVoiceChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const ownUsername = useStore(appStore, (state) => state.ownUsername);

  const voiceChannels = channels.filter((channel) => channel.type === "VOICE");

  const onChannelClick = (channel: Channel) => {
    if (channel.id !== activeVoiceChannelId) {
      void joinVoice(channel);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-section-title">Voice channels - test</div>
      {voiceChannels.map((channel) => (
        <div key={channel.id}>
          <div
            className={"channel-row" + (channel.id === activeVoiceChannelId ? " active" : "") + (channel.locked ? " locked" : "")}
            onClick={() => onChannelClick(channel)}
          >
            🔊 {channel.name}
          </div>
          {[...(voiceMembers.get(channel.id) ?? [])].map((username) => (
            <div key={username} className="member-row">
              <span className="presence-dot online" />
              {username}{username === ownUsername ? " (you)" : ""}
            </div>
          ))}
        </div>
      ))}
      <div className="sidebar-section-title">Online</div>
      {users.map((user) => (
        <div key={user.id} className="member-row">
          <span className={"presence-dot" + (presence.has(user.username) ? " online" : "")} />
          {user.username}
        </div>
      ))}
    </aside>
  );
}
