"use client";

import { useEffect } from "react";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      const isProd = process.env.NODE_ENV === "production";
      // E2E local tests run on ports 3001, 3002, 3004.
      const isE2E = window.location.port !== "3000";

      if (isProd || isE2E) {
        navigator.serviceWorker
          .register("/sw.js")
          .then((registration) => {
            if (!isProd) {
              console.log("Service Worker registered with scope:", registration.scope);
            }
          })
          .catch((error) => {
            console.error("Service Worker registration failed:", error);
          });
      }
    }
  }, []);

  return null;
}
