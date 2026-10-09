import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('package.json (npm release)', () => {
  it('links the repository, site and issues', () => {
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/am2222/maplibre-landmarks.git',
    });
    expect(pkg.homepage).toBe('https://am2222.github.io/maplibre-landmarks/');
    expect(pkg.bugs).toEqual({ url: 'https://github.com/am2222/maplibre-landmarks/issues' });
    expect(pkg.keywords).toEqual(expect.arrayContaining(['maplibre', 'threejs', 'roofs']));
  });

  it('publishes the build publicly, built before publishing', () => {
    // No provenance flag: trusted publishing adds provenance on CI, and the one manual first
    // publish (from a laptop) cannot generate it.
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.files).toEqual(['dist', 'LICENSE']);
    expect(pkg.scripts.prepublishOnly).toBe('npm run build');
  });

  it('requires the MapLibre and three versions it is tested with', () => {
    expect(pkg.peerDependencies).toEqual({ 'maplibre-gl': '>=6.13.0', three: '>=0.186.0' });
  });
});
describe('release-please', () => {
  const config = JSON.parse(readFileSync('release-please-config.json', 'utf8'));
  const manifest = JSON.parse(readFileSync('.release-please-manifest.json', 'utf8'));

  it('releases the root package as a node package, minor bumps before 1.0', () => {
    expect(config.packages['.']).toMatchObject({
      'release-type': 'node',
      'package-name': 'maplibre-landmarks',
      'bump-minor-pre-major': true,
    });
  });

  it('keeps release-please in step with the package version', () => {
    // Before the first release the manifest says 0.0.0 ("never released") and release-please
    // proposes `initial-version` (else 1.0.0): it must be the package's version. After a
    // release the manifest records the released version, which package.json carries.
    if (manifest['.'] === '0.0.0')
      expect(config.packages['.']['initial-version']).toBe(pkg.version);
    else expect(manifest['.']).toBe(pkg.version);
  });
});
