package com.dirk.nightdesk

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.dirk.nightdesk.ui.NightDeskApp
import com.dirk.nightdesk.ui.NightTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val desk = DeskRepository(applicationContext)
        setContent {
            NightTheme {
                NightDeskApp(desk)
            }
        }
    }
}
