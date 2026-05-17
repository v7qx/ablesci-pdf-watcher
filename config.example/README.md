# Local Config Examples

Copy this folder to `config.local/` for real local configuration.

Files in `config.local/` are ignored by Git and must not be committed.

- `telegram.json`: Telegram bot parameters for CF / challenge alerts.
- `journal-access.json`: manually maintained journal access lists.
- `watcher-rules.json`: reserved for future advanced local watcher rules.

The extension and Native Helper search `config.local/` first when the settings page leaves a config path empty.
