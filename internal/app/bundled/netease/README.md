# MyGo NetEase Cloud Music plugin

An unofficial NetEase Cloud Music source for [MyGo Music](https://github.com/egoist/mygo-music).
It adds an account, a catalog and playback to the player the app already has; the
app's interface and source code stay as they are.

The plugin signs in with NetEase's QR code login or its own sign-in page, keeps
the session in the plugin's storage, and speaks the APIs the NetEase desktop
and web clients use.

## Features

- QR code sign-in in the app's sign-in dialog, or NetEase's sign-in page in a
  window of its own
- A manual `MUSIC_U` cookie for when neither way in works
- Home with the daily recommendations, recommended playlists, charts and new
  songs
- Search for songs, albums, artists, playlists and podcasts, with suggestions
- The listener's playlists, liked songs, saved albums, followed artists and
  recent plays
- Album, artist, playlist and podcast pages
- LRC lyrics, word-timed YRC lyrics and translations
- Comments, liking songs and comments, posting comments
- Playlist creation, renaming, deletion and adding or removing songs
- Standard, higher, exhigh, lossless and Hi-Res audio, capped by a setting and
  the app's Quality setting
- Personal FM stations

## Install

Copy this folder to the app's `plugins` directory, as `netease`:

| Platform | Directory |
| --- | --- |
| Windows | `%APPDATA%\MyGo Music\plugins\netease` |
| macOS | `~/Library/Application Support/MyGo Music/plugins/netease` |
| Linux | `~/.config/MyGo Music/plugins/netease` |

Restart MyGo Music. The NetEase Cloud Music source appears in the sidebar's
source switcher. Its settings are under Settings > Plugins > NetEase Cloud
Music, where the sign-in method and the highest quality are chosen.

Click **Sign in** in the player, then scan the QR code with the NetEase Cloud
Music app, or switch the sign-in method to the sign-in page and use NetEase's
own page.

## Settings

| Setting | Meaning |
| --- | --- |
| Sign-in method | `QR code in the app` (the default) or `NetEase sign-in page` |
| Highest quality | `Automatic (Hi-Res)` (the default), or a fixed level. A song plays at the lower of this and the app's Quality setting. |
| Cookie | Optional. A `MUSIC_U=...` cookie from a browser, stored as plain text, for when signing in here fails. |

## Verified

Tested on Windows with MyGo Music 0.1.25 and a signed-in NetEase account:
QR and page sign-in, Home, search, liked songs, playlists, saved albums,
followed artists, podcast comments, personal FM, LRC/YRC lyrics, and
standard-to-Hi-Res playback. Edits are exercised reversibly: liking and
unliking, saving and unsaving an album, following and unfollowing an artist,
and creating, filling, renaming and deleting a playlist.

The test machine's eapi requests are refused with `-460`, so the web API's
encrypted fallback is what served the VIP lossless stream.

## Limits

- This is not an official client. NetEase can change, throttle or refuse these
  endpoints, and the plugin may stop working without notice.
- Playback rights are whatever the signed-in account has. A song the account
  may not play shows as unavailable, or answers NetEase's refusal.
- Reordering a playlist's songs is not implemented; NetEase has no endpoint
  for moving a song within a playlist that the plugin can use here.
- An episode's heart and comments use the episode's program thread once its
  show page has been opened, which is how the plugin learns the program ID.
- The session cookie is kept in MyGo Music's plugin data as plain JSON. The
  app's plugin storage is not encrypted.

## Test

The smoke test calls the plugin's exports with a mock `host`, using live
NetEase endpoints for anonymous pages:

```bash
node test/smoke.mjs
```

Signing in needs a person and a phone, so it is not part of the smoke test.

## License

MIT. This project is not affiliated with NetEase or MyGo Music. Music rights
belong to their owners. Use it with an account you own, and follow the law and
the service's terms where you are.