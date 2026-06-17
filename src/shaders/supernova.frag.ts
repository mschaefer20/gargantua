// Supernova shader: a looping stellar explosion. A blinding core flash launches
// an expanding, decelerating shockwave shell of turbulent filaments that cools
// from blue-white through orange to red as it grows, then fades and re-ignites.
// Volumetrically raymarched. Uses the engine's camera uniforms. Linear HDR out.

export const supernovaFrag = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_time;
uniform vec3  u_camPos;
uniform mat3  u_camMat;
uniform float u_fov;
uniform float u_period;      // seconds per explosion cycle
uniform float u_intensity;

const float MAXR = 9.0;

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
float fbm(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<5;i++){ v+=a*noise3(p); p=p*2.03+1.1; a*=0.5; } return v; }
float ridge(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*abs(noise3(p)*2.0-1.0); p=p*2.05+1.0; a*=0.5; } return v; }

vec3 starfield(vec3 dir){
  vec3 col=vec3(0.0);
  vec3 id=floor(dir*360.0);
  vec3 rnd=hash33(id);
  if(rnd.x>0.96){
    vec3 sp=normalize(id+0.5);
    col += mix(vec3(1.0,0.9,0.8),vec3(0.8,0.85,1.0),rnd.z)*pow(max(0.0,dot(dir,sp)),11000.0);
  }
  return col;
}

// temperature gradient: hot (1) -> cool (0)
vec3 fire(float t){
  vec3 white=vec3(1.0,0.98,0.92);
  vec3 blue =vec3(0.7,0.82,1.0);
  vec3 orange=vec3(1.0,0.5,0.15);
  vec3 red  =vec3(0.7,0.10,0.06);
  vec3 c = mix(red, orange, smoothstep(0.0,0.4,t));
  c = mix(c, white, smoothstep(0.4,0.8,t));
  c = mix(c, blue, smoothstep(0.85,1.0,t)*0.6);
  return c;
}

void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*u_resolution)/u_resolution.y;
  vec3 ro=u_camPos;
  vec3 rd=normalize(u_camMat*vec3(uv*u_fov,1.0));

  float phase = fract(u_time / u_period);          // 0..1 within a cycle
  float radius = pow(phase, 0.6) * MAXR;            // decelerating expansion
  float width = 0.5 + phase*3.0;
  float ageT = 1.0 - phase;                         // shell cools as it grows
  float fade = smoothstep(1.0, 0.7, phase);         // dim at the very end

  vec3 col = starfield(rd) * (0.5 + 0.5*fade);
  float transmit = 1.0;

  float b=dot(ro,rd), c=dot(ro,ro)-(MAXR+2.0)*(MAXR+2.0), disc=b*b-c;
  if(disc>0.0){
    float sq=sqrt(disc);
    float t0=max(-b-sq,0.0), t1=-b+sq;
    const int N=72;
    float dt=(t1-t0)/float(N);
    float jit=hash13(vec3(gl_FragCoord.xy,u_time));
    float t=t0+dt*jit;
    for(int i=0;i<N;i++){
      if(transmit<0.02) break;
      vec3 p=ro+rd*t;
      float r=length(p)+1e-3;
      vec3 d=p/r;
      // expanding turbulent shell
      float turb = fbm(d*4.0 + phase*1.5);
      float fil  = pow(ridge(d*6.0 + 3.0), 2.0);
      float shell = exp(-pow(r-radius,2.0)/(width*width)) * (0.35 + 1.3*turb) * (0.5 + fil);
      // inner is hotter than the leading edge
      float localT = clamp(ageT*0.5 + (1.0 - r/max(radius,0.001))*0.6, 0.0, 1.0);
      vec3 e = fire(localT) * shell;
      float dens = shell;
      col += e * dt * 2.6 * transmit * u_intensity * fade;
      transmit *= 1.0 - clamp(dens*dt*0.6, 0.0, 0.9);
      t+=dt;
    }
  }

  // blinding core flash early in the cycle
  float coreCA = max(dot(rd, normalize(-ro)), 0.0);
  float flash = exp(-phase*7.0);
  col += fire(1.0) * pow(coreCA, 60.0) * flash * 12.0 * u_intensity;
  col += vec3(1.0,0.85,0.6) * pow(coreCA, 800.0) * (0.4+flash) * u_intensity;

  fragColor=vec4(col,1.0);
}
`;
