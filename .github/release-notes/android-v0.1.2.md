The release build no longer crashes as soon as you sign in.

- **Fixed the crash Play rejected 0.1.1 for.** R8 renamed the field names DataStore looks up by reflection, so the first read or write after sign-in killed the app. They are now kept.
- Code-quality cleanup from the SonarQube sweep, with no behaviour change.
