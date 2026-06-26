# Chat tools wrap agent view instead of reusing MCP verbatim

The in-app **financial assistant** uses chat-specific read tools backed by the same internal **agent view** services, rather than exposing the MCP or HTTP contracts verbatim to the model. Tool names and outputs may be shaped for conversation, but calculation logic and workspace access stay in the existing agent-view layer.

This avoids duplicating financial logic while keeping MCP as an external integration contract and the in-app chat as a product-specific UX. A future write-capable assistant should follow the same pattern: chat tools draft **assistant proposals**, and the domain layer validates and applies them.
