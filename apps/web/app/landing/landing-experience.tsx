"use client";

import { useEffect, useState } from "react";

import { hasAuthenticatedSession } from "./landing-motion";
import { startLandingOrchestration } from "./landing-orchestrator";

type SessionState = "pending" | "logged-out" | "logged-in";

interface LandingExperienceProps {
  netFinal: string;
  netTarget: number;
  sessionClassName: string | undefined;
  sessionPlaceholderClassName: string | undefined;
  sessionSlotClassName: string | undefined;
}

export default function LandingExperience({
  netFinal,
  netTarget,
  sessionClassName,
  sessionPlaceholderClassName,
  sessionSlotClassName,
}: LandingExperienceProps) {
  const [session, setSession] = useState<SessionState>("pending");

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: unknown) => {
        if (!controller.signal.aborted) {
          setSession(hasAuthenticatedSession(value) ? "logged-in" : "logged-out");
        }
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setSession("logged-out");
        }
      });

    return () => controller.abort();
  }, []);

  useEffect(
    () => startLandingOrchestration({ netFinal, netTarget }),
    [netFinal, netTarget],
  );

  return (
    <span className={sessionSlotClassName} data-session-slot="" aria-live="polite">
      <span className={sessionPlaceholderClassName} aria-hidden="true">
        Ir a mi panel
      </span>
      {session === "pending" ? null : (
        <a
          className={sessionClassName}
          href={session === "logged-in" ? "/app" : "/login"}
        >
          {session === "logged-in" ? "Ir a mi panel" : "Entrar"}
        </a>
      )}
      <noscript>
        <a className={sessionClassName} href="/login">
          Entrar
        </a>
      </noscript>
    </span>
  );
}
