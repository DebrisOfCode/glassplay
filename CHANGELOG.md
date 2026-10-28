# Changelog

## 1.1.1

### Fixed

- On TV, the *Back to top* button can now be reached with the remote: from the last button of a row
  (*⋯*), press right. After OK the list returns to the top with the focus on the first channel.

## 1.1.0

### New

- **Program guide** (XMLTV, from the Xtream panel or the list's `url-tvg`), downloaded in the background
  at most every 6 hours:
  - the program on air under each channel name, also in the hover preview;
  - **search by program**: the search box also finds channels by what they are airing now;
  - **TV guide page** (calendar button or `G`): full screen, channels × hours, from 12 hours ago to
    48 hours ahead, with *Earlier / Now / Later* buttons. The video keeps playing in a corner; a program
    on air starts with a click, a future one shows its details.
- **Public lists**: with no list, and from the lists menu (*Browse public lists…*), free and legal lists
  collected by volunteers: [iptv-org](https://github.com/iptv-org/iptv) by country (yours first) or
  category, and [Free-TV](https://github.com/Free-TV/IPTV).
- **Proxy**: Options → *Proxy settings…* routes all traffic (lists, guide, video, logos) through your own
  SOCKS5, HTTP or HTTPS proxy, with a test showing the IP address websites see.
- **Back to top** button in the channel list; on TV also page up / page down.
- **TV build** for Android (now the Android download): Android's own video player (ExoPlayer) with
  hardware decoding for smooth HD on low-power boxes, a lighter interface that also runs on the stock
  WebView of Android 9 (Chromium 66), and adult channels excluded from every list.

### Faster

- Lists stay in the Rust backend in a compact form and the interface only receives the rows on screen:
  with 300,000 channels the WebView uses about 2 MB instead of about 100 MB, and on a PC opens in under a second.
- Lists are downloaded straight to disk and read line by line; reading is about twice as fast.
- Search runs in Rust.
- Smaller video buffers, lighter animations while a channel is playing.

### Fixed

- Android TV boxes that report the remote as a pointer were treated like a computer: the channel panel kept
  disappearing and reappearing. TV mode is now detected by the app itself.
- On TV the remote now scrolls the channel list (it stopped at the rows on screen).
- On TV, OK in the welcome screen's address field now adds the list.
- Remote navigation prefers items really in the pressed direction.
- Menus are more compact.
- The Android build script also works without Windows Developer Mode.

## 1.0.0

First public release.
