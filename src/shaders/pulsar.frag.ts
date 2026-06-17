// Pulsar shader: a rapidly-spinning neutron star firing two relativistic
// "lighthouse" beams along its magnetic axis (tilted from the spin axis, so
// the beams sweep and the whole scene pulses as a beam crosses your view).
// Volumetric beams are raymarched additively; the star surface glows hottest at
// its magnetic poles. Uses the engine's camera uniforms. Output is linear HDR.

export const pulsarFrag = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_time;
uniform vec3  u_camPos;
uniform mat3  u_camMat;
uniform float u_fov;
uniform float u_beamIntensity;
uniform float u_spinRate;
uniform float u_tilt;        // magnetic-axis tilt (radians)
uniform float u_starGlow;

const float STAR_R = 0.6;

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
float fbm(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<5;i++){ v+=a*noise3(p); p=p*2.04+1.3; a*=0.5; } return v; }
vec3 rotY(vec3 p,float a){ float c=cos(a),s=sin(a); return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z); }

float iSphere(vec3 ro, vec3 rd, float ra){
  float b=dot(ro,rd), c=dot(ro,ro)-ra*ra, h=b*b-c;
  if(h<0.0) return -1.0; h=sqrt(h);
  float t=-b-h; return t>0.0?t:(-b+h>0.0?-b+h:-1.0);
}

vec3 starfield(vec3 dir){
  vec3 col=vec3(0.0);
  for(int layer=0; layer<2; layer++){
    float scale=320.0+float(layer)*520.0;
    vec3 id=floor(dir*scale);
    vec3 rnd=hash33(id+float(layer)*21.0);
    if(rnd.x>0.95){
      vec3 sp=normalize(id+0.5+(rnd-0.5)*0.6);
      float d=max(0.0,dot(dir,sp));
      col += mix(vec3(1.0,0.9,0.8),vec3(0.8,0.85,1.0),rnd.z)*pow(d,11000.0);
    }
  }
  return col;
}

void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*u_resolution)/u_resolution.y;
  vec3 ro=u_camPos;
  vec3 rd=normalize(u_camMat*vec3(uv*u_fov,1.0));

  // magnetic axis, tilted from spin (y) axis and spinning
  float spin=u_time*u_spinRate;
  vec3 mag=normalize(vec3(sin(u_tilt)*cos(spin), cos(u_tilt), sin(u_tilt)*sin(spin)));

  vec3 col=starfield(rd);
  float depth=1e9;

  // neutron star
  float ts=iSphere(ro,rd,STAR_R);
  if(ts>0.0){
    depth=ts;
    vec3 p=ro+rd*ts; vec3 n=normalize(p);
    float pole=max(dot(n,mag),dot(n,-mag));
    float surf=fbm(rotY(n,u_time*0.8)*9.0);
    vec3 sc=mix(vec3(0.55,0.72,1.0), vec3(1.0,1.0,1.0), pole*pole);
    sc += vec3(0.3,0.5,1.0)*surf*0.35;
    col = sc * (1.6 + 6.0*pow(pole,4.0)) * u_starGlow;
  }

  // volumetric lighthouse beams (additive), occluded by the star
  float bb=dot(ro,rd), cc=dot(ro,ro)-625.0, disc=bb*bb-cc;
  if(disc>0.0){
    float sq=sqrt(disc);
    float t0=max(-bb-sq,0.0);
    float t1=min(-bb+sq, depth);
    const int N=64;
    float dt=(t1-t0)/float(N);
    float jit=hash13(vec3(gl_FragCoord.xy,u_time));
    float t=t0+dt*jit;
    vec3 acc=vec3(0.0);
    for(int i=0;i<N;i++){
      if(float(i)>=float(N)) break;
      vec3 p=ro+rd*t;
      float r=length(p)+1e-3;
      vec3 d=p/r;
      float c1=max(dot(d,mag),0.0), c2=max(dot(d,-mag),0.0);
      float cone=pow(c1,70.0)+pow(c2,70.0);
      float fall=exp(-r*0.16);
      float tw=0.55+0.7*fbm(d*5.0 + r*0.4 - vec3(0.0,0.0,u_time*1.5));
      acc += cone*fall*tw * vec3(0.45,0.65,1.0);
      t+=dt;
    }
    col += acc*dt*u_beamIntensity*7.0;
  }

  // tight corona around the star
  float ca=max(dot(rd, normalize(-ro)),0.0);
  col += vec3(0.5,0.7,1.0)*pow(ca,400.0)*1.2*u_starGlow;

  fragColor=vec4(col,1.0);
}
`;
