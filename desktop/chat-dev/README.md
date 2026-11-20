# NetLogo Chat: Desktop edition (fork of NetLogo 7.1 alpha)

Adds a chat panel to NetLogo Desktop. The panel is a JavaFX WebView that loads the NetLogo Chat web UI
(`<server>/desktop`). The page controls NetLogo only through `window.nlDesktop`, attached **only** when the page origin equals
the configured chat server.

## Run
```
# 1. start the chat server (separate repo: netlogo-chat)   npm run dev      -> http://127.0.0.1:3000
# 2. start the desktop app
chat-dev/run.sh                                  # default server http://127.0.0.1:3000
NETLOGO_CHAT_URL=https://chat.example.com chat-dev/run.sh
NETLOGO_CHAT_URL=off chat-dev/run.sh             # plain NetLogo, no chat panel
```
Tools menu > "Chat Assistant" shows or hides the panel. Identity: a random id in `~/.netlogo-chat-id` is sent as the
`nlchat_uid` cookie (interim, until real accounts exist).

## Build (macOS, no admin rights needed)
* JDK 21 with JavaFX is NOT required separately: Temurin 21 is enough (JavaFX comes from Maven). `source ~/dev/netlogo-env.sh`.
* The checkout path must not contain spaces (upstream `stage.sh` breaks on them).
* npm must not use a dead proxy: the env script sets `NPM_CONFIG_USERCONFIG=/dev/null`.
* `brew install imagemagick` (build step that stamps the version on banners).
* `sbt netlogo/compile`, then `sbt "netlogo/extension nw" "netlogo/extension py" "netlogo/extension gis"`.
* `chat-dev/run.sh --refresh-classpath` after dependency changes.

## What differs from upstream NetLogo (keep this list short; rebase onto upstream tags)
| File | Change |
|---|---|
| `netlogo-gui/src/main/chat/*` | NEW: ChatBridge (control API for the agent), ChatPanel (WebView), ToggleChatAction, ChatDebug (dev only) |
| `netlogo-gui/src/main/app/App.scala` | mounts the panel (`BorderLayout.EAST`), registers the menu action |
| `netlogo-gui/src/main/window/GUIWorkspace.scala` | `runtimeErrorHook`: lets the chat capture runtime errors instead of showing the error dialog |
| `extensions/py/build.sbt` | `language-library` 3.3.3 -> 3.3.4 (3.3.3 does not link against NetLogo 7.1; upstream main has the same bug) |

## Dev-only debug channel
`NETLOGO_CHAT_DEBUG_PORT=9234 chat-dev/run.sh` opens `127.0.0.1:9234` (`/js`, `/shot`, `/ping`) so tests can drive the WebView.
Never enable on a shared machine. Tests: `npx tsx tests/e2e/desktop-bridge.mts` and `desktop-chat.mts "<prompt>"` in netlogo-chat.

## Notes found while building
* JavaFX 21 WebView sends `Upgrade: h2c`; Node servers (Next.js) drop the socket, so pages never load. We set
  `com.sun.webkit.useHTTP2Loader=false` (in code and in run.sh).
* `-Dnetlogo.docs.dir`, `netlogo.models.dir`, `netlogo.packages.dir` are required when running from source.
* Run `sbt` compile and app launch sequentially, never in parallel (the app loads whatever classes exist at launch).
