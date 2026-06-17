// Nebula shader: a volumetric emission nebula raymarched in 3D. Turbulent gas
// clouds glow in H-alpha reds, O-III teals and dusty golds, lit from within by
// a handful of embedded young stars whose light scatters into the surrounding
// gas. Dust absorbs along the view ray. Uses the engine's camera uniforms.

export const nebulaFrag = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_time;
uniform vec3  u_camPos;
uniform mat3  u_camMat;
uniform float u_fov;
uniform float u_density;
uniform float u_brightness;
uniform float u_starBrightness;

const float BOUND = 13.0;

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
float fbm(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<6;i++){ v+=a*noise3(p); p=p*2.02+1.7; a*=0.5; } return v; }

// embedded illuminating stars
const int NSTARS = 4;
vec3 starPos(int i){
  if(i==0) return vec3( 2.5, 1.0,-1.5);
  if(i==1) return vec3(-3.0,-1.5, 2.0);
  if(i==2) return vec3( 0.5, 2.5, 3.0);
  return vec3(-1.5, 0.5,-3.5);
}
vec3 starCol(int i){
  if(i==0) return vec3(1.0,0.85,0.7);
  if(i==1) return vec3(0.7,0.85,1.0);
  if(i==2) return vec3(1.0,0.7,0.85);
  return vec3(0.85,0.9,1.0);
}

float density(vec3 p, out vec3 emit){
  vec3 q = p*0.42 + vec3(0.0,0.0,u_time*0.02);
  float n = fbm(q);
  float shape = smoothstep(BOUND, 4.0, length(p));     // denser toward centre
  float d = smoothstep(0.46, 0.80, n) * shape;

  // colour: two noise fields pick between H-alpha red, O-III teal, dusty gold
  float h1 = fbm(p*0.30 + 11.0);
  float h2 = fbm(p*0.55 + 5.0);
  vec3 red  = vec3(0.85,0.18,0.32);
  vec3 teal = vec3(0.12,0.55,0.62);
  vec3 gold = vec3(0.70,0.45,0.22);
  vec3 c = mix(red, teal, smoothstep(0.35,0.65,h1));
  c = mix(c, gold, smoothstep(0.55,0.85,h2)*0.6);
  emit = c;
  return d * u_density;
}

vec3 background(vec3 dir){
  vec3 col=vec3(0.0);
  for(int layer=0; layer<2; layer++){
    float scale=300.0+float(layer)*480.0;
    vec3 id=floor(dir*scale);
    vec3 rnd=hash33(id+float(layer)*19.0);
    if(rnd.x>0.95){
      vec3 sp=normalize(id+0.5+(rnd-0.5)*0.6);
      col += mix(vec3(1.0,0.9,0.8),vec3(0.8,0.85,1.0),rnd.z)*pow(max(0.0,dot(dir,sp)),11000.0);
    }
  }
  return col;
}

void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*u_resolution)/u_resolution.y;
  vec3 ro=u_camPos;
  vec3 rd=normalize(u_camMat*vec3(uv*u_fov,1.0));

  vec3 col=background(rd);
  float transmit=1.0;

  float b=dot(ro,rd), c=dot(ro,ro)-BOUND*BOUND, disc=b*b-c;
  if(disc>0.0){
    float sq=sqrt(disc);
    float t0=max(-b-sq,0.0), t1=-b+sq;
    const int N=80;
    float dt=(t1-t0)/float(N);
    float jit=hash13(vec3(gl_FragCoord.xy,u_time));
    float t=t0+dt*jit;
    for(int i=0;i<N;i++){
      if(transmit<0.02) break;
      vec3 p=ro+rd*t;
      vec3 emit;
      float d=density(p, emit);
      if(d>0.001){
        // light from embedded stars scatters into the gas
        vec3 lit=vec3(0.0);
        for(int s=0;s<NSTARS;s++){
          vec3 sp=starPos(s);
          float dist=length(p-sp);
          lit += starCol(s) * (1.5/(1.0+dist*dist*1.2));
        }
        vec3 e = emit * (0.25 + lit);
        float a = 1.0 - exp(-d*dt*2.2);
        col += e * d * dt * 2.4 * transmit * u_brightness;
        transmit *= 1.0 - a*0.6;
      }
      t+=dt;
    }

    // embedded star cores (bright points)
    for(int s=0;s<NSTARS;s++){
      vec3 sp=starPos(s);
      vec3 oc=ro-sp;
      float tb=-dot(oc,rd);
      if(tb>0.0){
        float dd=length(oc+rd*tb);
        col += starCol(s) * pow(max(0.0,1.0-dd/0.5),8.0) * 3.0 * u_starBrightness * transmit;
      }
    }
  }

  fragColor=vec4(col,1.0);
}
`;
