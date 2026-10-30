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

class MainActivity : ComponentActivity() {
    private val desk by lazy { DeskRepository.get(applicationContext) }
    private val notifyPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        DeskConnectionService.start(this)
        askForNotifications()
        askToIgnoreBatteryOptimizations()
        setContent {
            NightTheme {
                NightDeskApp(desk)
            }
        }
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
