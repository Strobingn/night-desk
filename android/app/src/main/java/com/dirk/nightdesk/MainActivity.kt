package com.dirk.nightdesk

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.dirk.nightdesk.ui.NightDeskApp
import com.dirk.nightdesk.ui.NightTheme
import com.dirk.nightdesk.wallet.MwaHost

class MainActivity : ComponentActivity() {
    private val desk by lazy { DeskRepository.get(applicationContext) }
    private val notifyPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        MwaHost.attach(this)
        com.dirk.nightdesk.ui.ThemeState.load(this)
        enableEdgeToEdge()
        DeskConnectionService.start(this)
        askForNotifications()
        askToIgnoreBatteryOptimizations()
        takeShare(intent)
        com.dirk.nightdesk.pump.alerts.NightMode.apply(this)
        setContent {
            NightTheme {
                NightDeskApp(desk)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        com.dirk.nightdesk.pump.alerts.NightMode.apply(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeShare(intent)
    }

    /** v12 share target. A link or mint shared into the app opens Add coin prefilled. Nothing is bought. */
    private fun takeShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        if (intent.type?.startsWith("text/") != true) return
        desk.offerSharedText(intent.getStringExtra(Intent.EXTRA_TEXT) ?: intent.getStringExtra(Intent.EXTRA_SUBJECT))
    }

    override fun onStart() {
        super.onStart()
        desk.onResume()
    }

    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return
        }
        notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun askToIgnoreBatteryOptimizations() {
        val prefs = getSharedPreferences("night_desk_local", MODE_PRIVATE)
        if (prefs.getBoolean("asked_battery", false)) return
        prefs.edit().putBoolean("asked_battery", true).apply()
        val power = getSystemService(PowerManager::class.java) ?: return
        if (power.isIgnoringBatteryOptimizations(packageName)) return
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        }
        runCatching { startActivity(intent) }
    }
}
