# Mobile sample player (T18, work in progress)

The bundled sample is the LibriVox recording of “The Mouth,” chapter 3 of *The Voice and Public Speaking* by John Poole Sandlands, read by Meliora Dockery. [Catalog and recording](https://librivox.org/the-voice-and-public-speaking-by-john-poole-sandlands/). LibriVox identifies its recordings as public domain in the United States; check local law where applicable. The original MP3 was converted to AAC for the bundled episode package. The metadata contains no transcript segments; its creation date is a fixture placeholder.

The library displays the bundled sample's locally saved position. Playback checkpoints use the existing Expo SQLite key-value store; the sample's local playback queue is deliberately separate from the future server sync queue because the fixture is not a server episode. Pairing, remote downloads and remote sync are not implemented. Storage or restore errors are shown without preventing sample playback, and a failed restore does not overwrite the saved checkpoint.

USB import is available in Library: copy an existing package to the phone, then select its `episode.json` and `audio.m4a` in the system picker. Select packages from a trusted source: the SHA-256 check detects corruption, not malicious replacement. The app validates the shared schema, stages the audio, checks its byte count and digest, and publishes only the verified package. Existing episode IDs are rejected, not replaced, to preserve local data; remove or replacement behavior is not implemented. The picker and offline playback still need physical-device verification.

The offline player saves imported episode playback position locally. Secure Wi-Fi download and the complete SQLite episode index remain unfinished; no progress upload is connected to USB import. The filesystem adapter tests use isolated local fixtures, not a server.

Imported episodes with timed transcript segments offer sentence drill (one, two or three plays before pausing), previous/repeat/next and sentence looping by long press or the labelled loop button. Dismiss the loop to return to normal playback. Speed is pitch-corrected, adjustable from 0.50× to 1.50× in 0.05 steps and saved locally per episode mode. The bundled sample has no transcript, so only speed applies there.

Drill and looping react to player status updates requested every 100 ms; they are not sample-accurate, and pauses can overshoot when updates or JavaScript execution are delayed, especially in the background. Accurate timing and operation with screen off require physical-device checks with a timed episode and actual inter-sentence silence; the bundled sample cannot verify these features. T23 remains open until that check.

## Android development build

On Windows, native CMake/Ninja builds can exceed path limits. The successful workaround used a **fresh, short-path checkout**, a hoisted pnpm install, and a short Gradle user home. Use a separate checkout rather than switching the linker in an existing install. Set `PNPM_CONFIG_NODE_LINKER=hoisted` in the build shell for every pnpm command (including later runs, to prevent an automatic reinstall with the default linker). From that checkout's root:

```sh
pnpm install --frozen-lockfile
pnpm --filter mobile exec expo prebuild --platform android --no-install
```

Set `JAVA_HOME` and `ANDROID_HOME` to your local JDK and SDK. If needed, set `GRADLE_USER_HOME` to a short writable directory for this build process only. From `apps/mobile/android`, run `gradlew.bat assembleDebug` on Windows or `./gradlew assembleDebug` on macOS/Linux. The debug APK is in `app/build/outputs/apk/debug/`. The Expo SDK 58 config plugin adds `CMAKE_OBJECT_PATH_MAX=240` to the generated app Gradle configuration, so it survives prebuild regeneration; it is not a general fix for arbitrarily long paths. Recheck the plugin when upgrading Expo: it intentionally fails if the Gradle template changes. See [Expo mods](https://docs.expo.dev/config-plugins/mods/#available-mod-plugins) and [CMake object path limits](https://cmake.org/cmake/help/latest/variable/CMAKE_OBJECT_PATH_MAX.html).

Expo's `prebuild --clean` deletes and recreates native directories: back up local native changes before using it. Normal prebuild layers changes onto existing files; this plugin is idempotent. See [Expo CNG](https://docs.expo.dev/workflow/continuous-native-generation/#clean).

The debug build is not a standalone offline release: it needs the development server. A production release signing workflow is not supplied or verified; do not treat an `assembleRelease` command as evidence of a production-signed, distributable or device-verified APK. If Android refuses an update because the signing key differs, do not uninstall the existing app without first considering the loss of its local data.

Install the Android SDK and JDK as described in `docs/SETUP.md`; [Expo SDK 58](https://docs.expo.dev/versions/latest/) also specifies compile SDK 37. Connect and authorize the phone, then run `pnpm --filter mobile android`. The development build requires its development server; for a fully offline test use a build with the JavaScript bundle and assets embedded. Before T18 is complete, verify on a physical device: 10 minutes playing with the screen off, lock-screen pause/resume, playback while switching apps, and position restoration after force-stop. Position checkpoints are attempted every five seconds during playback, subject to Android's background execution behavior.

Expo references: [audio background playback](https://docs.expo.dev/versions/latest/sdk/audio/#playing-audio-in-the-background), [Router installation](https://docs.expo.dev/router/installation/), [development builds](https://docs.expo.dev/develop/development-builds/introduction/), [SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/).
