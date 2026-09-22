/** GitHub runners render WebGL on the CPU, including every drag/readback frame. */
export const e2eTimeout = (milliseconds: number): number =>
  process.env.CI ? milliseconds * 3 : milliseconds

/** Measured cold transmission-shader startup is about 43 seconds on CI. */
export const waterStartupTimeout = process.env.CI ? 60_000 : 30_000
