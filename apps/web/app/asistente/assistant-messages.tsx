import type { ReactNode } from "react";

import ThirdPartyAiNotice from "./third-party-ai-notice";

/**
 * Scrollable conversation column for the assistant layer. The third-party AI
 * notice is rendered before any turn content so it stays visible in every chat
 * state (#955).
 */
export default function AssistantMessages({ children }: { children: ReactNode }) {
  return (
    <div className="assistantMessages">
      <ThirdPartyAiNotice />
      {children}
    </div>
  );
}
