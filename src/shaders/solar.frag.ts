// Solar system shader. The Sun + 8 planets + the Moon are analytic spheres,
// each shaded with a bespoke procedural surface: cratered rock, banded gas
// giants with storms, an Earth with oceans/continents/clouds/night-lights/
// atmosphere, polar ice, Saturn's ring system (Cassini division + ring shadow),
// limb-darkened granulating Sun with corona, faint orbit lines and a starfield.
// Bodies are lit from the Sun at the origin. Output is linear HDR.

export const solarFrag = /* glsl */ `#version 300 es
precision highp float;

out vec4 fragColor;

#define NUM 10

uniform vec2  u_resolution;
uniform float u_time;
uniform vec3  u_camPos;
uniform mat3  u_camMat;
uniform float u_fov;
uniform vec3  u_pos[NUM];     // world positions of each body
uniform float u_rad[NUM];     // radius of each body
uniform float u_orbitR[NUM];  // orbital radius (for drawing orbit lines)
uniform float u_orbitLines;   // 0..1 orbit-line opacity
uniform float u_exposureGlow; // sun corona intensity

const float PI = 3.14159265359;

// per-body surface spin rates (radians / sec of sim time)
const float SPIN[NUM] = float[NUM](
  0.06,   // 0 sun
  0.10,   // 1 mercury
  0.04,   // 2 venus
  0.55,   // 3 earth
  0.52,   // 4 mars
  1.10,   // 5 jupiter
  1.00,   // 6 saturn
  0.70,   // 7 uranus
  0.75,   // 8 neptune
  0.20    // 9 moon
);

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
float fbm(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<6;i++){ v+=a*noise3(p); p=p*2.03+1.7; a*=0.5; } return v; }
float ridge(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<5;i++){ v+=a*abs(noise3(p)*2.0-1.0); p=p*2.05+1.0; a*=0.5; } return v; }

vec3 rotY(vec3 p, float a){ float c=cos(a),s=sin(a); return vec3(c*p.x+s*p.z, p.y, -s*p.x+c*p.z); }

float iSphere(vec3 ro, vec3 rd, vec3 ce, float ra){
  vec3 oc = ro-ce;
  float b = dot(oc,rd);
  float c = dot(oc,oc)-ra*ra;
  float h = b*b-c;
  if(h<0.0) return -1.0;
  h=sqrt(h);
  float t=-b-h;
  if(t>0.0) return t;
  t=-b+h; return t>0.0? t : -1.0;
}

// ---------- background stars ----------
vec3 starfield(vec3 dir){
  vec3 col = vec3(0.0);
  for(int layer=0; layer<2; layer++){
    float scale = 300.0 + float(layer)*500.0;
    vec3 id = floor(dir*scale);
    vec3 rnd = hash33(id + float(layer)*19.0);
    if(rnd.x > 0.95){
      vec3 sp = normalize(id + 0.5 + (rnd-0.5)*0.6);
      float d = max(0.0, dot(dir, sp));
      float spark = pow(d, 11000.0);
      float tw = 0.7 + 0.3*sin(u_time*(1.0+rnd.z*2.0)+rnd.x*30.0);
      col += mix(vec3(1.0,0.9,0.8), vec3(0.8,0.85,1.0), rnd.z) * spark * tw;
    }
  }
  col += vec3(0.01,0.012,0.02) * pow(fbm(dir*3.0),3.0); // faint milky way
  return col;
}

// ---------- per-planet albedo (object-space normal sn) ----------
vec3 planetAlbedo(int idx, vec3 sn, out float spec, out float cloud){
  spec = 0.0; cloud = 0.0;
  vec3 col = vec3(0.5);

  if(idx==1){ // Mercury
    float c = fbm(sn*4.0);
    float cr = ridge(sn*7.0);
    col = mix(vec3(0.26,0.24,0.22), vec3(0.55,0.52,0.49), c);
    col *= 0.7+0.5*cr;
  } else if(idx==2){ // Venus
    float b = fbm(sn*3.0 + vec3(u_time*0.03,0,0));
    float sw = fbm(sn*6.0 + b*2.5);
    col = mix(vec3(0.78,0.62,0.32), vec3(0.96,0.88,0.62), sw);
    col = mix(col, vec3(0.9,0.78,0.5), 0.3);
  } else if(idx==3){ // Earth
    float land = fbm(sn*2.3);
    float lm = smoothstep(0.49,0.53, land);
    float veg = fbm(sn*5.0+11.0);
    vec3 landCol = mix(vec3(0.13,0.30,0.09), vec3(0.45,0.36,0.20), veg);
    landCol = mix(landCol, vec3(0.32,0.42,0.16), smoothstep(0.0,0.3,veg)*0.4);
    float ice = smoothstep(0.74,0.86, abs(sn.y));
    landCol = mix(landCol, vec3(0.92,0.95,0.98), ice);
    vec3 ocean = mix(vec3(0.01,0.09,0.27), vec3(0.0,0.18,0.40), fbm(sn*6.0));
    col = mix(ocean, landCol, lm);
    spec = (1.0-lm); // oceans are glossy
    float cl = smoothstep(0.52,0.72, fbm(sn*3.0 + vec3(u_time*0.02,0,0)));
    cloud = cl;
  } else if(idx==4){ // Mars
    float m = fbm(sn*3.0);
    col = mix(vec3(0.52,0.24,0.12), vec3(0.74,0.42,0.22), m);
    float dark = smoothstep(0.42,0.62, fbm(sn*5.0+3.0));
    col = mix(col, vec3(0.34,0.17,0.11), dark*0.5);
    float ice = smoothstep(0.82,0.92, abs(sn.y));
    col = mix(col, vec3(0.95,0.96,0.98), ice);
  } else if(idx==5){ // Jupiter
    float turb = (fbm(sn*4.0)-0.5)*0.18;
    float lat = sn.y + turb;
    float band = sin(lat*20.0);
    vec3 cA=vec3(0.82,0.72,0.56), cB=vec3(0.60,0.40,0.26), cC=vec3(0.90,0.84,0.74);
    col = mix(cB, cA, smoothstep(-0.25,0.25,band));
    col = mix(col, cC, smoothstep(0.6,1.0, sin(lat*10.0)));
    col *= 0.85+0.3*fbm(sn*9.0);
    // Great Red Spot
    vec3 spot = normalize(vec3(0.55,-0.32,0.77));
    vec3 q = sn - spot; q.y *= 1.7;             // squash to an oval
    float gr = smoothstep(0.34,0.0, length(q));
    col = mix(col, vec3(0.78,0.30,0.18), gr*0.9);
  } else if(idx==6){ // Saturn
    float turb = (fbm(sn*4.0)-0.5)*0.12;
    float band = sin((sn.y+turb)*16.0);
    vec3 cA=vec3(0.86,0.78,0.58), cB=vec3(0.74,0.63,0.42);
    col = mix(cB, cA, smoothstep(-0.3,0.3,band));
    col *= 0.9+0.2*fbm(sn*8.0);
  } else if(idx==7){ // Uranus
    float band = sin(sn.y*9.0 + fbm(sn*3.0));
    col = mix(vec3(0.52,0.78,0.80), vec3(0.66,0.86,0.86), 0.5+0.5*band);
  } else if(idx==8){ // Neptune
    float band = sin(sn.y*8.0 + (fbm(sn*3.0)-0.5));
    col = mix(vec3(0.13,0.28,0.66), vec3(0.20,0.42,0.86), 0.5+0.5*band);
    vec3 ds = normalize(vec3(0.5,0.35,0.79));
    col = mix(col, vec3(0.08,0.13,0.32), smoothstep(0.22,0.02, distance(sn,ds)));
    col = mix(col, vec3(0.92,0.95,1.0), smoothstep(0.82,0.96, fbm(sn*6.0))*0.5);
  } else if(idx==9){ // Moon
    float c = fbm(sn*4.0);
    float cr = ridge(sn*8.0);
    col = mix(vec3(0.20,0.20,0.21), vec3(0.62,0.61,0.60), c);
    col = mix(col, vec3(0.16,0.16,0.18), smoothstep(0.55,0.75,fbm(sn*2.5))*0.5); // maria
    col *= 0.7+0.5*cr;
  }
  return col;
}

vec3 atmoColor(int idx){
  if(idx==3) return vec3(0.25,0.5,1.0);   // Earth blue
  if(idx==2) return vec3(0.9,0.75,0.4);    // Venus haze
  if(idx==5) return vec3(0.7,0.6,0.45);
  if(idx==6) return vec3(0.75,0.68,0.5);
  if(idx==7) return vec3(0.5,0.78,0.82);
  if(idx==8) return vec3(0.25,0.45,0.9);
  return vec3(0.0);
}

// Saturn ring plane (tilted). Shared by ring render + ring shadow.
const vec3 RING_N = vec3(0.30, 0.94, 0.16);
const float RING_IN = 1.35;   // * saturn radius
const float RING_OUT = 2.30;

// Ring sample: returns rgb in .xyz and alpha in .w for a given world radius.
vec4 ringSample(float rr, float litFactor){
  float u = (rr - RING_IN) / (RING_OUT - RING_IN);   // 0..1 across rings
  if(u < 0.0 || u > 1.0) return vec4(0.0);
  // banding + Cassini division gap
  float bands = 0.55 + 0.45*sin(u*60.0);
  float cassini = smoothstep(0.02,0.05, abs(u-0.62));  // dark gap
  float inner = smoothstep(0.0,0.05,u);
  float outer = smoothstep(1.0,0.92,u);
  float a = bands * cassini * inner * outer;
  vec3 c = mix(vec3(0.62,0.55,0.42), vec3(0.85,0.80,0.68), sin(u*30.0)*0.5+0.5);
  return vec4(c * (0.25 + 0.9*litFactor), a*0.92);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_resolution)/u_resolution.y;
  vec3 ro = u_camPos;
  vec3 rd = normalize(u_camMat * vec3(uv*u_fov, 1.0));

  // nearest body
  float tBody = 1e9; int hit = -1;
  for(int i=0;i<NUM;i++){
    float t = iSphere(ro, rd, u_pos[i], u_rad[i]);
    if(t>0.0 && t<tBody){ tBody=t; hit=i; }
  }

  vec3 col = starfield(rd);
  float depth = 1e9;

  // ---- orbit lines on the ecliptic plane (y = 0) ----
  if(u_orbitLines > 0.001 && abs(rd.y) > 1e-4){
    float tp = -ro.y / rd.y;
    if(tp > 0.0 && tp < tBody){
      vec3 pp = ro + rd*tp;
      float rr = length(pp.xz);
      float line = 0.0;
      for(int i=1;i<NUM-1;i++){               // skip sun(0) and moon(last)
        line += smoothstep(0.06, 0.0, abs(rr - u_orbitR[i]));
      }
      col += vec3(0.18,0.26,0.42) * line * u_orbitLines * 0.5;
    }
  }

  // ---- body shading ----
  if(hit >= 0){
    vec3 p = ro + rd*tBody;
    vec3 n = normalize(p - u_pos[hit]);
    vec3 L = normalize(u_pos[0] - p);             // toward the sun
    vec3 sn = rotY(n, -u_time*SPIN[hit]);
    depth = tBody;

    if(hit==0){
      // ---- the Sun (emissive) ----
      float gran = fbm(sn*7.0 + u_time*0.15);
      float gran2 = fbm(sn*16.0 - u_time*0.1);
      float spots = smoothstep(0.62,0.42, fbm(sn*4.0+5.0));
      vec3 s = mix(vec3(1.0,0.45,0.08), vec3(1.0,0.92,0.62), gran*0.7+gran2*0.3);
      s *= 1.0 - 0.55*spots;
      float limb = pow(max(dot(n,-rd),0.0), 0.45);
      col = s * (1.7 + 1.6*limb) * 2.2;
    } else {
      float spec, cloud;
      vec3 alb = planetAlbedo(hit, sn, spec, cloud);

      float ndl = dot(n, L);
      float day = smoothstep(-0.06, 0.30, ndl);

      // Saturn ring shadow cast onto the planet
      if(hit==6){
        float denom = dot(L, RING_N);
        if(abs(denom) > 1e-4){
          float ts = dot(u_pos[6]-p, RING_N)/denom;
          if(ts > 0.0){
            float rr = length((p + L*ts) - u_pos[6]) / u_rad[6];
            vec4 rs = ringSample(rr, 1.0);
            day *= 1.0 - rs.w*0.7;
          }
        }
      }

      vec3 body = alb * (day*1.15 + 0.02);

      // clouds (Earth) sit above the surface, lit by day
      if(cloud > 0.0){
        body = mix(body, vec3(1.0)*(day*1.1+0.03), cloud*0.8);
        spec *= (1.0-cloud);
      }

      // specular highlight (Earth oceans)
      if(spec > 0.0){
        vec3 h = normalize(L - rd);
        float s = pow(max(dot(n,h),0.0), 80.0);
        body += s * spec * day * vec3(1.0,0.92,0.75) * 1.5;
      }

      // Earth night-side city lights
      if(hit==3){
        float lights = smoothstep(0.5,0.53, fbm(sn*2.3));       // on land
        lights *= smoothstep(0.6,0.75, fbm(sn*7.0+20.0));        // clustered
        body += vec3(1.0,0.8,0.45) * lights * (1.0-day) * (1.0-cloud) * 0.6;
      }

      // atmosphere rim
      float fres = pow(1.0 - max(dot(n,-rd),0.0), 3.0);
      body += atmoColor(hit) * fres * (0.15 + 0.85*day);

      col = body;
    }
  }

  // ---- Saturn rings (transparent, depth-sorted vs bodies) ----
  {
    float denom = dot(rd, RING_N);
    if(abs(denom) > 1e-5){
      float tr = dot(u_pos[6]-ro, RING_N)/denom;
      if(tr > 0.0 && tr < depth){
        vec3 rp = ro + rd*tr;
        float rr = length(rp - u_pos[6]) / u_rad[6];
        // lit by sun; shadow of Saturn onto the ring
        vec3 L = normalize(u_pos[0] - rp);
        float lit = clamp(abs(dot(RING_N, L)), 0.2, 1.0);
        float tsh = iSphere(rp, L, u_pos[6], u_rad[6]);
        if(tsh > 0.0) lit *= 0.25;
        vec4 rs = ringSample(rr, lit);
        col = mix(col, rs.rgb, rs.w);
      }
    }
  }

  // ---- Sun corona / glow (only over sky, not over a planet) ----
  if(hit < 0 || hit == 0){
    vec3 toSun = u_pos[0] - ro;
    float dist = length(toSun);
    float ca = max(dot(rd, toSun/dist), 0.0);
    float glow = pow(ca, 200.0)*1.5 + pow(ca, 24.0)*0.18;
    col += vec3(1.0,0.7,0.35) * glow * u_exposureGlow;
  }

  fragColor = vec4(col, 1.0);
}
`;
