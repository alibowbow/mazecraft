/** Shared with GPU regression tests; orientations are clockwise quarter turns. */
export const WATER_ATLAS_COORDINATES = /* glsl */ `
  vec2 blenderRotateToCanonical(vec2 localUv, float orientation) {
    vec2 point = localUv - 0.5;
    if (orientation < 0.5) return localUv;
    if (orientation < 1.5) return vec2(-point.y, point.x) + 0.5;
    if (orientation < 2.5) return -point + 0.5;
    return vec2(point.y, -point.x) + 0.5;
  }

  vec2 blenderNormalToWorld(vec2 normal, float orientation) {
    if (orientation < 0.5) return normal;
    if (orientation < 1.5) return vec2(normal.y, -normal.x);
    if (orientation < 2.5) return -normal;
    return vec2(-normal.y, normal.x);
  }

  float blenderTravelCycles(vec3 travel, vec2 tile) {
    vec2 canonical = blenderRotateToCanonical(travel.xy + 0.5, tile.y) - 0.5;
    if (tile.x > 0.5 && tile.x < 3.5) {
      return 0.5 * (canonical.x - canonical.y);
    }
    // Only source impact is radial. Outlet detail must retrace on backflow.
    if (tile.x > 4.5 && tile.x < 5.5) return travel.z;
    return -canonical.y;
  }
`

/** Invert the screen-to-world XY Jacobian before adding a height gradient. */
export const WATER_WORLD_SLOPE = /* glsl */ `
  vec2 waterWorldSlope(vec2 positionDx, vec2 positionDy, float heightDx, float heightDy) {
    float determinant = positionDx.x * positionDy.y - positionDx.y * positionDy.x;
    float scale = max(length(positionDx) * length(positionDy), 1e-20);
    if (abs(determinant) <= scale * 0.00001) return vec2(0.0);
    return vec2(
      heightDx * positionDy.y - positionDx.y * heightDy,
      positionDx.x * heightDy - heightDx * positionDy.x
    ) / determinant;
  }
`
