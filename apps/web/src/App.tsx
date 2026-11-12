import { useEffect, useState } from "react";
import { APP_NAME } from "shared";
import { Jobs } from "./Jobs.tsx";
import { Library, Player } from "./Library.tsx";
import { NewEpisode } from "./NewEpisode.tsx";
import "./style.css";

export function App() {
  const [route, setRoute] = useState(() =>
    typeof window === "undefined" ? "#/new" : window.location.hash || "#/new",
  );
  useEffect(() => {
    const change = () => setRoute(window.location.hash || "#/new");
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const episodeRoute = route.startsWith("#/episode/");
  let id = "";
  if (episodeRoute) {
    try {
      id = decodeURIComponent(route.slice("#/episode/".length));
    } catch {
      id = "";
    }
  }
  const current = episodeRoute ? "library" : route.slice(2);
  return (
    <>
      <a
        className="skip"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="#/new">
            <span className="brand-mark" aria-hidden="true">
              ◖
            </span>
            {APP_NAME}
          </a>
          <nav aria-label="Main navigation">
            {[
              ["new", "New episode"],
              ["jobs", "Jobs"],
              ["library", "Library"],
            ].map(([path, label]) => (
              <a key={path} href={`#/${path}`} aria-current={current === path ? "page" : undefined}>
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {route === "#/jobs" ? (
          <Jobs />
        ) : route === "#/library" ? (
          <Library />
        ) : episodeRoute && id ? (
          <Player key={id} id={id} />
        ) : (
          <NewEpisode
            onCreated={() => {
              window.location.hash = "#/jobs";
            }}
          />
        )}
      </main>
    </>
  );
}
