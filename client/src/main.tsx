/**
 * Claude Arcade: a menu of the arcade's games (`?game=` skips it), then the
 * game against the in-page arcade host, joined to that game's matches on this
 * server. `?name=` is the player's name in the lobby; `?pane` marks the hidden
 * browser that paints a terminal pane (mouse look from cursor movement, no
 * pointer lock). A seat freeing up for a spectator reloads the page into it.
 */

import { XAppsProvider } from "@xapps/sdk/react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { startArcadeHost, type GameId } from "./arcade/host";
import { LobbyConnection } from "./arcade/lobby";
import { GameMenu, parseGame } from "./arcade/menu";
import { FrontlineApp } from "./frontline/app";
import { FrontlineLoading } from "./frontline/loading";
import { setArcadeMode } from "./frontline/input";
import { ArcadeRally } from "./rally/arcade";
import { RallyLoading } from "./rally/loading";
import "./globals.css";

setArcadeMode(new URLSearchParams(window.location.search).has("pane"));

/** A line over the game the Claude Arcade mod sets ("Claude's done · back in 3"), via `window.__arcadeNotice`. */
function ArcadeNotice() {
  const [text, setText] = useState("");
  useEffect(() => {
    const w = window as unknown as { __arcadeNotice?: (text: string) => void };
    w.__arcadeNotice = (next) => setText(String(next));
    return () => {
      delete w.__arcadeNotice;
    };
  }, []);
  if (!text) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-16 z-50 flex justify-center">
      <div className="rounded-full bg-black/70 px-5 py-2 text-lg font-semibold text-white shadow-lg">{text}</div>
    </div>
  );
}

type Joined = { transport: ReturnType<typeof startArcadeHost>["transport"] };

function Arcade({ game }: { game: GameId }) {
  const [joined, setJoined] = useState<Joined | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams(window.location.search);
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${window.location.host}/lobby?game=${game}&name=${encodeURIComponent(params.get("name") ?? "")}`;
    LobbyConnection.open(url).then(
      ({ lobby, welcome }) => {
        if (!live) return lobby.close();
        lobby.on("reseat", () => window.location.reload());
        lobby.on("closed", () => {
          setError("Lost the arcade server. Reconnecting…");
          setTimeout(() => window.location.reload(), 3000);
        });
        setJoined({ transport: startArcadeHost(lobby, welcome, game).transport });
      },
      (e: Error) => {
        if (!live) return;
        setError(`${e.message}. Retrying…`);
        setTimeout(() => window.location.reload(), 5000);
      },
    );
    return () => {
      live = false;
    };
  }, [game]);

  const loading = game === "rally" ? <RallyLoading /> : <FrontlineLoading />;
  if (error) {
    return <div className="m-auto p-6 text-center text-sm text-ink-300">{error}</div>;
  }
  if (!joined) return loading;
  return (
    <XAppsProvider options={{ transport: joined.transport, gestures: false }} fallback={loading}>
      {game === "rally" ? <ArcadeRally /> : <FrontlineApp />}
    </XAppsProvider>
  );
}

function Root() {
  const [game, setGame] = useState<GameId | null>(() => parseGame(new URLSearchParams(window.location.search).get("game")));
  if (!game) {
    return (
      <GameMenu
        onPick={(picked) => {
          // In the address, so a reload (a seat freeing up) comes back to the same game.
          const url = new URL(window.location.href);
          url.searchParams.set("game", picked);
          window.history.replaceState(null, "", url);
          setGame(picked);
        }}
      />
    );
  }
  return <Arcade game={game} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div
      className="relative isolate flex min-h-dvh w-full flex-col overflow-hidden text-ink-50"
      style={{ "--accent-from": "#f2b544", "--accent-to": "#e2553a" } as React.CSSProperties}
    >
      <Root />
      <ArcadeNotice />
    </div>
  </StrictMode>,
);
