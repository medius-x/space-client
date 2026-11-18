/**
 * The "which game is this?" dialog of the IGDB auto-detect (round 2,
 * 2026-11-19): when the server's match ladder answers "close, not equal" for a
 * running exe, the detector opens this ONCE per exe per session with the top
 * candidates. A click pins the pick into the server's SHARED match cache
 * (confirmGamePick — the same exe then resolves for everyone) and closes;
 * "skip" closes until the next client restart. The dialog retires itself when
 * the game closes (the detector's poll closes the pending pick).
 */
import { useStore } from "../hooks/useStore";
import { confirmGamePick, dismissGamePick, gameStore } from "../runtime";
import { Modal } from "./Modal";
import { useT } from "../hooks/useT";
import type { GameCard } from "../../types";

export function GamePickModal(): React.JSX.Element | null {
  const t = useT();
  const pick = useStore(gameStore, (state) => state.pendingPick);
  if (pick === null) {
    return null;
  }
  return (
    <Modal title={t("gamePick.title")} onClose={() => dismissGamePick()} narrow>
      <div className="game-pick">
        <div className="settings-hint">{t("gamePick.hint", { exe: pick.exeName })}</div>
        <div className="game-pick-list">
          {pick.candidates.map((card: GameCard) => (
            <button key={card.igdbId} className="game-pick-row"
              onClick={() => void confirmGamePick(card)}>
              {card.coverImageId !== null ? (
                <img alt="" src={`https://images.igdb.com/igdb/image/upload/t_cover_small/${card.coverImageId}.jpg`} />
              ) : <span className="game-pick-blank" />}
              <span className="game-pick-name">
                {card.name}
                {card.firstReleaseDate !== null
                  ? <span className="game-pick-year"> {new Date(card.firstReleaseDate * 1000).getFullYear()}</span>
                  : null}
              </span>
            </button>
          ))}
        </div>
        <div className="game-pick-actions">
          <button className="button" onClick={() => dismissGamePick()}>{t("gamePick.skip")}</button>
        </div>
      </div>
    </Modal>
  );
}
