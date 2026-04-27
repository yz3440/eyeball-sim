const VERT = `
attribute vec2 a_pos;
uniform vec2 u_resolution;
uniform vec2 u_center;
uniform float u_radius;
varying vec2 v_uv;
void main() {
  v_uv = a_pos;
  vec2 pix = u_center + a_pos * u_radius;
  vec2 clip = (pix / u_resolution) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const FRAG = `
precision mediump float;
varying vec2 v_uv;

uniform float u_alpha;
uniform vec3 u_lightDir;

void main() {
  float r2 = dot(v_uv, v_uv);
  if (r2 > 1.0) discard;

  float edgeAA = 1.0 - smoothstep(0.985, 1.0, r2);

  vec3 n = vec3(v_uv, sqrt(max(0.0, 1.0 - r2)));
  vec3 L = normalize(u_lightDir);
  vec3 V = vec3(0.0, 0.0, 1.0);

  // very dark base, lifted slightly where light hits
  float lambert = max(dot(n, L), 0.0);
  vec3 col = vec3(0.02) + vec3(0.05) * lambert;

  // primary specular — bright tight highlight (the "wet glint")
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(n, H), 0.0), 90.0);
  col += vec3(spec * 0.95);

  // secondary tiny highlight, opposite side, sells the glossy sphere
  vec3 H2 = normalize(vec3(-0.5, -0.7, 1.0));
  float spec2 = pow(max(dot(n, H2), 0.0), 220.0);
  col += vec3(spec2 * 0.55);

  // soft rim light along the silhouette (glossy edge)
  float rim = pow(1.0 - n.z, 4.0);
  col += vec3(0.07) * rim;

  gl_FragColor = vec4(col, u_alpha * edgeAA);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGLRenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program link failed: ${log}`);
  }
  return p;
}

export interface DrawEyeOptions {
  cx: number;
  cy: number;
  radius: number;
  alpha: number;
}

export class GLEyeRenderer {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private quad: WebGLBuffer;
  private loc: {
    a_pos: number;
    u_resolution: WebGLUniformLocation;
    u_center: WebGLUniformLocation;
    u_radius: WebGLUniformLocation;
    u_alpha: WebGLUniformLocation;
    u_lightDir: WebGLUniformLocation;
  };

  lightDir: [number, number, number] = [-0.45, -0.6, 0.7];

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
    });
    if (!gl) throw new Error("WebGL not available");
    this.gl = gl;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    this.prog = link(gl, vs, fs);

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    const u = (n: string) => gl.getUniformLocation(this.prog, n)!;
    this.loc = {
      a_pos: gl.getAttribLocation(this.prog, "a_pos"),
      u_resolution: u("u_resolution"),
      u_center: u("u_center"),
      u_radius: u("u_radius"),
      u_alpha: u("u_alpha"),
      u_lightDir: u("u_lightDir"),
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(w: number, h: number) {
    const c = this.gl.canvas as HTMLCanvasElement;
    c.width = w;
    c.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  beginFrame() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.loc.a_pos);
    gl.vertexAttribPointer(this.loc.a_pos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(this.loc.u_resolution, gl.canvas.width, gl.canvas.height);
    gl.uniform3fv(this.loc.u_lightDir, this.lightDir);
  }

  drawEye(opts: DrawEyeOptions) {
    if (opts.alpha <= 0.01 || opts.radius <= 0) return;
    const gl = this.gl;
    gl.uniform2f(this.loc.u_center, opts.cx, opts.cy);
    gl.uniform1f(this.loc.u_radius, opts.radius);
    gl.uniform1f(this.loc.u_alpha, opts.alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
