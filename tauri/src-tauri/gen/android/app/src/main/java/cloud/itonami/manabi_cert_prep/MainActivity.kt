package cloud.itonami.manabi_cert_prep

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlin.math.max

// System bars and display cutout as padding of the content view, so the page
// never draws under the status or navigation bar (AWAI-3393; same approach as
// awai-os apps/isekai AWAI-3216, apps/x402 AWAI-3284 and Hiring AWAI-3392).
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
      insets
    }
    applySystemBarAppearance()
    ViewCompat.requestApplyInsets(content)
  }

  // uiMode is in the manifest's configChanges, so a theme switch arrives here
  // instead of recreating the activity. Re-apply so the system theme never
  // gives light icons on the light page.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applySystemBarAppearance()
  }

  // The page has a single light theme (public/calm.css: --paper-cream #f7f3ed,
  // no dark variant), so the decor behind the bars is always that colour with
  // dark bar icons, whatever the system theme.
  private fun applySystemBarAppearance() {
    window.decorView.setBackgroundColor(0xFFF7F3ED.toInt())
    // The 3-button navigation scrim is chosen when the activity starts and does
    // not follow a live theme switch; without this the scrim shows through.
    if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    WindowInsetsControllerCompat(window, findViewById(android.R.id.content)).apply {
      isAppearanceLightStatusBars = true
      isAppearanceLightNavigationBars = true
    }
  }
}
