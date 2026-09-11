# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class com.pathors.parley.** {
    *** Companion;
}
-keepclasseswithmembers class com.pathors.parley.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# DataStore (Preferences) bundles a shaded protobuf-lite that resolves message
# fields by *name* through reflection (MessageSchema: "Field value_ for … not
# found"). R8's full mode renames those fields, so the first DataStore write —
# persisting the session token after sign-in — crashed every release build,
# which is what Google Play's reviewer saw ("Parley keeps stopping"). The
# library ships no consumer rule for this. Only the field names need to survive.
-keepclassmembers class * extends androidx.datastore.preferences.protobuf.GeneratedMessageLite {
    <fields>;
}
