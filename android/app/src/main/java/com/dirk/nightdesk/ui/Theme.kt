package com.dirk.nightdesk.ui

import android.content.Context
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * v13 palette — the one place both themes are defined. Same tokens as web/src/styles.css.
 * Near-black charcoal dark theme, a clean light theme, vivid status colours, one cyan accent.
 */
data class DeskPalette(
    val isDark: Boolean,
    val bg: Color,
    val surface: Color,
    val card: Color,
    val card2: Color,
    val card3: Color,
    val nav: Color,
    val line: Color,
    val lineStrong: Color,
    val ink: Color,
    val dim: Color,
    val muted: Color,
    val faint: Color,
    val accent: Color,
    val onAccent: Color,
    val up: Color,
    val onUp: Color,
    val down: Color,
    val onDown: Color,
    val amber: Color,
    val blue: Color,
    val heroFrom: Color,
    val heroTo: Color,
    val avatars: List<Color>
)

object Palettes {
    val Dark = DeskPalette(
        isDark = true,
        bg = Color(0xFF050505),
        surface = Color(0xFF0D0D0D),
        card = Color(0xFF161616),
        card2 = Color(0xFF1C1C1C),
        card3 = Color(0xFF262626),
        nav = Color(0xFF0B0B0B),
        line = Color(0xFF242424),
        lineStrong = Color(0xFF333333),
        ink = Color(0xFFF7F7F7),
        dim = Color(0xFFC2C2C2),
        muted = Color(0xFFA0A0A0),
        faint = Color(0xFF727272),
        accent = Color(0xFF22D3EE),
        onAccent = Color(0xFF00161B),
        up = Color(0xFF22E07A),
        onUp = Color(0xFF00210F),
        down = Color(0xFFFF4D5E),
        onDown = Color(0xFF1F0005),
        amber = Color(0xFFFFC531),
        blue = Color(0xFF3FA9FF),
        heroFrom = Color(0xFF0B2A30),
        heroTo = Color(0xFF101010),
        avatars = listOf(Color(0xFF1F2A2E), Color(0xFF2A2433), Color(0xFF2E2A1F), Color(0xFF1F2E25), Color(0xFF2E1F24), Color(0xFF24262E))
    )

    val Light = DeskPalette(
        isDark = false,
        bg = Color(0xFFF4F5F7),
        surface = Color(0xFFF7F8FA),
        card = Color(0xFFFFFFFF),
        card2 = Color(0xFFFFFFFF),
        card3 = Color(0xFFECEEF1),
        nav = Color(0xFFFFFFFF),
        line = Color(0xFFE2E5E9),
        lineStrong = Color(0xFFC9CED5),
        ink = Color(0xFF0C0E11),
        dim = Color(0xFF3B4048),
        muted = Color(0xFF565C65),
        faint = Color(0xFF7F858E),
        accent = Color(0xFF0284A8),
        onAccent = Color(0xFFFFFFFF),
        up = Color(0xFF08944A),
        onUp = Color(0xFFFFFFFF),
        down = Color(0xFFDF1F37),
        onDown = Color(0xFFFFFFFF),
        amber = Color(0xFFA86A00),
        blue = Color(0xFF1565D8),
        heroFrom = Color(0xFFD8F3F9),
        heroTo = Color(0xFFFFFFFF),
        avatars = listOf(Color(0xFFD9EEF3), Color(0xFFE7E1F1), Color(0xFFF2EAD7), Color(0xFFDCEFE3), Color(0xFFF2DDE2), Color(0xFFE1E4EE))
    )
}

/** Client-only theme preference. Never sent to the desk. */
enum class ThemePref(val label: String) { DARK("Dark"), LIGHT("Light"), SYSTEM("System") }

