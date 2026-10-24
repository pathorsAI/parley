The Parley keyboard and the recording report arrive on Android, and long meetings finish filling in their transcripts even after you leave the app.

- **Parley keyboard** (#589). A voice keyboard with one microphone key: tap it, speak, and the tidied words land in whatever app you are typing in. A second key switches back to your regular keyboard. It never dictates into password fields and stops at ten minutes, the same limit as iOS and desktop.
- **Report on the phone** (#591). The recording page has a Report view with timeline analysis, action items, highlights and a scorecard, made by the same pipeline and prompts as the desktop.
- **Backfill survives leaving the app** (#623). Re-transcribing the gaps of a long meeting used to stop when you left the screen or the app was backgrounded, and every retry uploaded the whole recording again. It now runs as a system job and resumes the same transcription job instead of re-uploading.
- **Hosted AI calls back off** (#623). At most two at a time, and they wait when Parley AI says it is busy instead of failing in a burst.
- **One title for phone and computer** (#585). The AI title and filing suggestion are generated once per recording with the same prompt on every client.
- Underneath: hosted transcription uses Parley's own stream protocol (#592), and AI calls say which feature made them (#598).
