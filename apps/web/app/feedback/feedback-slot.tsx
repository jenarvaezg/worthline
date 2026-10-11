"use client";

import { useEffect, useState } from "react";

import FeedbackLauncher from "./feedback-launcher";
import { feedbackAvailableAction } from "./submit-feedback-action";

/**
 * «Enviar feedback» for the surfaces that cannot ask the server while rendering
 * (#1174): the root error boundary, which must be a client component and replaces
 * the workspace top bar exactly when something broke, and the legal cover, which
 * is static by construction and must stay so.
 *
 * It asks once, after mount, whether this session may send (`canSendFeedback`,
 * the same rule as everywhere else) and shows the button only then — so the demo
 * and the local mode never see a button the server would refuse. Until the answer
 * arrives, and if the question fails, there is simply no button.
 */
export default function FeedbackSlot() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let live = true;
    feedbackAvailableAction().then(
      (answer) => {
        if (live) setAvailable(answer);
      },
      (error: unknown) => {
        console.error("[feedback] availability check failed: button hidden", error);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  return available ? <FeedbackLauncher /> : null;
}
