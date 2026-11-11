package sh.ratel.beluga.control

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import sh.ratel.beluga.control.link.ControlLink
import sh.ratel.beluga.control.link.Phone

/**
 * The app's handle on phone control (BLG-150): it runs the Mac's ops, says what this phone can do,
 * finds its own Wireless-debugging port over mDNS, and shows the "Your Mac is using this phone"
 * notification. Reading and acting on the screen happen in Beluga Link, a small add-on
 * app with the Accessibility service (BLG-377), which AddonClient talks to.
 */
class PhoneControlModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  private var nsd: NsdManager? = null
  private var adbListener: NsdManager.DiscoveryListener? = null
  private var pairListener: NsdManager.DiscoveryListener? = null

  override fun definition() = ModuleDefinition {
    Name("PhoneControl")
    Events("adb", "accessibility", "stopped", "mirror", "mirrorEnd")
    current = this@PhoneControlModule
    OnCreate { runCatching { AddonClient.connect(context) } }
    // Back in the app: Beluga Link may have been installed or updated meanwhile.
    OnActivityEntersForeground { runCatching { AddonClient.connect(context) } }

    AsyncFunction("perform") { op: String, args: String ->
      val parsed = if (args.isBlank()) JSONObject() else JSONObject(args)
      // Live video is Android's screen capture, not the Accessibility service's (Beluga Link only
      // lends its right to open the "Start now" sheet from the background).
      if (op == "mirror") return@AsyncFunction MirrorService.control(context, parsed)
      // A proof for the Mac (BLG-189), facts and apps, and a settings screen for the person (BLG-190): no Accessibility needed.
      if (op == "proof") return@AsyncFunction proof(context, parsed.getString("nonce")).toString()
      if (op == "info") return@AsyncFunction Phone.deviceInfoJson(context).toString()
      if (op == "apps") return@AsyncFunction Phone.apps(context).toString()
      AddonClient.connect(context)
      if (op == "open" && parsed.has("settings") && !AddonClient.on) {
        Phone.openOnPhone(context, parsed)
        return@AsyncFunction "{}"
      }
      if (!AddonClient.on) throw IllegalStateException(if (AddonClient.installed(context)) "Turn on Accessibility for Beluga Link on the phone" else AddonClient.MISSING)
      AddonClient.perform(op, args)
    }

    Function("accessibilityEnabled") { AddonClient.connect(context); AddonClient.on }
    Function("canScreenshot") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && AddonClient.on }
    Function("addonInstalled") { AddonClient.installed(context) }
    Function("deviceInfo") { Phone.deviceInfoJson(context).toString() }
    Function("canMirror") { MirrorService.supported }
    Function("mirrorAck") { seq: Int -> MirrorService.ack(seq) }

    Function("openAccessibilitySettings") {
      context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    // Beluga Link: open it when it's here (it takes you to Accessibility), else where to download it.
    Function("openAddon") {
      val intent = if (AddonClient.installed(context)) Intent().setClassName(ControlLink.ADDON_PACKAGE, ControlLink.ADDON_SETUP) else Intent(Intent.ACTION_VIEW, Uri.parse(ADDON_URL))
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    Function("startControlNote") { text: String -> showNote(context, text) }
    Function("stopControlNote") { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTE_ID) }

    Function("startAdbDiscovery") { startDiscovery() }
    Function("stopAdbDiscovery") { stopDiscovery() }

    OnDestroy { stopDiscovery(); if (current === this@PhoneControlModule) current = null }
  }

  // ---- Wireless debugging discovery (mDNS)

  private fun startDiscovery() {
    val manager = nsd ?: (context.getSystemService(Context.NSD_SERVICE) as NsdManager).also { nsd = it }
    if (adbListener == null) adbListener = resolveListener("_adb-tls-connect._tcp", isPairing = false).also { manager.discoverServices("_adb-tls-connect._tcp", NsdManager.PROTOCOL_DNS_SD, it) }
    if (pairListener == null) pairListener = resolveListener("_adb-tls-pairing._tcp", isPairing = true).also { manager.discoverServices("_adb-tls-pairing._tcp", NsdManager.PROTOCOL_DNS_SD, it) }
  }

  private fun stopDiscovery() {
    adbListener?.let { runCatching { nsd?.stopServiceDiscovery(it) } }
    pairListener?.let { runCatching { nsd?.stopServiceDiscovery(it) } }
    adbListener = null
    pairListener = null
    adbPort = null
    pairPort = null
  }

  private fun resolveListener(type: String, isPairing: Boolean): NsdManager.DiscoveryListener = object : NsdManager.DiscoveryListener {
    override fun onServiceFound(info: NsdServiceInfo) {
      val cb = object : NsdManager.ResolveListener {
        override fun onServiceResolved(resolved: NsdServiceInfo) {
          // Only this phone's own adbd is on the loopback/local address; the port is what we need.
          if (isPairing) pairPort = resolved.port else adbPort = resolved.port
          emitPorts()
        }
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {}
      }
      runCatching { nsd?.resolveService(info, cb) }
    }
    override fun onServiceLost(info: NsdServiceInfo) {
      if (isPairing) pairPort = null else adbPort = null
      emitPorts()
    }
    override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
    override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
    override fun onDiscoveryStarted(serviceType: String) {}
    override fun onDiscoveryStopped(serviceType: String) {}
  }

  private fun emitPorts() {
    val payload = JSONObject()
    adbPort?.let { payload.put("port", it) }
    pairPort?.let { payload.put("pairing", it) }
    sendEvent("adb", mapOf("port" to adbPort, "pairing" to pairPort))
  }

  companion object {
    const val NOTE_ID = 4208
    const val CHANNEL = "mac-using-phone"
    /** Where Beluga Link is downloaded: it's attached to each release beside the app. */
    const val ADDON_URL = "https://github.com/beluga-labs/beluga/releases/latest/download/Beluga-Link.apk"
    @Volatile private var current: PhoneControlModule? = null
    @Volatile private var adbPort: Int? = null
    @Volatile private var pairPort: Int? = null

    init {
      AddonClient.onChange = { onAccessibilityChanged() }
    }

    /** Beluga Link's service connected or went away (or the screen changed): tell the JS so it re-reports control to the Mac. */
    fun onAccessibilityChanged() {
      current?.sendEvent("accessibility", mapOf("on" to AddonClient.on))
    }

    /** A piece of the screen's video for the Mac (MirrorService), as the `vid` frame carries it. */
    fun emitMirror(seq: Int, b64: String, key: Boolean, ts: Long, w: Int, h: Int, sw: Int, sh: Int) {
      current?.sendEvent("mirror", mapOf("seq" to seq, "b64" to b64, "key" to key, "ts" to ts.toDouble(), "w" to w, "h" to h, "sw" to sw, "sh" to sh))
    }

    /** The video stopped (the user said no or pressed Stop, or Android ended it). */
    fun emitMirrorEnd(reason: String?) {
      current?.sendEvent("mirrorEnd", mapOf("reason" to reason))
    }

    /** The Stop button on the "Your Mac is using this phone" notification: the JS turns control off. */
    fun onStopRequested(context: Context) {
      (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTE_ID)
      current?.sendEvent("stopped", mapOf<String, Any?>())
    }

    /**
     * Keep the Mac's one-time code where only adb on this phone can read it: the app's own files
     * folder on shared storage (other apps can't, adb's shell can). The Mac reads it back over a
     * direct Wireless-debugging connection: the device at that address is this phone (BLG-189).
     */
    fun proof(context: Context, nonce: String): JSONObject {
      require(Regex("^[0-9a-f]{32,64}$").matches(nonce)) { "Not a proof code" }
      val dir = context.getExternalFilesDir(null) ?: throw IllegalStateException("No shared storage for the proof")
      val file = java.io.File(dir, "beluga-proof")
      file.writeText(nonce)
      return JSONObject().put("path", file.absolutePath)
    }

    private fun showNote(context: Context, text: String) {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Your Mac is using this phone", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while your Mac's Claude is acting on this phone"
        })
      }
      val stop = PendingIntent.getBroadcast(
        context, 0,
        Intent(context, ControlActionReceiver::class.java).setAction(ControlActionReceiver.ACTION_STOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName).takeIf { it != 0 } ?: context.applicationInfo.icon
      val note: Notification = NotificationCompat.Builder(context, CHANNEL)
        .setContentTitle("Your Mac is using this phone")
        .setContentText(text.ifBlank { "Claude is acting on this phone" })
        .setSmallIcon(icon)
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_STATUS)
        .addAction(0, "Stop", stop)
        .build()
      nm.notify(NOTE_ID, note)
    }
  }
}
