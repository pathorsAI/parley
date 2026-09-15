package com.pathors.parley.ui

/**
 * The product's public URLs, in one place.
 *
 * They are here rather than inline at each call site because two of them are
 * compliance surfaces, not decoration: Play rejects an app whose privacy policy
 * cannot be reached from inside it, and the address it checks has to be the same
 * one the store listing declares (`android/AppStore/listing-*.md`). A second copy
 * that drifts by a trailing slash is a rejection nobody would think to look for.
 *
 * Same addresses as iOS `SettingsView`/`OnboardingView` and the website's own
 * footer — one product, one privacy policy.
 */
object ParleyLinks {
    /** The landing site, which is also where the desktop app is downloaded. */
    const val WEBSITE = "https://parley.tw"

    /** Declared to Play as the app's privacy policy. */
    const val PRIVACY = "https://parley.tw/privacy/"

    /** Where a bug report or a question goes. */
    const val SUPPORT = "https://parley.tw/support/"
}
