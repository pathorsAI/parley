Android catches up with iOS: start a recording from outside the app, a personal dictionary that steers transcription, and folder management. 1.23 never reached Play (it needed a foreground-service declaration for background playback); 1.24 is 1.23 without background playback (#703 reverted), plus the study-prompt speaker-label fix (#709).

- **Start recording without opening the app** (#701). A launcher shortcut (long-press the icon → Record) and a Quick Settings tile open `parley://record`, which starts a meeting — or brings up the one already running. A request counts once and only within 30 seconds, matching iOS.
- **Personal dictionary** (#704). Names and jargon you add, plus corrections, are stored on the phone, synced with your account (the same dictionary as iOS and desktop), and sent as recognition hints to live meetings, file imports and the post-meeting batch transcription. Opened from the account sheet.
- **Folder management from the folder row** (#702). Long-press a folder to rename or delete it (its recordings move to Unfiled, none are deleted); a + at the end of the row creates one, in personal or organization libraries.
- **The live transcript keeps your place** (#699). Scrolling up during a meeting stops auto-follow; a Latest button appears once something new is said.
- **Sign-in aurora** (#700). The edge glow from iOS breathes on the sign-in screen, quickens while signing in and fades as the app appears.
- **Study prompts name speakers by side** (#709). Analyses read "Me" / "Me 1" / "Remote 1", the same labels the desktop has sent since #689.
