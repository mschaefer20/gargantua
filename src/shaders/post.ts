// Shared fullscreen-triangle vertex shader and the post-processing fragment
// shaders: a bright-pass + separable Gaussian blur for bloom, and a final
// composite stage with ACES filmic tonemapping, vignette, grain and gamma.

export const fullscreenVert = /* glsl */ `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // Single oversized triangle covering the screen.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Extract bright areas (the disk + photon ring) for the bloom source.
export const brightPassFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform float u_threshold;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(0.0, luma - u_threshold) / max(luma, 1e-4);
  fragColor = vec4(c * k, 1.0);
}
`;

// Separable 9-tap Gaussian. u_dir is (texelX, 0) or (0, texelY).
export const blurFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform vec2 u_dir;
void main() {
  float w[5];
  w[0] = 0.227027; w[1] = 0.194594; w[2] = 0.121621;
  w[3] = 0.054054; w[4] = 0.016216;
  vec3 result = texture(u_tex, v_uv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = u_dir * float(i);
    result += texture(u_tex, v_uv + off).rgb * w[i];
    result += texture(u_tex, v_uv - off).rgb * w[i];
  }
  fragColor = vec4(result, 1.0);
}
`;

// Final composite: scene + bloom, ACES tonemap, vignette, subtle grain.
export const compositeFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
uniform float u_exposure;
uniform float u_time;

// ACES filmic tonemap (Narkowicz approximation).
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  vec2 q = v_uv - 0.5;
  float r2 = dot(q, q);

  // Lens chromatic aberration: split the channels slightly toward the edges
  // (scene + bloom), for a filmed-through-glass realism.
  float ca = (0.0016 + 0.004 * r2) * r2;
  vec2 dir = q * ca;
  vec3 scene = vec3(
    texture(u_scene, v_uv + dir).r,
    texture(u_scene, v_uv).g,
    texture(u_scene, v_uv - dir).b);
  vec3 bloom = vec3(
    texture(u_bloom, v_uv + dir).r,
    texture(u_bloom, v_uv).g,
    texture(u_bloom, v_uv - dir).b);

  vec3 color = scene + bloom * u_bloomStrength;
  color *= u_exposure;

  // Filmic tonemap.
  color = aces(color);

  // Soft cinematic vignette.
  float vig = smoothstep(1.10, 0.30, length(q) * 1.30);
  color *= mix(0.70, 1.0, vig);

  // Gentle warm/cool split-tone for depth (cool shadows, neutral highlights).
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(color * vec3(0.96, 0.99, 1.06), color, smoothstep(0.0, 0.5, luma));

  // Fine dithered grain — kills banding in the deep blacks without looking noisy.
  float g = hash(v_uv * vec2(1280.0, 720.0) + fract(u_time)) +
            hash(v_uv * vec2(640.0, 360.0) - fract(u_time * 1.3));
  color += (g - 1.0) * 0.006;

  // Gamma to sRGB.
  color = pow(max(color, 0.0), vec3(1.0 / 2.2));
  fragColor = vec4(color, 1.0);
}
`;
