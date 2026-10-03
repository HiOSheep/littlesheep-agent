// Live renderer for the void ring: the mark itself, re-lit every frame by a fragment shader.
//
// The black disc stays put; only its corona moves. With every motion term at rest the shader
// samples the mark unchanged, so the live canvas and the still PNG are the same picture.
//
// Browsers cap WebGL contexts (~16), and a transcript can show many rings at once, so all rings
// share one hidden GL canvas: each frame a ring is drawn there at its own pixel size and copied into
// that ring's 2D canvas.

import { DISC, type VoidRingFrame } from './void-ring-motion'

const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAGMENT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_mark;
uniform vec3 u_disc;
uniform float u_time, u_rot, u_breath, u_flow, u_energy, u_flare, u_wave, u_orbit, u_orbitAngle, u_think, u_grain, u_px;
uniform vec2 u_focus;

const float TAU = 6.2831853;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Periodic in the angle so the seam at +-pi never shows.
float ringNoise(float a, float r, float t) {
  vec2 q = vec2(cos(a), sin(a)) * 2.2 + vec2(r * 7.0 - t * 0.35, t * 0.21);
  return noise(q) + 0.5 * noise(q * 2.1 + 3.7) - 0.75;
}
vec4 mark(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(u_mark, uv);
}
// The corona's palette by angle, as the mark paints it: blue over the top and left, violet where the
// two meet, peach-orange low on the right. Procedural rather than sampled, because the mark is
// nearly transparent on its shadow side and sampling there yields grey.
vec3 hue(float ang) {
  float warm = smoothstep(-0.15, 0.85, cos(ang - u_rot - 0.55));
  vec3 cool = vec3(0.33, 0.45, 1.0);
  vec3 violet = vec3(0.68, 0.5, 1.0);
  vec3 peach = vec3(1.0, 0.62, 0.42);
  return warm < 0.5 ? mix(cool, violet, warm * 2.0) : mix(violet, peach, warm * 2.0 - 1.0);
}
float luma(vec3 v) { return dot(v, vec3(0.3, 0.5, 0.2)); }

