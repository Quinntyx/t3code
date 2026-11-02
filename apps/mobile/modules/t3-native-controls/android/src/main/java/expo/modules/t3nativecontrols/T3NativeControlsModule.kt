package expo.modules.t3nativecontrols

import android.content.Intent
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.text.format.DateFormat
import android.view.PixelCopy
import androidx.core.content.FileProvider
import androidx.core.view.WindowInsetsControllerCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

class T3NativeControlsModule : Module() {
  private var filePreviewPromise: Promise? = null

  @Suppress("TooGenericExceptionCaught") // Clear the pending promise before rethrowing.
  override fun definition() = ModuleDefinition {
    Name("T3NativeControls")

    Function("is24HourFormat") {
      val context = appContext.reactContext ?: error("The app is not active.")
      DateFormat.is24HourFormat(context)
    }

    // The contrast scrim is off, so React Native no longer picks the button color.
    Function("setNavigationBarAppearance") { appearance: String ->
      val activity = appContext.currentActivity ?: return@Function
      activity.runOnUiThread {
        WindowInsetsControllerCompat(activity.window, activity.window.decorView)
          .isAppearanceLightNavigationBars = appearance == "light"
      }
    }

    AsyncFunction("captureScreenshot") { promise: Promise ->
      val activity = appContext.currentActivity ?: error("The app is not active.")
      activity.runOnUiThread {
        val view = activity.window.decorView
        if (view.width <= 0 || view.height <= 0) {
          promise.reject("SCREENSHOT_UNAVAILABLE", "The window is not ready.", null)
          return@runOnUiThread
        }
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        try {
          PixelCopy.request(
            activity.window,
            bitmap,
            { result ->
              try {
                check(result == PixelCopy.SUCCESS) { "Could not capture the window ($result)." }
                val directory = File(activity.cacheDir, "t3-composer-paste").apply { mkdirs() }
                val file = File.createTempFile("debug-shake-", ".png", directory)
                file.outputStream().use {
                  check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
                }
                promise.resolve(file.toURI().toString())
              } catch (error: Exception) {
                promise.reject("SCREENSHOT_FAILED", "Could not save the screenshot.", error)
              } finally {
                bitmap.recycle()
              }
            },
            Handler(Looper.getMainLooper())
          )
        } catch (error: Exception) {
          bitmap.recycle()
          promise.reject("SCREENSHOT_FAILED", "Could not capture the window.", error)
        }
      }
    }

    AsyncFunction("openFile") { uri: String, mimeType: String, promise: Promise ->
      check(filePreviewPromise == null) { "A document viewer is already open." }
      val activity = appContext.currentActivity ?: error("The app is not active.")
      val file = File(URI(uri)).canonicalFile
      require(file.isFile) { "The file is no longer available." }
      val contentUri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.FileSystemFileProvider",
        file
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, mimeType)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      filePreviewPromise = promise
      try {
        activity.startActivityForResult(intent, 7343)
      } catch (error: Exception) {
        filePreviewPromise = null
        throw error
      }
    }

    OnActivityResult { _, (requestCode) ->
      if (requestCode == 7343) {
        filePreviewPromise?.resolve(null)
        filePreviewPromise = null
      }
    }

    Function("getShowcasePairingUrl") {
      appContext.currentActivity?.intent?.getStringExtra("showcasePairingUrl")
    }

    Function("getShowcaseScene") {
      val storedScene = appContext.reactContext
        ?.filesDir
        ?.resolve("t3-showcase-scene")
        ?.takeIf { it.isFile }
        ?.readText()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
      storedScene ?: appContext.currentActivity?.intent?.getStringExtra("showcaseScene")
    }

    // The palette is fixed for the whole capture, so it only ever arrives as a
    // launch extra — unlike the scene, which the runner rewrites in place.
    Function("getShowcaseTheme") {
      appContext.currentActivity?.intent?.getStringExtra("showcaseTheme")
    }

    Function("prepareShowcaseCapture") {
      // Android app data is cleared by the host runner before launch.
    }

    Function("markShowcaseReady") { scene: String ->
      appContext.reactContext
        ?.filesDir
        ?.resolve("t3-showcase-ready")
        ?.writeText(scene)
    }
  }
}
