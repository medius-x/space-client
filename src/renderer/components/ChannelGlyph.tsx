/**
 * oak's channel glyph with the lock cut-out (Icons.channelGlyph): when the channel
 * is locked for the viewer, the #/🔊 glyph loses its bottom-right quadrant (CSS
 * clip — oak used Shape.subtract) to a small mdi-lock, Discord's "locked" look.
 * The wrapper keeps the plain glyph's 18px slot so rows don't shift on the flag.
 */
export function ChannelGlyph({ voice, locked }: { voice: boolean; locked: boolean }): React.JSX.Element {
  const glyphClass = "icon channel-glyph " + (voice ? "mdi-volume-high" : "mdi-pound");
  if (!locked) {
    return <span className={glyphClass} />;
  }
  return (
    <span className="channel-glyph-locked">
      <span className={glyphClass + " glyph-cut"} />
      <span className="icon mdi-lock channel-glyph-lock" />
    </span>
  );
}
