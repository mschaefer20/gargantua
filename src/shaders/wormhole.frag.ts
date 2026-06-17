// Wormhole traversal shader: a perspective "tunnel" flight through a swirling
// spacetime throat. Energy veins flow inward along the walls, warp-star streaks
// rush past, the throat glows with concentric lensing rings, and the colour
// palette shifts as you cross into successive "universes". Chromatic aberration
// scales with speed for a sense of relativistic strain.
//
// Output is linear HDR (consumed by the shared bloom + ACES post passes).

export const wormholeFrag = /* glsl */ `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_time;
uniform vec2  u_mouse;       // -1..1 steering offset
uniform float u_speed;       // travel speed
uniform float u_warp;        // streak / aberration intensity
uniform float u_throat;      // throat-glow intensity

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
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
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise3(p); p *= 2.03; a *= 0.5; }
  return v;
}

// A restrained, cool deep-space gradient: indigo -> steel-blue -> faint violet.
// Deliberately dark and low-saturation so the tunnel reads as space, not neon.
vec3 coolPalette(float t) {
  vec3 indigo = vec3(0.04, 0.06, 0.13);
  vec3 steel  = vec3(0.10, 0.16, 0.26);
  vec3 violet = vec3(0.14, 0.10, 0.20);
  vec3 c = mix(indigo, steel, smoothstep(0.0, 0.5, t));
  c = mix(c, violet, smoothstep(0.5, 1.0, t));
  return c;
}

// The tunnel walls + throat, evaluated for one (possibly aberrated) uv.
vec3 renderTunnel(vec2 uv, float t) {
  float r = length(uv);
  float a = atan(uv.y, uv.x);

  // Perspective tunnel: as r -> 0 the wall recedes to infinity.
  float depth = t * u_speed + 0.30 / (r + 0.06);

  // Vortex swirl, stronger toward the centre.
  float swirl = a + 0.45 / (r + 0.08) - t * 0.30;

  // Very slow, gentle hue drift kept entirely within the cool range.
  float sec = depth * 0.04;
  float hueT = 0.5 + 0.5 * sin(sec * 0.6);

  // Faint drifting gas along the walls.
  vec3 p = vec3(swirl * 2.0, depth * 1.3, t * 0.12);
  float e = fbm(p);
  float fine = fbm(p * 3.1 + 7.0);
  float veins = pow(e, 2.4) * 0.7 + fine * 0.3;
  float energy = veins * veins;

  vec3 col = coolPalette(hueT) * energy * 1.3;

  // Walls fade out toward the centre (which holds the faint distant light).
  float wall = smoothstep(0.04, 0.62, r);
  col *= 0.10 + 0.9 * wall;

  // The throat: a faraway, subdued glow — like a distant galaxy, not a sun.
  float throat = pow(clamp(1.0 - r * 1.8, 0.0, 1.0), 4.0);
  vec3 throatCol = vec3(0.45, 0.58, 0.85);
  col += throatCol * throat * 0.55 * u_throat;

  // Barely-there lensing rings.
  float rings = 0.5 + 0.5 * sin(depth * 4.5 - t * 1.6);
  col += throatCol * rings * throat * 0.18 * u_throat;

  // Deepen the tunnel between walls and throat for a sense of distance.
  col *= 1.0 - 0.55 * smoothstep(0.16, 0.42, r) * (1.0 - smoothstep(0.55, 0.80, r));

  return col;
}

// Passing stars: point-like at cruise, lightly trailing only at high speed.
float stars(vec2 uv, float t) {
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  const float N = 150.0;
  float sa = (a / TAU + 0.5) * N;
  float cell = floor(sa);
  float f = fract(sa) - 0.5;

  float s = 0.0;
  // Mostly round (high values); only stretch a little when really fast.
  float elong = mix(320.0, 90.0, clamp((u_speed - 8.0) * 0.06, 0.0, 1.0));
  for (int k = 0; k < 2; k++) {
    vec2 rnd = hash22(vec2(cell, float(k) * 9.0));
    if (rnd.y < 0.45) continue;                  // sparser starfield
    float prog = fract(rnd.x + t * u_speed * 0.09 + float(k) * 0.37);
    float starR = (1.0 - prog) * 1.5;
    float dR = r - starR;
    float life = sin(prog * PI);
    float ang = exp(-f * f * 55.0);              // thin, crisp points
    float rad = exp(-dR * dR * elong);
    float twinkle = 0.75 + 0.25 * sin(t * 6.0 + rnd.x * 30.0);
    s += ang * rad * life * (0.35 + 0.45 * rnd.x) * twinkle;
  }
  return s * u_warp;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
  uv += u_mouse * 0.12;                          // gentle steering

  float r = length(uv);
  // Subtle chromatic aberration, only really visible at warp.
  float ca = (0.0008 + u_speed * 0.00035) * (0.3 + r);

  vec3 col;
  col.r = renderTunnel(uv * (1.0 + ca), u_time).r;
  col.g = renderTunnel(uv, u_time).g;
  col.b = renderTunnel(uv * (1.0 - ca), u_time).b;

  // Cool white stars on top.
  float st = stars(uv, u_time);
  col += st * vec3(0.82, 0.88, 1.0) * 0.8;

  fragColor = vec4(col, 1.0);
}
`;
