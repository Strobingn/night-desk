package com.dirk.nightdesk.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val Ink = Color(0xFFE7F0D8)
val Dim = Color(0xFF8B957C)
val Lime = Color(0xFFDFF25A)
val Mint = Color(0xFF8DFACE)
val Coral = Color(0xFFFF6A45)
val Amber = Color(0xFFFFC857)
val Sky = Color(0xFF9FD4FF)
val Night = Color(0xFF090B08)
val Panel = Color(0xFF141910)

private val scheme = darkColorScheme(
    primary = Lime,
    onPrimary = Night,
    secondary = Mint,
    background = Night,
    surface = Panel,
    onBackground = Ink,
    onSurface = Ink,
    error = Coral
)

private val type = Typography(
    headlineLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.ExtraBold, fontSize = 32.sp, letterSpacing = (-0.8).sp, color = Ink),
    headlineSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 20.sp, letterSpacing = (-0.4).sp, color = Ink),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, color = Ink),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 20.sp, color = Ink),
    labelSmall = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.2.sp, color = Dim)
)

@Composable
fun NightTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = type, content = content)
}
