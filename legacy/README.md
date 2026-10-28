# GlassPlay Legacy

A lighter Android build for low-power TV boxes, such as the **Xiaomi Mi Box S**
(Amlogic S905X, quad-core Cortex-A53, Mali-450 GPU, 2 GB RAM, Android 9).

It is the same app with the same features, minus what costs the most on that kind of hardware:

| | Regular build | Legacy build |
|---|---|---|
| Glass panels | Blurred background (`backdrop-filter`) | Solid translucent panels: the blur had to be recomputed on every video frame |
| Video player | hls.js in the WebView | Android's own player (ExoPlayer) with the box's hardware decoders, drawn under the interface: HD decoding no longer depends on the slow CPU, and DVB subtitles are shown by the player (with an https:// proxy it falls back to hls.js) |
| Hover preview | Desktop only | Removed completely (no second video player) |
| Background | Animated | Still, and hidden while a channel is playing |
| Channel switch | Zoom and blur of the video, 300 ms pause | Plain fade, immediate |
| Animations | Springy list, panel and dialog motion | Short fades and slides only; no continuous animations |
| Video buffer | 30 s ahead (at most 120 s), 30 s behind | 8–30 s in ExoPlayer (20 s / 25 MB with hls.js, quality capped to the screen size) |
| WebView | Recent Android System WebView | Also Chromium 66+ (stock Android 9): code converted with esbuild, small polyfills |
| CPU architectures | ARM and x86 | ARM only (armeabi-v7a, arm64-v8a) |
| Adult content | Shown | Excluded from every list: adult groups ("XXX", "Adults", "18+"…) and adult channel brands (Rust feature `adult-filter`, `src-tauri/src/adult.rs`) |

Big lists are handled the same way in both builds: the channels stay in the Rust backend in a
compact form, and the interface only receives the rows on screen. A list with 300,000 channels
uses about 2 MB in the WebView, instead of about 100 MB with GlassPlay 1.0.

## Build

From the repository root (same requirements as the regular Android build, plus
[Node.js](https://nodejs.org) for the conversion; esbuild is fetched automatically by `npx`):

```powershell
.\build.ps1 -Legacy        # -> legacy\dist\GlassPlay-legacy.apk
```

Options: `-Targets armv7` (only 32-bit ARM, smaller APK), `-DebugBuild` (debug APK, which can be inspected
from `chrome://inspect`).

The script copies `ui/` to `legacy/build/ui/`, adds `lite.css` and `lite.js`, converts the code for
Chromium 66 and builds the APK with `tauri.legacy.conf.json`. `build/` and `dist/` are not part of the
repository.

## Install

The legacy APK uses the same package name as the regular app. It replaces it on the device and keeps
lists, folders and settings. Copy it to a USB stick and open it with a file manager, or use
`adb install -r GlassPlay-legacy.apk`.

If the box lets you, update *Android System WebView* from the Play Store: newer WebViews are faster.

## Files

- `lite.css`: overrides for `ui/style.css`, active only with the `lite` class
- `lite.js`: switches the app to the lite mode (`window.GLASSPLAY_LITE`) and adds the missing functions
  of old WebViews
- `tauri.legacy.conf.json`: points the Android build to the prepared interface