object ThemeState {
    private const val FILE = "night_desk_local"
    private const val KEY = "ui_theme"
    var pref by mutableStateOf(ThemePref.DARK)
    /** Last value the UI saw from the OS dark-mode setting (used by System). */
    var systemDark by mutableStateOf(true)
    /** Night schedule forces the dark palette without writing the saved preference. */
    var nightForced by mutableStateOf(false)
    val palette: DeskPalette get() = if (nightForced) Palettes.Dark else resolve(pref, systemDark)

    fun load(context: Context) {
        pref = parse(context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null))
    }

    fun set(context: Context?, next: ThemePref) {
        pref = next
        context?.getSharedPreferences(FILE, Context.MODE_PRIVATE)?.edit()?.putString(KEY, next.name)?.apply()
    }

    fun parse(raw: String?): ThemePref = ThemePref.entries.firstOrNull { it.name == raw } ?: ThemePref.DARK

    /** Header quick toggle: Dark → Light → System → Dark (same as web). */
    fun next(p: ThemePref): ThemePref = when (p) {
        ThemePref.DARK -> ThemePref.LIGHT
        ThemePref.LIGHT -> ThemePref.SYSTEM
        ThemePref.SYSTEM -> ThemePref.DARK
    }

    fun resolve(p: ThemePref, systemDark: Boolean): DeskPalette = if (nightForced) Palettes.Dark else when (p) {
        ThemePref.DARK -> Palettes.Dark
        ThemePref.LIGHT -> Palettes.Light
        ThemePref.SYSTEM -> if (systemDark) Palettes.Dark else Palettes.Light
    }
}

/** Current palette. Reading it in composition recomposes on a theme change. */
val P: DeskPalette get() = ThemeState.palette

// Legacy names kept so every screen follows the palette. Each maps to one token.
val Ink: Color get() = P.ink
val Dim: Color get() = P.muted
val Lime: Color get() = P.accent
val Mint: Color get() = P.up
val Coral: Color get() = P.down
val Amber: Color get() = P.amber
val Sky: Color get() = P.blue
val Night: Color get() = P.bg
val Panel: Color get() = P.card
val OnAccent: Color get() = P.onAccent

private fun type(p: DeskPalette) = Typography(
    headlineLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.ExtraBold, fontSize = 32.sp, letterSpacing = (-0.8).sp, color = p.ink),
    headlineSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 20.sp, letterSpacing = (-0.4).sp, color = p.ink),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, color = p.ink),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 20.sp, color = p.ink),
    labelSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 11.sp, letterSpacing = 0.4.sp, color = p.muted)
)

@Composable
fun NightTheme(content: @Composable () -> Unit) {
    val systemDark = isSystemInDarkTheme()
    SideEffect { if (ThemeState.systemDark != systemDark) ThemeState.systemDark = systemDark }
    val p = ThemeState.palette
    val scheme = if (p.isDark) {
        darkColorScheme(
            primary = p.accent, onPrimary = p.onAccent, secondary = p.up, background = p.bg, surface = p.card,
            surfaceVariant = p.card3, onBackground = p.ink, onSurface = p.ink, onSurfaceVariant = p.muted,
            outline = p.lineStrong, outlineVariant = p.line, error = p.down, secondaryContainer = p.card3, onSecondaryContainer = p.ink,
            surfaceContainer = p.card, surfaceContainerHigh = p.card2, surfaceContainerHighest = p.card3, surfaceContainerLow = p.card
        )
    } else {
        lightColorScheme(
            primary = p.accent, onPrimary = p.onAccent, secondary = p.up, background = p.bg, surface = p.card,
            surfaceVariant = p.card3, onBackground = p.ink, onSurface = p.ink, onSurfaceVariant = p.muted,
            outline = p.lineStrong, outlineVariant = p.line, error = p.down, secondaryContainer = p.card3, onSecondaryContainer = p.ink,
            surfaceContainer = p.card, surfaceContainerHigh = p.card2, surfaceContainerHighest = p.card3, surfaceContainerLow = p.card
        )
    }
    MaterialTheme(colorScheme = scheme, typography = type(p), content = content)
}