void main() {
  vec2 c = u_disc.xy;
  float R = u_disc.z;
  vec2 p = v_uv - c;
  float r = length(p);
  float a = atan(p.y, p.x);
  float outside = smoothstep(R - u_px, R + u_px, r);

  // Corona: breathe outward from the rim, drift, and shimmer. Inside the disc nothing moves.
  float d = max(r - R, 0.0);
  float sr = R + d / (1.0 + u_breath * 2.4);
  float sa = a - u_rot + u_flow * 0.09 * ringNoise(a, d, u_time) * smoothstep(0.0, 0.08, d);
  vec4 col = mix(mark(v_uv), mark(c + sr * vec2(cos(sa), sin(sa))), outside);

  vec2 dir = p / max(r, 1e-4);
  float rim = exp(-pow((r - R) / 0.012, 2.0));
  float halo = outside * exp(-d / 0.09);
  float facing = max(dot(dir, u_focus), 0.0);
  vec3 glow = vec3(0.0);
  float glowA = 0.0;

  // Swell and attention strengthen the corona, the side facing the pointer most of all.
  float lift = u_energy + u_flare * 0.9 + facing * 0.55;
  col *= 1.0 + outside * max(lift, -0.5) * (0.6 + 0.6 * halo);
  float edge = rim * (0.35 * u_flare + 0.6 * facing);
  glow += hue(a) * edge;
  glowA += edge * 0.6;

  // Loading: a comet running the rim with a long tapering tail; the head is a soft bead, not a star.
  if (u_orbit > 0.001) {
    float behind = mod(u_orbitAngle - a, TAU);
    float tail = exp(-behind * 1.5) * smoothstep(0.0, 0.3, behind) * (1.0 - smoothstep(TAU - 0.5, TAU, behind));
    float head = exp(-pow(min(behind, TAU - behind) / 0.12, 2.0));
    float band = exp(-pow((r - R - 0.006) / (0.011 + 0.016 * smoothstep(0.0, 1.5, behind)), 2.0));
    float spark = (tail * 1.1 + head * 0.9) * band * u_orbit;
    glow += mix(hue(a), vec3(1.0), 0.45 * head) * spark;
    glowA += spark * 0.9;
  }

  // Thinking: filaments crawl both ways round the rim, so the light seems to be turning something over.
  if (u_think > 0.001) {
    float f = max(ringNoise(a, 0.0, u_time * 2.6), ringNoise(a + 1.7, 0.03, -u_time * 1.9));
    float fil = smoothstep(0.0, 0.4, f) * exp(-pow((r - R - 0.012) / 0.028, 2.0)) * outside * u_think;
    glow += hue(a) * fil * 1.3;
    glowA += fil * 0.75;
  }

  // Greeting: a ring of light leaves the rim and fades as it travels.
  if (u_wave >= 0.0) {
    float w = 1.0 - pow(1.0 - u_wave, 3.0);
    float ring = exp(-pow((r - R - w * 0.2) / (0.006 + 0.02 * w), 2.0)) * (1.0 - u_wave) * outside;
    glow += hue(a) * ring * 1.3;
    glowA += ring * 0.6;
  }

  float grain = (hash(v_uv * 913.0 + fract(u_time) * 17.0) - 0.5) * u_grain * 0.06 * halo;
  col.a = clamp(col.a + max(glowA, luma(glow) * 0.5), 0.0, 1.0);
  col.rgb = min(col.rgb + glow + grain * col.a, vec3(col.a));
  gl_FragColor = col;
}`

const UNIFORMS = ['u_mark', 'u_disc', 'u_time', 'u_rot', 'u_breath', 'u_flow', 'u_energy', 'u_flare', 'u_wave', 'u_orbit', 'u_orbitAngle', 'u_think', 'u_grain', 'u_px', 'u_focus'] as const

interface Shared {
  canvas: HTMLCanvasElement
  gl: WebGLRenderingContext
  uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>
}

let shared: Shared | null | undefined
let markImage: HTMLImageElement | null = null
let markUploaded = false
let markLoading: Promise<boolean> | null = null

function createShared(): Shared | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true })
  if (!gl) return null
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'void ring shader')
    return shader
  }
  try {
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'void ring program')
    gl.useProgram(program)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    const uniforms = Object.fromEntries(UNIFORMS.map(name => [name, gl.getUniformLocation(program, name)])) as Shared['uniforms']
    gl.uniform1i(uniforms.u_mark, 0)
    gl.uniform3f(uniforms.u_disc, DISC.x, DISC.y, DISC.r)
    gl.clearColor(0, 0, 0, 0)
    canvas.addEventListener('webglcontextlost', () => { shared = undefined; markUploaded = false })
    return { canvas, gl, uniforms }
  } catch (error) {
    console.warn('[void-ring] live renderer unavailable, keeping the still mark', error)
    return null
  }
}

function getShared(): Shared | null {
  if (shared === undefined) shared = createShared()
  return shared
}

/** Loads the mark into the shared texture; resolves to whether live rendering is possible. */
export function prepareVoidRingRenderer(markUrl: string): Promise<boolean> {
  if (markUploaded && shared) return Promise.resolve(true)
  if (markLoading) return markLoading
  markLoading = (async () => {
    const context = getShared()
    if (!context) return false
    if (!markImage) {
      const image = new Image()
      image.src = markUrl
      await image.decode()
      markImage = image
    }
    const { gl } = context
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, markImage)
    gl.generateMipmap(gl.TEXTURE_2D)
    markUploaded = true
    return true
  })().catch(() => false).finally(() => { markLoading = null })
  return markLoading
}

export function isVoidRingRendererReady(): boolean {
  return markUploaded && !!shared
}

/** Draws one frame of the ring into `target` (a 2D canvas already sized in device pixels). */
export function renderVoidRing(target: CanvasRenderingContext2D, frame: VoidRingFrame): boolean {
  const context = getShared()
  if (!context || !markUploaded) return false
  const { canvas, gl, uniforms: u } = context
  const width = target.canvas.width
  const height = target.canvas.height
  if (canvas.width < width || canvas.height < height) {
    canvas.width = Math.max(canvas.width, width)
    canvas.height = Math.max(canvas.height, height)
  }
  gl.viewport(0, canvas.height - height, width, height)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.uniform1f(u.u_time, frame.time)
  gl.uniform1f(u.u_rot, frame.rot)
  gl.uniform1f(u.u_breath, frame.breath)
  gl.uniform1f(u.u_flow, frame.flow)
  gl.uniform1f(u.u_energy, frame.energy)
  gl.uniform1f(u.u_flare, frame.flare)
  gl.uniform1f(u.u_wave, frame.wave)
  gl.uniform1f(u.u_orbit, frame.orbit)
  gl.uniform1f(u.u_orbitAngle, frame.orbitAngle)
  gl.uniform1f(u.u_think, frame.think)
  gl.uniform1f(u.u_grain, frame.grain)
  gl.uniform1f(u.u_px, 1.2 / width)
  gl.uniform2f(u.u_focus, frame.focusX, frame.focusY)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  target.clearRect(0, 0, width, height)
  target.drawImage(canvas, 0, 0, width, height, 0, 0, width, height)
  return true
}

type Tick = (dt: number) => void
const ticks = new Set<Tick>()
let frameRequest = 0
let lastTime = 0

function loop(now: number) {
  const dt = lastTime ? (now - lastTime) / 1000 : 1 / 60
  lastTime = now
  for (const tick of [...ticks]) tick(dt)
  frameRequest = ticks.size ? requestAnimationFrame(loop) : 0
  if (!frameRequest) lastTime = 0
}

/** Every live ring shares one animation frame; returns the unsubscribe. */
export function onVoidRingFrame(tick: Tick): () => void {
  ticks.add(tick)
  if (!frameRequest) frameRequest = requestAnimationFrame(loop)
  return () => { ticks.delete(tick) }
}
