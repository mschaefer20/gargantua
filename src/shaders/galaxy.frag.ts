// Spiral galaxy shader: a volumetric raymarch through a thin galactic disk.
// Density combines an exponential disk, a central bulge, and a logarithmic
// two-armed spiral broken up by turbulence; dust lanes absorb light. Young
// blue arms, warm core, and pink HII star-forming knots. Differential rotation
// winds the arms slowly over time. Output is linear HDR for the bloom/ACES pass.

export const galaxyFrag = /* glsl */ `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_time;
uniform vec3  u_camPos;
uniform mat3  u_camMat;
uniform float u_fov;
uniform float u_brightness;
uniform float u_dust;        // dust-lane absorption strength
uniform float u_starBrightness;
uniform float u_quality;     // step-count multiplier

const float PI = 3.14159265359;
const float DISK_R = 15.0;   // disk outer radius
const float BOUND  = 18.0;   // bounding sphere for the march

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
float fbm(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*noise3(p); p*=2.05; a*=0.5; } return v; }

// Background starfield sampled by ray direction (sparse, twinkling).
vec3 background(vec3 dir){
  vec3 col = vec3(0.0);
  // faint cool nebulosity
  col += vec3(0.015,0.02,0.05) * pow(fbm(dir*2.0), 2.0);
  for(int layer=0; layer<2; layer++){
    float scale = 260.0 + float(layer)*420.0;
    vec3 id = floor(dir*scale);
    vec3 rnd = hash33(id + float(layer)*23.0);
    if(rnd.x > 0.94){
      vec3 sp = normalize(id + 0.5 + (rnd-0.5)*0.6);
      float d = max(0.0, dot(dir, sp));
      float spark = pow(d, 9000.0 + rnd.y*9000.0);
      float tw = 0.7 + 0.3*sin(u_time*(1.0+rnd.z*2.0)+rnd.x*30.0);
      col += mix(vec3(1.0,0.9,0.8), vec3(0.8,0.85,1.0), rnd.z) * spark * tw;
    }
  }
  return col * u_starBrightness;
}

// Galaxy density + emissive colour at a point. Returns rgb=emission, a=density.
vec4 sampleGalaxy(vec3 p){
  float r = length(p.xz);
  if(r > DISK_R) return vec4(0.0);

  float h = p.y;
  // thin disk vertically; the bulge is rounder.
  float thick = 0.30 + 0.5*exp(-r*0.5);
  float vert = exp(-(h*h)/(2.0*thick*thick));

  // exponential radial disk + bright central bulge
  float disk = exp(-r/4.0);
  float bulge = exp(-length(p)/1.4) * 1.6;

  // differential rotation: inner regions lead.
  float ang = atan(p.z, p.x);
  float rot = u_time * 0.10 / (0.6 + r*0.18);
  float a = ang + rot;

  // two-armed logarithmic spiral
  float arms = cos(2.0*a - log(r+0.6)*4.3);
  float armMask = pow(0.5 + 0.5*arms, 1.8);

  // turbulence breaks the arms into clouds
  float turb = fbm(vec3(cos(a)*r, p.y*2.0, sin(a)*r) * 0.45 + vec3(0.0,0.0,u_time*0.02));
  float clouds = mix(0.4, 1.4, turb);

  float dens = (disk * (0.25 + armMask*1.1) + bulge) * vert * clouds;
  dens = max(dens - 0.04, 0.0);   // trim faint haze for cleaner blacks

  // --- colour ---
  float tnorm = clamp(r/DISK_R, 0.0, 1.0);
  vec3 armCol  = vec3(0.55, 0.68, 1.0);            // young blue stars
  vec3 coreCol = vec3(1.0, 0.82, 0.5);             // warm old core
  vec3 col = mix(coreCol, armCol, smoothstep(0.05, 0.4, tnorm));

  // pink HII star-forming knots along the arms
  float hii = smoothstep(0.75, 0.95, turb) * armMask * smoothstep(0.15,0.45,tnorm);
  col = mix(col, vec3(1.0, 0.45, 0.7), hii*0.6);

  // brighten the very core
  col = mix(col, vec3(1.0, 0.95, 0.82), bulge*0.5);

  return vec4(col, dens);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_resolution)/u_resolution.y;
  vec3 ro = u_camPos;
  vec3 rd = normalize(u_camMat * vec3(uv*u_fov, 1.0));

  // intersect bounding sphere
  float b = dot(ro, rd);
  float c = dot(ro, ro) - BOUND*BOUND;
  float disc = b*b - c;

  vec3 col = vec3(0.0);
  float transmit = 1.0;

  if(disc > 0.0){
    float sq = sqrt(disc);
    float t0 = max(-b - sq, 0.0);
    float t1 = -b + sq;

    int steps = int(90.0 * u_quality);
    float dt = (t1 - t0) / float(steps);
    // jitter to suppress slice banding
    float jitter = hash13(vec3(gl_FragCoord.xy, u_time));
    float t = t0 + dt*jitter;

    for(int i=0; i<256; i++){
      if(i>=steps || transmit < 0.01) break;
      vec3 p = ro + rd*t;
      vec4 s = sampleGalaxy(p);
      float d = s.a;
      if(d > 0.0){
        float a = 1.0 - exp(-d * dt * 1.6);
        // emission scales with density; dust absorbs (more in dense lanes).
        col += s.rgb * d * dt * 2.2 * transmit * u_brightness;
        transmit *= 1.0 - a * clamp(u_dust*0.5, 0.0, 0.95);
      }
      t += dt;
    }
  }

  // background stars where the galaxy is thin/transparent
  col += background(normalize(rd)) * transmit;

  fragColor = vec4(col, 1.0);
}
`;
