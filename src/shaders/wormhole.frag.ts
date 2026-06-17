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

// Cosmic palette (Inigo Quilez style cosine gradient).
vec3 palette(float t) {
  return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67)));
}

// The tunnel walls + throat, evaluated for one (possibly aberrated) uv.
vec3 renderTunnel(vec2 uv, float t) {
  float r = length(uv);
  float a = atan(uv.y, uv.x);

  // Perspective tunnel: as r -> 0 the wall recedes to infinity.
  float depth = t * u_speed + 0.30 / (r + 0.06);

  // Vortex swirl, stronger toward the centre.
  float swirl = a + 0.45 / (r + 0.08) - t * 0.30;

  // Successive "universes" -> palette hue shifts along depth.
  float sec = depth * 0.045;
  float uid = floor(sec);
  float hue = hash11(uid) + fract(sec) * 0.15;

  // Flowing energy veins along the walls.
  vec3 p = vec3(swirl * 2.0, depth * 1.4, t * 0.15);
  float e = fbm(p);
  float fine = fbm(p * 3.1 + 7.0);
  float veins = pow(e, 2.0) * 0.75 + fine * 0.25;

  // Square the energy so low-energy regions go dark -> high contrast tunnel.
  float energy = veins * veins;
  vec3 col = palette(hue + veins * 0.25 + r * 0.12) * energy * 1.4;

  // Walls fade out toward the centre (which is the bright throat instead).
  float wall = smoothstep(0.04, 0.6, r);
  col *= 0.18 + 0.95 * wall;

  // The throat: the bright, contained light at the end of the wormhole.
  float throat = pow(clamp(1.0 - r * 1.55, 0.0, 1.0), 3.5);
  vec3 throatCol = mix(vec3(0.6, 0.85, 1.0), palette(hue + 0.5), 0.35);
  col += throatCol * throat * 1.7 * u_throat;

  // Concentric lensing rings rushing into the throat.
  float rings = 0.5 + 0.5 * sin(depth * 5.5 - t * 2.2);
  col += throatCol * rings * throat * 0.7 * u_throat;

  // Darken the deep tunnel between walls and throat for depth.
  col *= 1.0 - 0.5 * smoothstep(0.18, 0.42, r) * (1.0 - smoothstep(0.55, 0.75, r));

  return col;
}

// Warp-speed star streaks: points seeded per angular sector, sliding inward.
float streaks(vec2 uv, float t) {
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  const float N = 130.0;
  float sa = (a / TAU + 0.5) * N;
  float cell = floor(sa);
  float f = fract(sa) - 0.5;

  float s = 0.0;
  float elong = mix(120.0, 35.0, clamp(u_speed * 0.05, 0.0, 1.0));
  for (int k = 0; k < 2; k++) {
    vec2 rnd = hash22(vec2(cell, float(k) * 9.0));
    float prog = fract(rnd.x + t * u_speed * 0.10 + float(k) * 0.37);
    float starR = (1.0 - prog) * 1.5;
    float dR = r - starR;
    float life = sin(prog * PI);                 // fade in then out
    float ang = exp(-f * f * 26.0);              // thin in angle
    float rad = exp(-dR * dR * elong);           // elongated along radius
    s += ang * rad * life * (0.6 + 0.4 * rnd.y);
  }
  return s * u_warp;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
  uv += u_mouse * 0.12;                          // gentle steering

  float r = length(uv);
  // Chromatic aberration grows with radius and speed.
  float ca = (0.003 + u_speed * 0.0009) * (0.35 + r);

  vec3 col;
  col.r = renderTunnel(uv * (1.0 + ca), u_time).r;
  col.g = renderTunnel(uv, u_time).g;
  col.b = renderTunnel(uv * (1.0 - ca), u_time).b;

  // Streaks on top (warm white, doppler-blue toward the throat).
  float st = streaks(uv, u_time);
  col += st * mix(vec3(1.0, 0.95, 0.85), vec3(0.7, 0.85, 1.2), 1.0 - r);

  // A faint flash when crossing a universe boundary.
  float depth = u_time * u_speed;
  float flash = pow(fract(depth * 0.045), 40.0);
  col += vec3(0.8, 0.9, 1.0) * flash * 1.5;

  fragColor = vec4(col, 1.0);
}
`;
