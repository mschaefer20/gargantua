// Hyperreal ray-traced Schwarzschild black hole.
// Photon geodesics are integrated so the disk and starfield are gravitationally
// lensed. The accretion disk is shaded with a single physically-consistent
// relativistic transfer: the observed intensity scales as g^3.5 where
//   g = (Doppler factor) * (gravitational redshift)
// which produces the strong approaching-side beaming, blue/red shift, and the
// dimming of the innermost disk. A Novikov-Thorne-like temperature profile,
// sheared turbulent filaments, a crisp photon ring (from closest-approach to
// the photon sphere) and a sharp shadow complete the picture.
//
// Units: Schwarzschild radius r_s = 1. Horizon r = 1, photon sphere r = 1.5,
// ISCO r = 3. The disk lies in the y = 0 plane.

export const sceneFrag = /* glsl */ `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_time;
uniform vec3  u_camPos;
uniform mat3  u_camMat;
uniform float u_fov;
uniform float u_diskIntensity;
uniform float u_lensing;
uniform float u_diskOpacity;
uniform float u_starBrightness;
uniform float u_quality;

const float PI = 3.14159265359;

float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash13(vec3 p3){ p3=fract(p3*0.1031); p3+=dot(p3,p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
vec3  hash33(vec3 p3){ p3=fract(p3*vec3(0.1031,0.1030,0.0973)); p3+=dot(p3,p3.yxz+33.33); return fract((p3.xxy+p3.yxx)*p3.zyx); }
float noise3(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(
    mix(mix(hash13(i+vec3(0,0,0)),hash13(i+vec3(1,0,0)),f.x),
        mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),f.x),
        mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),f.x),f.y), f.z);
}
float fbm(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<6;i++){ v+=a*noise3(p); p=p*2.02+1.4; a*=0.5; } return v; }

// Blackbody-ish colour ramp, t in [0,1]: cool red -> amber -> white -> blue.
vec3 blackbody(float t){
  vec3 cool  = vec3(1.0, 0.27, 0.05);
  vec3 mid   = vec3(1.0, 0.66, 0.28);
  vec3 hot   = vec3(1.0, 0.95, 0.86);
  vec3 white = vec3(0.82, 0.88, 1.0);
  vec3 c;
  if (t < 0.4)       c = mix(cool, mid, t/0.4);
  else if (t < 0.75) c = mix(mid, hot, (t-0.4)/0.35);
  else               c = mix(hot, white, (t-0.75)/0.25);
  return c;
}

// Clean, photographic starfield (sparse crisp stars + very faint nebulosity).
vec3 starfield(vec3 dir){
  vec3 col = vec3(0.0);
  float neb = pow(fbm(dir*2.1 + 11.0), 4.0);
  col += mix(vec3(0.015,0.02,0.045), vec3(0.05,0.025,0.05), fbm(dir*1.2)) * neb * 0.6;
  float band = exp(-abs(dir.y)*5.0);
  col += vec3(0.03,0.03,0.05) * band * pow(fbm(dir*5.0), 2.0);

  for (int layer=0; layer<3; layer++){
    float scale = 260.0 + float(layer)*420.0;
    vec3 id = floor(dir*scale);
    vec3 rnd = hash33(id + float(layer)*17.0);
    if (rnd.x > 0.955){
      vec3 sp = normalize(id + 0.5 + (rnd-0.5)*0.7);
      float d = max(0.0, dot(dir, sp));
      float spark = pow(d, 11000.0 + rnd.y*9000.0);
      float tw = 0.78 + 0.22*sin(u_time*(1.2+rnd.z*2.5)+rnd.x*30.0);
      col += mix(vec3(1.0,0.86,0.72), vec3(0.74,0.82,1.0), rnd.z) * spark * tw * (1.2-float(layer)*0.25);
    }
  }
  return col * u_starBrightness;
}

// Accretion-disk radiance at a disk-plane crossing point p, for a photon that
// arrived travelling along rayDir.
vec3 diskEmission(vec3 p, vec3 rayDir){
  float r = length(p.xz);
  float innerR = 2.6;
  float outerR = 13.0;
  if (r < innerR || r > outerR) return vec3(0.0);

  float tnorm = clamp((r - innerR) / (outerR - innerR), 0.0, 1.0);
  float ang = atan(p.z, p.x);

  // Keplerian orbital speed (~r^-1/2) and angular velocity (~r^-3/2).
  float vKep  = pow(innerR / r, 0.5);
  float omega = pow(innerR / r, 1.5);
  float swirl = ang + u_time * omega * 1.7;
  float lr = log(r);

  // Sheared turbulent filaments (differential rotation shears the noise).
  vec3 np = vec3(cos(swirl)*r, sin(swirl)*r, lr*3.0) * 0.6;
  float dens = pow(fbm(np + vec3(0.0,0.0,u_time*0.13)), 1.6);
  float streaks = 0.5 + 0.5*sin(swirl*2.0 + lr*7.0 - u_time*1.2);
  float fine = fbm(np*3.1 + 7.0);
  dens *= (0.4 + 0.85*streaks) * (0.55 + 0.85*fine);

  // Novikov-Thorne-ish temperature: peaks near the inner edge, ~r^-3/4.
  float temp = clamp(pow(innerR / r, 0.75), 0.0, 1.0);
  vec3 col = blackbody(temp);

  // Radial emissivity profile.
  float radial = smoothstep(outerR, innerR + 0.4, r) * smoothstep(innerR, innerR + 0.3, r);
  float emiss = radial * (0.35 + 2.2*pow(temp, 1.5)) * dens;

  // ---- relativistic transfer: g = Doppler * gravitational redshift ----
  vec3 vdir = normalize(vec3(-p.z, 0.0, p.x));
  float beta = clamp(vKep * 0.72, 0.0, 0.9);
  float losv = dot(vdir, -normalize(rayDir));
  float gamma = 1.0 / sqrt(1.0 - beta*beta);
  float doppler = 1.0 / (gamma * (1.0 - beta*losv));
  float grav = sqrt(max(1.0 - 1.0/r, 0.02));
  float g = doppler * grav;

  // Colour shift with the total energy factor g (blue if g>1, red if g<1).
  col = mix(col * vec3(1.45, 1.0, 0.62), col, smoothstep(0.55, 1.0, g));
  col = mix(col, col * vec3(0.78, 0.9, 1.45), smoothstep(1.0, 1.7, g));

  // Observed intensity boost I_obs ~ g^3.5 (relativistic beaming + redshift).
  float boost = pow(clamp(g, 0.05, 3.0), 3.5);

  return col * emiss * boost * u_diskIntensity;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_resolution) / u_resolution.y;
  vec3 ro = u_camPos;
  vec3 rd = normalize(u_camMat * vec3(uv*u_fov, 1.0));

  vec3 pos = ro;
  vec3 dir = rd;
  float h2 = dot(cross(pos, dir), cross(pos, dir));

  vec3 accum = vec3(0.0);
  float transmit = 1.0;
  bool captured = false;
  float minR = 1e9;

  int steps = int(260.0 * u_quality);

  for (int i = 0; i < 560; i++){
    if (i >= steps) break;
    float r = length(pos);
    minR = min(minR, r);

    float dt = clamp(r * 0.11, 0.010, 0.45);
    vec3 prevPos = pos;

    vec3 accel = -1.5 * h2 * pos / pow(dot(pos, pos), 2.5);
    dir += accel * dt * u_lensing;
    dir = normalize(dir);
    pos += dir * dt;

    if (r < 1.0) { captured = true; break; }

    // Disk-plane crossing (sign change in y) -> sample disk, composite.
    if (prevPos.y * pos.y < 0.0){
      float tcross = prevPos.y / (prevPos.y - pos.y);
      vec3 cp = mix(prevPos, pos, tcross);
      float cr = length(cp.xz);
      if (cr > 2.4 && cr < 13.5){
        vec3 e = diskEmission(cp, dir);
        float a = clamp(length(e) * 0.4 * u_diskOpacity, 0.0, 1.0);
        accum += e * transmit;
        transmit *= (1.0 - a * 0.6);
      }
    }

    if (r > 40.0 && dot(pos, dir) > 0.0) break;
  }

  vec3 color = accum;

  if (!captured){
    color += starfield(normalize(dir)) * transmit;
  }

  // Photon ring: light that grazed the photon sphere (~1.5) piles up into a
  // thin bright ring hugging the shadow's edge.
  float pr = exp(-pow((minR - 1.5) / 0.16, 2.0));
  color += vec3(1.0, 0.86, 0.62) * pr * 0.45 * u_diskIntensity * (captured ? 0.0 : 1.0);

  fragColor = vec4(color, 1.0);
}
`;
