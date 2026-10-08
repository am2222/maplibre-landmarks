import { DirectionalLight, Group, HemisphereLight } from 'three';

export type Theme = 'day' | 'dawn' | 'dusk' | 'night';
export const THEME_NAMES: Theme[] = ['day', 'dawn', 'dusk', 'night'];

/** Module colours for a theme (sRGB hex; three converts to linear). */
export interface ThemePalette {
  foliage: number;
  /** 0..1 amount of per-tree lightness/hue variation. */
  foliageJitter: number;
  trunk: number;
}

export interface ThemeValues {
  sky: number;
  ground: number;
  hemi: number;
  sun: number;
  sunColor: number;
  /** Direction towards the sun in local glTF axes (X east, Y up, Z south). */
  sunDir: [number, number, number];
  palette: ThemePalette;
}

export const THEMES: Record<Theme, ThemeValues> = {
  day: {
    sky: 0xdfeaf5,
    ground: 0x8a8070,
    hemi: 1.6,
    sun: 2.2,
    sunColor: 0xfff4e0,
    sunDir: [-0.5, 1, 0.35],
    palette: { foliage: 0x4f7a3a, foliageJitter: 0.35, trunk: 0x5a4532 },
  },
  dawn: {
    sky: 0xf2c9a8,
    ground: 0x5a4a40,
    hemi: 1.1,
    sun: 1.8,
    sunColor: 0xffb47a,
    sunDir: [-1, 0.35, 0.2],
    palette: { foliage: 0x6f7d3c, foliageJitter: 0.3, trunk: 0x6a4a35 },
  },
  dusk: {
    sky: 0x9a8aba,
    ground: 0x4a4048,
    hemi: 2.0,
    sun: 1.5,
    sunColor: 0xff9a6a,
    sunDir: [1, 0.25, -0.1],
    palette: { foliage: 0x55704a, foliageJitter: 0.25, trunk: 0x5a4838 },
  },
  night: {
    sky: 0x6a7aa8,
    ground: 0x202430,
    hemi: 1.9,
    sun: 1.0,
    sunColor: 0x9fb4ff,
    sunDir: [0.3, 1, -0.4],
    palette: { foliage: 0x4a7a5a, foliageJitter: 0.2, trunk: 0x4a4038 },
  },
};

export interface LightRig {
  group: Group;
  setTheme(theme: Theme): void;
}

export function createLightRig(theme: Theme): LightRig {
  const group = new Group();
  const hemi = new HemisphereLight();
  const sun = new DirectionalLight();
  group.add(hemi, sun);
  const setTheme = (t: Theme) => {
    const v = THEMES[t];
    hemi.color.setHex(v.sky);
    hemi.groundColor.setHex(v.ground);
    hemi.intensity = v.hemi;
    sun.color.setHex(v.sunColor);
    sun.intensity = v.sun;
    sun.position
      .set(...v.sunDir)
      .normalize()
      .multiplyScalar(1000);
  };
  setTheme(theme);
  return { group, setTheme };
}
