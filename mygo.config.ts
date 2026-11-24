// The configuration of the app, which `mygo dev` and `mygo build` evaluate with
// Bun, of the command running. The development app (`mygo dev`) opens links of a
// scheme of its own, for the installed app to keep mygo-music:// links.
//
// NetEase build: version 0.1.26 ships the NetEase plugin and opens on it. There
// is no update feed, as upstream's releases play local files first.
export default ({ command }: { command: string }) => ({
  name: "MyGo Music",
  identifier: "dev.egoist.music",
  slug: "mygo-music",
  version: "0.1.26",
  out: "build",
  urlSchemes: [command === "dev" ? "mygo-music-dev" : "mygo-music"],
  // No updates: this build opens on NetEase Cloud Music, and the app's
  // repository releases the local files player.
  macos: {
    icon: "icon/AppIcon.icon",
    minimumSystemVersion: "13.0",
    // No signing identity here: set your own locally to sign and notarise a
    // macOS release. The upstream one cannot sign builds from this machine.
  },
  linux: {
    comment: "A player for NetEase Cloud Music and more",
    categories: ["AudioVideo", "Audio", "Player"],
    webview: false,
  },
});
