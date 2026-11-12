# Mobile sample player (T18, work in progress)

The bundled sample is the LibriVox recording of “The Mouth,” chapter 3 of *The Voice and Public Speaking* by John Poole Sandlands, read by Meliora Dockery. [Catalog and recording](https://librivox.org/the-voice-and-public-speaking-by-john-poole-sandlands/). LibriVox identifies its recordings as public domain in the United States; check local law where applicable. The original MP3 was converted to AAC for the bundled episode package. The metadata contains no transcript segments; its creation date is a fixture placeholder.

## Android development build

On Windows, native CMake/Ninja builds can exceed path limits. The successful workaround used a **fresh, short-path checkout**, a hoisted pnpm install, and a short Gradle user home. Use a separate checkout rather than switching the linker in an existing install. Set `PNPM_CONFIG_NODE_LINKER=hoisted` in the build shell for every pnpm command (including later runs, to prevent an automatic reinstall with the default linker). From that checkout's root:

```sh
pnpm install --frozen-lockfile
pnpm --filter mobile exec expo prebuild --platform android --no-install
```

Set `JAVA_HOME` and `ANDROID_HOME` to your local JDK and SDK. If needed, set `GRADLE_USER_HOME` to a short writable directory for this build process only. From `apps/mobile/android`, run `gradlew.bat assembleDebug` on Windows or `./gradlew assembleDebug` on macOS/Linux. The debug APK is in `app/build/outputs/apk/debug/`. The Expo SDK 58 config plugin adds `CMAKE_OBJECT_PATH_MAX=240` to the generated app Gradle configuration, so it survives prebuild regeneration; it is not a general fix for arbitrarily long paths. Recheck the plugin when upgrading Expo: it intentionally fails if the Gradle template changes. See [Expo mods](https://docs.expo.dev/config-plugins/mods/#available-mod-plugins) and [CMake object path limits](https://cmake.org/cmake/help/latest/variable/CMAKE_OBJECT_PATH_MAX.html).

Expo's `prebuild --clean` deletes and recreates native directories: back up local native changes before using it. Normal prebuild layers changes onto existing files; this plugin is idempotent. See [Expo CNG](https://docs.expo.dev/workflow/continuous-native-generation/#clean).

Install the Android SDK and JDK as described in `docs/SETUP.md`; [Expo SDK 58](https://docs.expo.dev/versions/latest/) also specifies compile SDK 37. Connect and authorize the phone, then run `pnpm --filter mobile android`. The development build requires its development server; for a fully offline test use a build with the JavaScript bundle and assets embedded. Before T18 is complete, verify on a physical device: 10 minutes playing with the screen off, lock-screen pause/resume, playback while switching apps, and position restoration after force-stop. Position checkpoints are attempted every five seconds during playback, subject to Android's background execution behavior.

Expo references: [audio background playback](https://docs.expo.dev/versions/latest/sdk/audio/#playing-audio-in-the-background), [Router installation](https://docs.expo.dev/router/installation/), [development builds](https://docs.expo.dev/develop/development-builds/introduction/), [SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/).
