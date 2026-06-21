// Photoreal spiral galaxy — volumetric raymarch of a thin galactic disk built
// to read like a real astrophotograph rather than a smooth glow:
//   * resolved stars: medium-frequency stellar granulation + sparse bright
//     point-star layers, so the disk is visibly made of stars
//   * sharp, dark, filamentary DUST LANES that absorb the light behind them
//   * discrete pink HII star-forming regions with hot-blue cluster cores
//   * a concentrated old-yellow bulge and flocculent (domain-warped) arms
//   * a deep-field background with faint stars and a couple of distant galaxies
// Output is linear HDR for the bloom/ACES pass.

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
const float DISK_R = 15.0;
const float BOUND  = 18.0;

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
float fbm(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<5;i++){ v+=a*noise3(p); p=p*2.04+1.5; a*=0.5; } return v; }
float ridge(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*(1.0-abs(noise3(p)*2.0-1.0)); p=p*2.07+1.0; a*=0.5; } return v; }

// Sparse bright point-stars: cheap single-cell hash lattice. count ~ (1-thresh).
float starLayer(vec3 p, float scale, float thresh, out vec3 tint){
  vec3 q = p*scale;
  vec3 id = floor(q);
  vec3 f = fract(q) - 0.5;
  vec3 r = hash33(id);
  tint = mix(vec3(1.0,0.86,0.66), vec3(0.7,0.82,1.0), r.z); // K-type to O/B
  if(r.x < thresh) return 0.0;
  float d = length(f - (r.xyz-0.5)*0.55);
  float core = smoothstep(0.42, 0.0, d);
  return core*core * (0.4 + 0.6*r.y);
}

// ---- deep-field background ----
vec3 background(vec3 dir){
  vec3 col = vec3(0.0);
  for(int layer=0; layer<2; layer++){
    float scale = 320.0 + float(layer)*520.0;
    vec3 id = floor(dir*scale);
    vec3 rnd = hash33(id + float(layer)*23.0);
    if(rnd.x > 0.978){
      vec3 sp = normalize(id + 0.5 + (rnd-0.5)*0.6);
      float d = max(0.0, dot(dir, sp));
      float spark = pow(d, 13000.0 + rnd.y*9000.0);
      float tw = 0.75 + 0.25*sin(u_time*(1.0+rnd.z*2.0)+rnd.x*30.0);
      col += mix(vec3(1.0,0.88,0.78), vec3(0.78,0.85,1.0), rnd.z) * spark * tw * 0.8;
    }
  }
  // a couple of faint distant galaxies
  for(int i=0;i<3;i++){
    vec3 g = normalize(hash33(vec3(float(i)*7.1))*2.0-1.0);
    float d = max(0.0, dot(dir, g));
    float core = pow(d, 7000.0);
    float halo = pow(d, 600.0);
    col += (vec3(1.0,0.9,0.75)*core*0.8 + vec3(0.5,0.55,0.8)*halo*0.04);
  }
  col += vec3(0.008,0.010,0.020) * pow(fbm(dir*3.0), 3.0); // faint nebulosity
  return col * u_starBrightness;
}

