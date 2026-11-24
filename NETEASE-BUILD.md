# NetEase build

MyGo Music 0.1.26 in this folder plays **NetEase Cloud Music** and nothing else.
It opens on it, ships its plugin inside the binary, and has no local files
interface, no plugin installer, no source switcher and no update check. This is
the map of what was changed, and where.

The inline markers are written as `NetEase build:` comments. Find them with:

```bash
grep -rn "NetEase build" internal/ mygo.config.ts
```

## Source map

Line numbers are those of 0.1.26 in this folder.

| Where | What changed |
| --- | --- |
| `internal/app/bundled.go:17` `defaultSourceID` | `"netease"`: the one source this build has, and the one it opens on. |
| `internal/app/bundled.go:28` `installBundledPlugins` | Writes the embedded plugin into the plugins directory when it isn't installed yet, README beside it. |
| `internal/app/bundled/netease/` | New. The NetEase Cloud Music plugin (`plugin.json`, `index.js`, `README.md`), embedded with `//go:embed`. |
| `internal/app/app.go:223` `makeSources` | Loads the shipped plugin, ignores any other, and makes the NetEase library the app's only source. |
| `internal/app/app.go:245` `pluginsDir` | The plugins directory, under the user data directory. |
| `internal/app/app.go:277` | No updater: an update from upstream would put local files first again. |
| `internal/app/app.go:290` | With the plugin unloadable, a native error says so and the app quits instead of opening an empty window. |
| `internal/app/settings.go:87` `defaultSettings` | `Source` defaults to `netease`; `DisabledPlugins`, `PluginsChecked` and `PluginUpdates` are gone. |
| `internal/app/sources.go:176` `boot` | Only starts the active library and restores the session. No local rescan, no plugin update check. |
| `internal/app/sources.go:182` `startLibrary` | What the sidebar and Home show of a source, asked once. |
| `internal/app/sources.go:322` `pluginOf` | The plugin a source is, or nil; kept for the language change. |
| `internal/app/ui_main.go` | The sidebar has no source switcher: the `sourceSwitcher` function and its call are gone. |
| `internal/app/ui_settings.go:382` | Settings > "Plugins" is Settings > "Source" (`T("Source")`), and it is the only source page. |
| `internal/app/ui_settings.go:494` `sourceSettings` | Shows the app's one source, not a list of them. |
| `internal/app/ui_settings.go:508` `pluginSettings` | Who's signed in, permissions, and the plugin's settings. The Enable switch, update notices and the install/update/remove menus are gone. |
| `internal/app/ui_settings.go:61` `openSourceSettings` | Opens the "source" page. |
| `internal/app/ui_settings.go` | The Update settings section is gone, with its updater. |
| `internal/app/menu.go:23` | The app menu has no "Check for Updates…". |
| `internal/app/tray.go` | The tray menu has no "Check for Updates…". |
| `internal/app/session.go:28` `saveSession` | A no-op without a player, as the no-source path quits before one is made. |
| `internal/app/download.go:32` `canDownload` | The `local.ID` exception is gone; there is no local source. |
| `internal/music/fetch.go:115` `PathOf` | Fixed a `file://C:/…` URL losing its drive on Windows, and UNC host paths. `internal/music/fetch_path_test.go` covers it. |
| `internal/plugin/version.go` | `IsNewer` and `versionNumbers` only: they check a plugin's `minAppVersion`. |
| `mygo.config.ts:5` | Version `0.1.26`, no `updates` block. |
| `README.md`, `CHANGELOG.md` | Describe this build, its version, and what it no longer does. |

## What is gone

Deleted, with the code that only they used:

- **The local files source**: the whole `internal/local` package, its sidebar
  entry, Home empty state, `pickFolders`/`addMusicFolder`, the "Local Files"
  settings row with its folder list and rescan/add/remove buttons,
  `mygoOpenFolders`, the `local.ID` exception in downloads, and the folder icon.
  The `local` plugin ID stays reserved in `internal/plugin/plugin.go`, so a
  plugin can't take the source of the tracks and sessions from before.
- **Plugin install, update and removal**: `internal/app/plugin_install.go`,
  `internal/plugin/install.go` and its tests, the + menu and dialogs in the
  settings, the per-plugin Enable switch and ⋯ menu, `keepCheckingPlugins`,
  `checkResult`, `pluginInstaller`, `installer`, `updates` and the GitHub
  download/unzip/version-compare code behind them.
- **Source switching**: `sourceSwitcher` in the sidebar, `switchSource`,
  `openedLibrary`, `allLibs`, and the `Source` picker in the account dialog.
- **Update checking**: `internal/app/updates.go` and `updates_test.go`, the
  `updates` block of `mygo.config.ts`, and both "Check for Updates…" menu items.
- **The rest of the repository**: `examples/`, `website/`, `.github/`,
  `scripts/`, `.agents/`, `RELEASING.md`, `package.json`, `bun.lock`.

`go mod tidy` took out `github.com/dhowden/tag` and `golang.org/x/text` as
direct requirements: nothing imports them now.

## Artifacts

```bash
go test ./internal/...
go tool mygo vet .
go tool mygo build
```

- `../mygo-music-package/windows-amd64/MyGo Music.exe`
- `../mygo-music-package/windows-amd64/mygo-music-setup-0.1.26-amd64.exe`
- `../mygo-music-package/windows-amd64/SHA256SUMS.txt`

Build artifacts live in the sibling `mygo-music-package` folder, separate from
this source tree; `go tool mygo build` still writes into `build/` here, and the
packaged files are then moved over. Intermediate outputs (build leftovers,
screenshots) are not kept.