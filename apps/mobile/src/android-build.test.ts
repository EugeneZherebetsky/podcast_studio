import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyObjectPathLimit } = require('../plugins/with-android-object-path.cjs');

const template = "android {\n    defaultConfig {\n        applicationId 'example'\n    }\n}\n";

describe('Android object path config', () => {
  it('adds the CMake argument once, including on repeated prebuilds', () => {
    const result = applyObjectPathLimit(template);
    expect(result).toContain("defaultConfig {\n        externalNativeBuild { cmake { arguments '-DCMAKE_OBJECT_PATH_MAX=240' } }");
    expect(applyObjectPathLimit(result)).toBe(result);
  });

  it('fails on unknown templates and conflicting settings', () => {
    expect(() => applyObjectPathLimit('android {}')).toThrow();
    expect(() => applyObjectPathLimit(template.replace('applicationId', "externalNativeBuild { cmake { arguments '-DCMAKE_OBJECT_PATH_MAX=128' } }\n        applicationId"))).toThrow();
  });
});