// Galaxy sample: writes emission and dust absorption at point p.
void sampleGalaxy(vec3 p, out vec3 emission, out float absorption){
  emission = vec3(0.0);
  absorption = 0.0;

  float r = length(p.xz);
  if(r > DISK_R) return;
  float h = p.y;

  // differential rotation winds the pattern (inner faster)
  float ang = atan(p.z, p.x);
  float rot = u_time * 0.07 / (0.5 + r*0.18);
  float a = ang + rot;

  // unwrapped disk coords for seamless texturing
  vec3 disk3 = vec3(cos(a)*r, h*2.5, sin(a)*r);

  // flocculent warp of the spiral
  float warp = (fbm(disk3*0.35) - 0.5) * 2.2;

  // thin disk + rounder bulge
  float thick = 0.16 + 0.6*exp(-r*0.6);
  float vert = exp(-(h*h)/(2.0*thick*thick));

  // grand-design 2-arm spiral, domain-warped, plus a weaker 4-arm harmonic
  float phase = 2.0*a - log(r+0.5)*4.4 + warp;
  float arm = pow(0.5 + 0.5*cos(phase), 2.2);
  arm += 0.35*pow(0.5 + 0.5*cos(2.0*phase + warp), 3.0);
  arm = clamp(arm, 0.0, 1.4);

  float radial = exp(-r/3.8);
  float interArm = 0.16;
  float diskDens = radial * (interArm + arm) * vert;

  // concentrated old-star bulge (rounder); kept from blowing out to a blob
  float br = length(p*vec3(1.0,1.6,1.0));
  float bulge = exp(-br/1.8)*1.0 + exp(-br/0.55)*1.3;

  // stellar granulation breaks the smooth glow into mottled star clouds
  float mott = mix(0.45, 1.55, fbm(disk3*1.6));
  diskDens *= mott;

  float dens = diskDens + bulge*0.9;
  dens = max(dens - 0.02, 0.0);

  // ---- population colour ----
  float tnorm = clamp(r/DISK_R, 0.0, 1.0);
  vec3 coreCol = vec3(1.0, 0.80, 0.52);   // old yellow stars
  vec3 diskCol = vec3(0.85, 0.85, 0.92);  // mixed disk
  vec3 armCol  = vec3(0.62, 0.74, 1.0);   // young blue stars
  vec3 col = mix(coreCol, diskCol, smoothstep(0.04, 0.22, tnorm));
  col = mix(col, armCol, smoothstep(0.18, 0.5, tnorm) * smoothstep(0.4,0.9,arm));
  col = mix(col, vec3(1.0,0.96,0.85), clamp(bulge*0.4,0.0,1.0)); // hot core

  emission = col * dens;

  // ---- resolved bright stars (sit on top of the cloud) ----
  vec3 tintA, tintB;
  float s1 = starLayer(p, 5.5, 0.86, tintA);
  float s2 = starLayer(p, 11.0, 0.91, tintB);
  float starField = (s1*1.0 + s2*0.6) * smoothstep(0.0, 0.25, diskDens + bulge*0.2);
  emission += (tintA*s1 + tintB*s2) * starField * 2.5;

  // ---- HII regions: discrete pink emission knots + hot blue cluster cores ----
  float knot = ridge(disk3*1.2 + 4.0);
  float hii = smoothstep(0.82, 0.97, knot) * smoothstep(0.4,0.9,arm) * smoothstep(0.12,0.5,tnorm) * vert;
  emission += vec3(1.0, 0.34, 0.52) * hii * 1.7;                 // H-alpha pink
  emission += vec3(0.78, 0.88, 1.0) * pow(hii,1.5) * 2.6;        // embedded clusters

  // ---- dust lanes: dark filaments hugging the inner edge of the arms ----
  float dustArm = pow(0.5 + 0.5*cos(phase - 0.35), 3.0);        // offset from light
  float dustN = ridge(disk3*0.7 + 9.0);
  float dustVert = exp(-(h*h)/(2.0*0.12*0.12));                  // very thin lane
  float dust = smoothstep(0.45, 0.85, dustN) * dustArm * radial * dustVert;
  absorption = dust * 9.0 * u_dust;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_resolution)/u_resolution.y;
  vec3 ro = u_camPos;
  vec3 rd = normalize(u_camMat * vec3(uv*u_fov, 1.0));

  float b = dot(ro, rd);
  float c = dot(ro, ro) - BOUND*BOUND;
  float disc = b*b - c;

  vec3 col = vec3(0.0);
  float transmit = 1.0;

  if(disc > 0.0){
    float sq = sqrt(disc);
    float t0 = max(-b - sq, 0.0);
    float t1 = -b + sq;

    int steps = int(150.0 * u_quality);
    float dt = (t1 - t0) / float(steps);
    float jitter = hash13(vec3(gl_FragCoord.xy, fract(u_time)));
    float t = t0 + dt*jitter;

    for(int i=0; i<320; i++){
      if(i>=steps || transmit < 0.004) break;
      vec3 p = ro + rd*t;
      vec3 e; float ab;
      sampleGalaxy(p, e, ab);
      // emission attenuated by nearer dust; then dust eats light behind it.
      col += e * transmit * dt * 2.3 * u_brightness;
      transmit *= exp(-ab * dt);
      t += dt;
    }
  }

  // background shows through wherever the disk + dust let it
  col += background(normalize(rd)) * transmit;

  fragColor = vec4(col, 1.0);
}
`;
