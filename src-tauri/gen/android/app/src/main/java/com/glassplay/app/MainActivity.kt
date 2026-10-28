package com.glassplay.app

import android.app.UiModeManager
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import okhttp3.Credentials
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.net.Authenticator
import java.net.InetSocketAddress
import java.net.PasswordAuthentication
import java.net.Proxy
import java.util.concurrent.TimeUnit

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Sui televisori (Android TV, Google TV, box come lo Xiaomi Mi Box S) l'interfaccia usa la
  // navigazione con il telecomando: lo segnala "GlassPlayTV" nello user agent (vedi app.js).
  // Le media query della WebView non bastano, perché molti box dichiarano il telecomando
  // come dispositivo di puntamento. Viene chiamato prima che la pagina venga caricata.
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    val uiMode = getSystemService(UI_MODE_SERVICE) as? UiModeManager
    val isTv = uiMode?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
      packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
    if (isTv) {
      webView.settings.userAgentString = "${webView.settings.userAgentString} GlassPlayTV"
    }
    webView.addJavascriptInterface(NativeBridge(), "GlassPlayNative")
  }

  // ---------- Lettore video nativo (versione legacy) ----------
  //
  // Sui TV box poco potenti hls.js non regge i flussi ad alta definizione: deve ricomporre il
  // video in JavaScript prima di passarlo al decoder. ExoPlayer legge HLS e MPEG-TS direttamente
  // e usa i decoder hardware del box. La sua vista sta sotto la WebView, che diventa trasparente:
  // l'interfaccia resta quella di sempre, disegnata sopra il video.

  private var player: ExoPlayer? = null
  private var playerView: PlayerView? = null
  private var token = 0
  private var subsOn = false
  private var textTracks = -1
  private var resumeOnStart = false
  private var proxy: Proxy = Proxy.NO_PROXY
  private var proxyAuth: String? = null

  /** Metodi chiamati dalla pagina (window.GlassPlayNative): arrivano su un altro thread. */
  inner class NativeBridge {
    @JavascriptInterface fun play(url: String, token: Int) = runOnUiThread { start(url, token) }
    @JavascriptInterface fun stop() = runOnUiThread { stopPlayback() }
    @JavascriptInterface fun setVolume(volume: Float) = runOnUiThread { player?.volume = volume }
    @JavascriptInterface fun setSubtitles(on: Boolean) = runOnUiThread { subsOn = on; applySubtitles() }

    /** Area del video in pixel dello schermo; larghezza 0 = tutto lo schermo. */
    @JavascriptInterface fun setRect(x: Int, y: Int, w: Int, h: Int) = runOnUiThread { place(x, y, w, h) }

    /** Proxy per il video ("http" o "socks"); host vuoto = nessuno. */
    @JavascriptInterface fun setProxy(type: String, host: String, port: Int, user: String, pass: String) =
      runOnUiThread { configureProxy(type, host, port, user, pass) }
  }

  private fun emit(event: String, data: JSONObject = JSONObject()) {
    val js = "window.__nativePlayer&&window.__nativePlayer($token,${JSONObject.quote(event)},$data)"
    webView?.evaluateJavascript(js, null)
  }

  private val listener = object : Player.Listener {
    override fun onIsPlayingChanged(isPlaying: Boolean) {
      if (isPlaying) emit("playing")
    }

    override fun onPlaybackStateChanged(state: Int) {
      when (state) {
        Player.STATE_BUFFERING -> emit("waiting")
        Player.STATE_ENDED -> emit("ended")
      }
    }

    override fun onPlayerError(error: PlaybackException) {
      emit("error", JSONObject().put("code", error.errorCodeName))
    }

    override fun onTracksChanged(tracks: Tracks) {
      val count = tracks.groups.count { it.type == C.TRACK_TYPE_TEXT && it.isSupported }
      if (count != textTracks) {
        textTracks = count
        emit("subtitles", JSONObject().put("available", count > 0))
        applySubtitles()
      }
    }
  }

  private fun ensurePlayer(): ExoPlayer {
    player?.let { return it }
    val view = PlayerView(this).apply {
      useController = false
      isFocusable = false
      isFocusableInTouchMode = false
      keepScreenOn = true
      resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
      setShutterBackgroundColor(Color.BLACK)
    }
    val content = findViewById<ViewGroup>(android.R.id.content)
    content.addView(view, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    // Dove la pagina è trasparente e il video non arriva (miniatura della guida) si vede il nero.
    content.setBackgroundColor(Color.BLACK)
    webView?.setBackgroundColor(Color.TRANSPARENT)

    // Buffer contenuti: il box ha 2 GB di memoria per tutto il sistema.
    val loadControl = DefaultLoadControl.Builder()
      .setBufferDurationsMs(8_000, 30_000, 1_500, 3_000)
      .build()
    val p = ExoPlayer.Builder(this)
      .setLoadControl(loadControl)
      .setMediaSourceFactory(mediaSourceFactory())
      .build()
    p.addListener(listener)
    view.player = p
    player = p
    playerView = view
    return p
  }

  private fun mediaSourceFactory(): DefaultMediaSourceFactory {
    val client = OkHttpClient.Builder()
      .proxy(proxy)
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(20, TimeUnit.SECONDS)
      .apply {
        proxyAuth?.let { auth ->
          proxyAuthenticator { _, response -> response.request.newBuilder().header("Proxy-Authorization", auth).build() }
        }
      }
      .build()
    // Molti server IPTV accettano solo user agent da lettore (come il resto dell'app).
    val http = OkHttpDataSource.Factory(client).setUserAgent("VLC/3.0.20 LibVLC/3.0.20")
    val extractors = DefaultExtractorsFactory()
      .setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES)
    return DefaultMediaSourceFactory(http, extractors)
  }

  private fun start(url: String, token: Int) {
    this.token = token
    textTracks = -1
    val p = ensurePlayer()
    playerView?.visibility = View.VISIBLE
    val item = MediaItem.Builder().setUri(url)
    if (url.substringBefore('?').endsWith(".m3u8", ignoreCase = true)) item.setMimeType(MimeTypes.APPLICATION_M3U8)
    p.setMediaItem(item.build())
    p.prepare()
    p.playWhenReady = true
  }

  private fun stopPlayback() {
    player?.stop()
    player?.clearMediaItems()
    playerView?.visibility = View.GONE
  }

  /** Sottotitoli (anche DVB, disegnati da ExoPlayer): la prima traccia, se richiesti. */
  private fun applySubtitles() {
    val p = player ?: return
    val groups = p.currentTracks.groups.filter { it.type == C.TRACK_TYPE_TEXT && it.isSupported }
    val params = p.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT)
    if (subsOn && groups.isNotEmpty()) {
      params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
        .setOverrideForType(TrackSelectionOverride(groups[0].mediaTrackGroup, 0))
    } else {
      params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
    }
    p.trackSelectionParameters = params.build()
  }

  private fun place(x: Int, y: Int, w: Int, h: Int) {
    val view = playerView ?: return
    view.layoutParams = if (w <= 0 || h <= 0) {
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    } else {
      FrameLayout.LayoutParams(w, h, Gravity.TOP or Gravity.START).apply {
        leftMargin = x
        topMargin = y
      }
    }
  }

  private fun configureProxy(type: String, host: String, port: Int, user: String, pass: String) {
    proxy = if (host.isEmpty()) {
      Proxy.NO_PROXY
    } else {
      Proxy(if (type == "socks") Proxy.Type.SOCKS else Proxy.Type.HTTP, InetSocketAddress.createUnresolved(host, port))
    }
    proxyAuth = if (host.isNotEmpty() && user.isNotEmpty() && type != "socks") Credentials.basic(user, pass) else null
    // I proxy SOCKS chiedono le credenziali al sistema.
    Authenticator.setDefault(
      if (host.isNotEmpty() && user.isNotEmpty() && type == "socks") {
        object : Authenticator() {
          override fun getPasswordAuthentication() = PasswordAuthentication(user, pass.toCharArray())
        }
      } else {
        null
      },
    )
    // Il lettore si ricrea alla prossima riproduzione con il nuovo instradamento.
    player?.let {
      it.release()
      player = null
      playerView?.let { v -> (v.parent as? ViewGroup)?.removeView(v) }
      playerView = null
    }
  }

  override fun onStop() {
    super.onStop()
    resumeOnStart = player?.isPlaying == true
    player?.pause()
  }

  override fun onStart() {
    super.onStart()
    if (resumeOnStart) player?.play()
  }

  override fun onDestroy() {
    player?.release()
    player = null
    super.onDestroy()
  }
}
