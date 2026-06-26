# The financial assistant is a contextual layer

worthline's **financial assistant** is a contextual layer over the current product surface, not a separate destination page. It can access the full workspace, but the UI supplies the current route, scope, selected holding, visible figure, or other screen context so the assistant can answer from what the user is looking at and then drill into the broader workspace through chat tools.

This captures the desired agent interaction feel without committing the app to a specific component library. The implementation may use shadcn chat components, AI Elements, or local components, but it should preserve stable streaming, visible tool activity, clear cited facts or assumptions, and future confirmation flows in the same layer rather than sending the user elsewhere.

Internal sources shown by the assistant should link to the relevant worthline surface when there is a clear destination, and following those links should keep the assistant layer open. Navigation changes the screen context underneath the conversation; it does not discard the chat.
