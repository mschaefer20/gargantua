// Main scene shader: ray-traced Schwarzschild black hole.
// Integrates photon geodesics so the starfield AND the accretion disk are
// gravitationally lensed. Includes relativistic Doppler beaming on the disk,
// a blackbody temperature gradient, turbulent spiral structure, and the
// photon ring. Output is linear HDR (consumed by the bloom/tonemap passes).
//
// Units: Schwarzschild radius r_s = 1. Horizon r = 1, photon sphere r = 1.5,
// ISCO r = 3. The disk lives in the y = 0 plane.

export const sceneFrag = /* glsl */ `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_time;
uniform vec3  u_camPos;
uniform mat3  u_camMat;      // camera basis (right, up, forward)
uniform float u_fov;
uniform float u_diskIntensity;
uniform float u_lensing;     // 0 = straight rays, 1 = full GR bending
uniform float u_diskOpacity;
uniform float u_starBrightness;
uniform float u_quality;     // integration steps multiplier

const float PI = 3.14159265359;

// ---------- hashing / noise ----------
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n = mix(
    mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
        mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
        mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  return n;
}
float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise3(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

// ---------- blackbody-ish color from temperature parameter t in [0,1] ----------
// 0 = cool outer disk (deep orange/red), 1 = blistering inner edge (white/blue).
vec3 blackbody(float t) {
  vec3 cool  = vec3(1.0, 0.32, 0.05);   // ~3000K orange
  vec3 mid   = vec3(1.0, 0.72, 0.30);   // ~5000K amber
  vec3 hot   = vec3(1.0, 0.96, 0.85);   // ~7000K white
  vec3 white = vec3(0.78, 0.86, 1.0);   // ~10000K blue-white
  vec3 c;
  if (t < 0.4)      c = mix(cool, mid, t / 0.4);
  else if (t < 0.75) c = mix(mid, hot, (t - 0.4) / 0.35);
  else              c = mix(hot, white, (t - 0.75) / 0.25);
  return c;
}

// ---------- starfield + nebula background, sampled by ray direction ----------
vec3 starfield(vec3 dir) {
  vec3 col = vec3(0.0);

  // Deep-space nebula clouds built from layered fbm.
  vec3 nd = dir * 2.2;
  float neb = fbm(nd + vec3(0.0, 0.0, u_time * 0.005));
  neb = pow(neb, 3.0);
  float neb2 = fbm(nd * 1.7 + 11.3);
  vec3 nebCol = mix(vec3(0.05, 0.10, 0.28), vec3(0.30, 0.08, 0.34), neb2);
  nebCol += vec3(0.10, 0.22, 0.30) * pow(fbm(nd * 0.8 + 5.0), 2.0);
  col += nebCol * neb * 0.55;

  // A soft galactic band.
  float band = exp(-abs(dir.y) * 6.0);
  col += vec3(0.18, 0.16, 0.22) * band * (0.4 + 0.6 * fbm(dir * 6.0));

  // Stars across three density/size layers.
  for (int layer = 0; layer < 3; layer++) {
    float scale = 220.0 + float(layer) * 360.0;
    vec3 p = dir * scale;
    vec3 id = floor(p);
    vec3 rnd = hash33(id + float(layer) * 17.0);
    if (rnd.x > 0.92 - float(layer) * 0.01) {
      vec3 starPos = id + 0.5 + (rnd - 0.5) * 0.7;
      vec3 toStar = normalize(starPos);
      float d = max(0.0, dot(dir, toStar));
      float spark = pow(d, 6000.0 + rnd.y * 9000.0);
      // gentle twinkle
      float tw = 0.7 + 0.3 * sin(u_time * (1.5 + rnd.z * 3.0) + rnd.x * 30.0);
      vec3 starCol = mix(vec3(1.0, 0.85, 0.7), vec3(0.7, 0.82, 1.0), rnd.z);
      col += starCol * spark * tw * (1.4 - float(layer) * 0.3);
    }
  }
  return col * u_starBrightness;
}

// ---------- accretion disk emission at a crossing point ----------
// p: 3D position where the geodesic crosses the disk plane.
// rayDir: photon travel direction (for Doppler beaming toward camera).
vec3 diskEmission(vec3 p, vec3 rayDir) {
  float r = length(p.xz);
  float innerR = 2.6;   // just outside ISCO
  float outerR = 13.0;
  if (r < innerR || r > outerR) return vec3(0.0);

  float tnorm = clamp((r - innerR) / (outerR - innerR), 0.0, 1.0);

  // Keplerian-ish angular velocity (faster inside) drives swirling animation.
  float ang = atan(p.z, p.x);
  float speed = pow(innerR / r, 1.5);
  float swirl = ang + u_time * speed * 2.2;

  // Turbulent density: spiral streaks in (radius, swirl) space.
  vec3 np = vec3(cos(swirl) * r, sin(swirl) * r, log(r) * 4.0);
  float dens = fbm(np * 0.55 + vec3(0.0, 0.0, u_time * 0.1));
  dens = pow(dens, 1.7);
  float streaks = 0.5 + 0.5 * sin(swirl * 3.0 + log(r) * 9.0 - u_time * 1.5);
  dens *= 0.55 + 0.85 * streaks;

  // Temperature: hot inner edge -> cool outer. Plus inner-edge glow.
  float temp = pow(1.0 - tnorm, 1.6);
  vec3 col = blackbody(clamp(temp, 0.0, 1.0));

  // Radial brightness profile: bright inner ring, fading outward.
  float radial = smoothstep(outerR, innerR + 1.0, r);
  radial *= smoothstep(innerR, innerR + 0.5, r); // soft inner cutoff
  float emiss = radial * (0.6 + 1.6 * temp) * dens;

  // ---- relativistic Doppler beaming ----
  // Orbital velocity vector (counter-clockwise in xz-plane).
  vec3 vel = normalize(vec3(-p.z, 0.0, p.x));
  float beta = clamp(speed * 0.52, 0.0, 0.82); // orbital speed as fraction of c
  // Approaching the camera => component of velocity along -rayDir.
  float losv = dot(vel, -normalize(rayDir));
  float gamma = 1.0 / sqrt(1.0 - beta * beta);
  float doppler = 1.0 / (gamma * (1.0 - beta * losv));
  // Beaming brightens the approaching side; ^3 is the relativistic boost.
  float beam = pow(doppler, 3.2);
  // Color shift: blue toward approach, red toward recede.
  col = mix(col * vec3(1.25, 1.05, 0.75), col * vec3(0.7, 0.85, 1.35),
            clamp(doppler - 0.5, 0.0, 1.0));

  vec3 result = col * emiss * beam;

  // Vertical thickness falloff already handled by plane crossing; add a faint
  // bright photon-ring kiss at the inner edge.
  float ring = smoothstep(innerR + 0.6, innerR, r);
  result += vec3(1.0, 0.95, 0.9) * ring * 1.2;

  return result * u_diskIntensity;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;

  // Primary ray.
  vec3 ro = u_camPos;
  vec3 rd = normalize(u_camMat * vec3(uv * u_fov, 1.0));

  vec3 pos = ro;
  vec3 dir = rd;

  // Conserved-ish angular momentum term for the geodesic bending force.
  float h2 = dot(cross(pos, dir), cross(pos, dir));

  vec3 accum = vec3(0.0);     // accumulated emissive (disk)
  float transmit = 1.0;       // remaining transparency through disk
  bool captured = false;

  int steps = int(240.0 * u_quality);
  float prevY = pos.y;

  for (int i = 0; i < 512; i++) {
    if (i >= steps) break;

    float r = length(pos);

    // Adaptive step: small near the hole, larger far away.
    float dt = clamp(r * 0.12, 0.012, 0.55);

    vec3 prevPos = pos;

    // Gravitational acceleration (Schwarzschild light bending), scaled by lensing.
    vec3 accel = -1.5 * h2 * pos / pow(dot(pos, pos), 2.5);
    dir += accel * dt * u_lensing;
    dir = normalize(dir);
    pos += dir * dt;

    // Event horizon capture.
    if (r < 1.0) { captured = true; break; }

    // Disk-plane crossing test (sign change in y).
    if (prevPos.y * pos.y < 0.0) {
      float tcross = prevPos.y / (prevPos.y - pos.y);
      vec3 cp = mix(prevPos, pos, tcross);
      float cr = length(cp.xz);
      if (cr > 2.0 && cr < 14.0) {
        vec3 e = diskEmission(cp, dir);
        // Front-to-back compositing with mild self-occlusion.
        float a = clamp(length(e) * 0.5 * u_diskOpacity, 0.0, 1.0);
        accum += e * transmit;
        transmit *= (1.0 - a * 0.55);
      }
    }

    // Escaped to infinity.
    if (r > 40.0 && dot(pos, dir) > 0.0) break;
  }

  vec3 color = accum;

  if (!captured) {
    vec3 bg = starfield(normalize(dir));
    color += bg * transmit;
  }

  // Subtle gravitational glow halo around the shadow (lensed light pile-up).
  float impact = length(cross(normalize(rd), normalize(ro))) * length(ro);
  float halo = exp(-pow(abs(impact - 2.6), 2.0) * 0.35) * 0.06;
  color += vec3(0.9, 0.6, 0.4) * halo * u_diskIntensity;

  fragColor = vec4(color, 1.0);
}
`;
