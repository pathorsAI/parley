# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class com.pathors.parley.** {
    *** Companion;
}
-keepclasseswithmembers class com.pathors.parley.** {
    kotlinx.serialization.KSerializer serializer(...);
}
