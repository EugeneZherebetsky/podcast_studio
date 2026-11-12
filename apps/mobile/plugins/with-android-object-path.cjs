// Expo loads local config plugins as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withAppBuildGradle } = require('expo/config-plugins');

const argument = "externalNativeBuild { cmake { arguments '-DCMAKE_OBJECT_PATH_MAX=240' } }";

function applyObjectPathLimit(contents) {
  if (contents.includes(argument)) return contents;
  if (contents.includes('CMAKE_OBJECT_PATH_MAX')) {
    throw new Error('Conflicting CMAKE_OBJECT_PATH_MAX in app build.gradle');
  }
  const anchor = '    defaultConfig {\n';
  if (contents.split(anchor).length !== 2) {
    throw new Error('Could not find the Expo SDK 58 defaultConfig in app build.gradle');
  }
  return contents.replace(anchor, `${anchor}        ${argument}\n`);
}

// https://docs.expo.dev/config-plugins/mods/#available-mod-plugins
module.exports = function withAndroidObjectPath(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') throw new Error('Expected Groovy app build.gradle');
    mod.modResults.contents = applyObjectPathLimit(mod.modResults.contents);
    return mod;
  });
};
module.exports.applyObjectPathLimit = applyObjectPathLimit;
