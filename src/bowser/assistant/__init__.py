"""The page's Assistant: a chat with the user's own AI provider.

- :mod:`.relay`: the routes (``/assistant/...``) and the tool loop, shared by the
  full server and bowser-lite;
- :mod:`.providers`: the provider presets and their wire formats;
- :mod:`.keys`: API keys kept on this computer (keychain or a private file).

The data tools are :mod:`bowser.tools`, the same as ``bowser mcp``'s.
"""
