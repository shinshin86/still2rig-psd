import { createMouthController, mouthContour, mouthRestWeight, type MouthContour, type MouthFrame, type MouthSelection } from './mouthExpression.mjs';
import { expressionParameterNames } from '../../../src/expressionPresets.mjs';
import { drawnEyeFeatures, morphDrawnEye, drawnBlinkOpacity, type DrawnEyeFeatures } from './drawnEye.mjs';
import { createEyeDrawingSlot, eyeDrawingAlpha, eyeSlotParameters, type EyeDrawing, type EyeDrawingFrame, type EyeDrawingSnapshot } from './eyeDrawing.mjs';
import { composeTrackedExpression, morphClosedWink, shapeBrow, shapeUpperLid, shapeWink, smileForSide, upperLidShape } from './expressionParts.mjs';
/*!
 * Based on Anime2.5DRig (https://github.com/852wa/Anime2.5DRig)
 * by 852wa (hakoniwa), MIT License.
 */
import type { TrackingInput } from '../tracking/pose.mjs';
import type { Anime25RigLayer, Anime25RigResult } from './anime25Rig';
import { morphSmile, raiseLowerLid, resolveEyeExpression, smileInkVisibility, upperLidY } from './eyeExpression.mjs';
import {
  createPsdMotionProfileRuntime,
  DEFAULT_PSD_MOTION_PARAMETERS,
  type PsdMotionParameters,
  type PsdMotionProfile,
} from '../psdMotionProfile';

interface Point {
  cx: number;
  cy: number;
}

interface BoxAnchor extends Point {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface EyeAnchor {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  icx: number;
  icy: number;
  closeY: number;
  closedBounds?: { x0: number; x1: number; y0: number; y1: number } | null;
  closedCurve?: { x: number; y: number }[] | null;
  smileY?: number;
  browCurve?: { x: number; y: number }[];
  browBounds?: { x0: number; x1: number; y0: number; y1: number } | null;
  smileInkBounds?: { x0: number; x1: number; y0: number; y1: number };
  creaseCurve?: { x: number; y: number }[];
  upperLid?: { x: number; y: number }[];
  smileLid?: { x: number; y: number }[];
}

interface RigAnchors {
  face: BoxAnchor;
  eyeL?: EyeAnchor;
  eyeR?: EyeAnchor;
  mouth: BoxAnchor & { closedHeight?: number };
  neckPivot: Point;
  neckTop: number;
  neckBottom: number;
  bodyPivot: Point;
  faceScale: number;
}

interface SpringAxis {
  x: number;
  v: number;
  dx: number;
}

interface StrandSpring {
  stiff: SpringAxis;
  soft: SpringAxis;
  phase: number;
}

interface RenderLayer extends Anime25RigLayer {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  depth: number;
  group: string;
  img: {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };
  base: Float32Array;
  cur: Float32Array;
  uv: Float32Array;
  indices: Uint16Array;
  bn: string;
  nIdx: number;
  tex: WebGLTexture;
  vboPos: WebGLBuffer;
  vboUV: WebGLBuffer;
  vboInk: WebGLBuffer;
  vboShade: WebGLBuffer;
  lidShade: Float32Array;
  inkVisibility: Float32Array;
  ibo: WebGLBuffer;
  sw?: Float32Array;
  su?: Float32Array;
  spr?: StrandSpring[];
  bw?: Float32Array;
}

interface MotionParams extends PsdMotionParameters {
  breath: number;
  breathHead: number;
}

interface AnimationState {
  eyeSlots?: Record<'L'|'R', EyeDrawingSnapshot>;
  eyeDrawings?: Record<'L' | 'R', EyeDrawing>;
  mouthSelection?: MouthSelection;
  current: MotionParams; blinkT: number; nextBlink: number; nextRandom: number;
  randomTarget: { ax: number; ay: number; az: number; bd: number; ex: number; ey: number };
  bounce: { x: number; v: number; dy: number };
  springs: Map<string, StrandSpring[]>;
}

export interface Anime25RigAvatar {
  setEyeExpressionTarget: (values: Partial<PsdMotionParameters> | null) => void;
  getDrawingState: () => { eyes: Record<'L'|'R', EyeDrawingFrame & { drawing: EyeDrawing; open: number }>; layers: { name: string; side: string; drawing: string; alpha: number }[] };
  setVoiceMouth: (value: number | null) => void;
  getMouthState: () => MouthFrame & { visibleDrawings: number };
  setTrackingInput: (input: Partial<TrackingInput> | null, weight: number) => void;
  setMouthOpen: (value: number) => void;
  setEyeOpen: (value: number | null) => void;
  setIntensity: (value: number) => void;
  setMotionTuning: (value: Partial<Anime25MotionTuning>) => void;
  getMotionTuning: () => Anime25MotionTuning;
  setViewTransform: (offsetX: number, offsetY: number, scale: number) => void;
  setDragMotion: (velocityX: number, velocityY: number, active: boolean) => void;
  resetDragMotion: () => void;
  getDragMotion: () => { x: number; y: number };
  setMotionEnabled: (value: boolean) => void;
  setMotionProfile: (profile: PsdMotionProfile) => void;
  getEyeOpen: () => { left: number; right: number };
  getAverageFps: () => number;
  setLayerFocus: (name: string | null) => void;
  getLayerFocus: () => string | null;
  pickLayersAt: (canvasX: number, canvasY: number) => string[];
  getAnimationState: () => AnimationState;
  setAnimationState: (state: AnimationState) => void;
  dispose: () => void;
}

export interface Anime25MotionTuning {
  idleScale: number;
  breathScale: number;
  hairWindScale: number;
  hairAmplitudeScale: number;
  hairSoftnessScale: number;
  dragScale: number;
}

export const DEFAULT_ANIME25_MOTION_TUNING: Readonly<Anime25MotionTuning> = {
  idleScale: 1,
  breathScale: 1,
  hairWindScale: 1,
  hairAmplitudeScale: 1,
  hairSoftnessScale: 1,
  dragScale: 1,
};

const DEFAULT_PARAMS: MotionParams = {
  ...DEFAULT_PSD_MOTION_PARAMETERS,
  breath: 0,
  breathHead: 0,
};

const IDLE_SWAY_SCALE = 2.8;
const BREATH_SCALE = 3.2;
const HAIR_WIND_SCALE = 3.0;
const HAIR_PHYSICS_SCALE = 1.8;

const VERTEX_SHADER =
  'attribute vec2 aPos; attribute vec2 aUV; attribute float aInk; attribute float aShade; varying float vShade; varying float vInk; uniform vec2 uRes; uniform vec2 uViewOffset; uniform float uViewScale; varying vec2 vUV;' +
  'void main(){ vUV=aUV; vInk=aInk; vShade=aShade; vec2 p=(aPos-uRes*0.5)*uViewScale+uRes*0.5+uViewOffset; vec2 c=p/uRes*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.0,1.0); }';

const FRAGMENT_SHADER =
  'precision mediump float; varying vec2 vUV; varying float vInk; varying float vShade; uniform sampler2D uTex; uniform float uCut; uniform float uAlpha; uniform vec4 uMouthShade; uniform vec2 uResolveTexel; uniform sampler2D uEyeMask; uniform float uUseEyeMask; uniform vec2 uEyeMaskTexel; uniform vec2 uMaskResolution; uniform vec4 uLashTrim;' +
  'void main(){ vec4 c=texture2D(uTex,vUV); if(uResolveTexel.x>0.0){c=vec4(0.0);for(int y=-1;y<=1;y++){for(int x=-1;x<=1;x++){c+=texture2D(uTex,vUV+vec2(float(x),float(y))*uResolveTexel);}}c/=9.0;} if(c.a*uAlpha*vInk<uCut) discard; float cavity=smoothstep(0.35,0.7,c.r/max(c.a,0.001)); float pale=smoothstep(0.68,0.75,min(c.r,min(c.g,c.b))/max(c.a,0.001)); c.rgb=mix(c.rgb,uMouthShade.rgb*(1.0-0.18*cavity)*c.a,uMouthShade.a*(1.0-pale)); if(uUseEyeMask>0.5){float coverage=0.0;for(int my=-1;my<=1;my++){for(int mx=-1;mx<=1;mx++){coverage+=texture2D(uEyeMask,gl_FragCoord.xy/uMaskResolution+vec2(float(mx),float(my))*uEyeMaskTexel).a;}}c*=coverage/9.0;} if(uLashTrim.x>0.0){float outer=(vUV.x-uLashTrim.y)/uLashTrim.z*uLashTrim.w;c*=1.0-smoothstep(0.45,0.75,outer)*uLashTrim.x*(1.0-smoothstep(0.0,1.0,vShade));}else{c.rgb*=1.0-vShade;} gl_FragColor=c*(uAlpha*vInk); }';

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function smooth(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export function composePsdMotionMouthOpen(
  baseline: number,
  ttsInput: number,
): number {
  return Math.max(clamp(baseline, 0, 1), clamp(ttsInput, 0, 1));
}

export function resolveBasePsdMotionParameters(
  profile: PsdMotionProfile,
  ttsInput: number,
  motionEnabled: boolean,
): PsdMotionParameters {
  if (!motionEnabled) {
    const values = { ...DEFAULT_PSD_MOTION_PARAMETERS };
    for (const name of expressionParameterNames) {
      const key = name as keyof PsdMotionParameters;
      values[key] = profile.parameters[key];
    }
    return values;
  }
  return {
    ...profile.parameters,
    mouthOpen: composePsdMotionMouthOpen(
      profile.parameters.mouthOpen,
      ttsInput,
    ),
  };
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create WebGL shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'WebGL shader error.');
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create WebGL program.');
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(
    program,
    compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'WebGL link error.');
  }
  return program;
}

function createBuffer(gl: WebGLRenderingContext): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('Failed to create WebGL buffer.');
  return buffer;
}

function createTexture(
  gl: WebGLRenderingContext,
  imageData: ImageData,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create WebGL texture.');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    imageData,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function getAttribLocation(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
): number {
  const location = gl.getAttribLocation(program, name);
  if (location < 0) throw new Error(`Missing WebGL attribute: ${name}`);
  return location;
}

function getUniformLocation(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`Missing WebGL uniform: ${name}`);
  return location;
}

function hasRenderableGeometry(layer: Anime25RigLayer): layer is RenderLayer {
  return (
    typeof layer.x === 'number' &&
    typeof layer.y === 'number' &&
    typeof layer.w === 'number' &&
    typeof layer.h === 'number' &&
    typeof layer.z === 'number' &&
    typeof layer.depth === 'number' &&
    Boolean(layer.img)
  );
}

function baseRigName(name: string): string {
  return name.replace(/_(l|r)$/i, '').replace(/_\d+$/, '');
}

function getAnchors(rig: Anime25RigResult): RigAnchors {
  return rig.anchors as unknown as RigAnchors;
}

function fadeAlpha(
  layer: RenderLayer,
  params: MotionParams,
  hasEyeClose: Record<'L' | 'R', boolean>,
  hasEyeSmile: Record<'L' | 'R', boolean>,
  mouthDrawing: string,
  hasEyeAngry: Record<'L' | 'R', boolean>,
  eyeDrawings: Record<'L' | 'R', EyeDrawing>,
  eyeFrames: Record<'L'|'R', EyeDrawingFrame>,
): number {
  if (layer.side === 'L' || layer.side === 'R') {
    const drawing = eyeDrawings[layer.side];
    const sideParams = eyeSlotParameters(params, layer.side, drawing, eyeFrames[layer.side]);
    const alpha = eyeDrawingAlpha(layer.fade, layer.bn, drawing,
      drawnBlinkOpacity(layer.side === 'L' ? params.eyeOpenL : params.eyeOpenR),
      baseFadeAlpha(layer, sideParams, hasEyeClose, hasEyeSmile, mouthDrawing, hasEyeAngry));
    return alpha;
  }
  return baseFadeAlpha(layer, params, hasEyeClose, hasEyeSmile, mouthDrawing, hasEyeAngry);
}

function baseFadeAlpha(
  layer: RenderLayer, params: MotionParams,
  hasEyeClose: Record<'L' | 'R', boolean>, hasEyeSmile: Record<'L' | 'R', boolean>,
  mouthDrawing: string, hasEyeAngry: Record<'L' | 'R', boolean>,
): number {
  const requestedWink = layer.side === 'L' ? params.eyeWinkL : params.eyeWinkR;
    const hasSmile = Boolean(layer.side && hasEyeSmile[layer.side as 'L'|'R']);
    const wink = hasSmile ? 0 : requestedWink;
  const expression = resolveEyeExpression(Math.min(layer.side === 'L' ? params.eyeOpenL : params.eyeOpenR, 1 - wink),
    Math.max(smileForSide(params, layer.side), hasSmile ? requestedWink : 0), hasSmile);
  const originalAlpha = 1 - expression.smileAlpha;
  if (!layer.fade) return 1;
  if (layer.fade === 'eyeSmile') return expression.smileAlpha;
  if (layer.fade === 'blush') return params.blush;
  if (layer.fade === 'tears' || layer.fade === 'sweat' || layer.fade === 'angerMark') return params[layer.fade];
  if (layer.fade === 'eyeOpen') {
    const value = expression.eyeOpen;
    if(layer.bn==='eyewhite' && layer.side && !hasEyeSmile[layer.side as 'L'|'R'] && params.eyeNarrow>0) {
      const aperture=value*(1-params.eyeNarrow*.8);
      return originalAlpha*smooth((aperture-.16)/.12)*smooth((value-(.1+params.eyeEase*.45))/.15);
    }
    if (wink > 0 && !expression.smileProgress && layer.side && hasEyeClose[layer.side as 'L'|'R']) return value <= 0.1 ? 0 : 1;
    if (expression.smileProgress > 0 && layer.bn === 'eyelash') return originalAlpha;
    if (
      (layer.side === 'L' || layer.side === 'R') &&
      !hasEyeClose[layer.side] &&
      layer.bn === 'eyelash'
    ) {
      return originalAlpha;
    }
    return originalAlpha * smooth((value - (0.1 + params.eyeEase * 0.45)) / 0.15);
  }
  if (layer.fade === 'eyeClose') {
    if (wink > 0 && !expression.smileProgress) return expression.eyeOpen <= 0.1 ? 1 : 0;
    if (expression.smileProgress > 0) return 0;
    const value = expression.eyeOpen;
    return originalAlpha * (1 - smooth((value - (0.1 + params.eyeEase * 0.45)) / 0.15));
  }
  if (layer.bn.startsWith('mouth_')) return layer.bn === mouthDrawing ? 1 : 0;
  return 1;
}

function createRenderLayer(
  gl: WebGLRenderingContext,
  rigLayer: Anime25RigLayer,
  canvasWidth: number,
  anchors: RigAnchors,
): RenderLayer | null {
  if (!hasRenderableGeometry(rigLayer)) return null;

  const layer = { ...rigLayer } as RenderLayer;
  layer.group = layer.group || 'body';
  layer.bn = baseRigName(layer.name);

  const cell = (layer.phys ? 30 : 42) * Math.max(0.6, canvasWidth / 768);
  const eyeGrid = layer.fade === 'eyeOpen' || layer.fade === 'eyeClose' || layer.fade === 'eyeSmile' || layer.bn === 'eyebrow' || layer.fade === 'tears' ? 40 :
    layer.bn.startsWith('mouth_') ? 40 : 2;
  const nx = Math.max(eyeGrid, Math.round(layer.w / cell));
  const ny = Math.max(eyeGrid, Math.round(layer.h / cell));
  const vertexCount = (nx + 1) * (ny + 1);
  const base = new Float32Array(vertexCount * 2);
  const uv = new Float32Array(vertexCount * 2);
  const lipContour = layer.bn.startsWith('mouth_') ? mouthContour(layer,layer.bn!=='mouth_close') : null;
  let offset = 0;

  for (let j = 0; j <= ny; j += 1) {
    for (let i = 0; i <= nx; i += 1) {
      base[offset] = layer.x + (layer.w * i) / nx;
      base[offset + 1] = layer.y + (layer.h * j) / ny;
      uv[offset] = i / nx;
      uv[offset + 1] = j / ny;
      if (lipContour) {
        const column = (lipContour.top.length-1)*i/nx;
        const lo=Math.floor(column),hi=Math.min(lo+1,lipContour.top.length-1),t=column-lo;
        const top=Math.max(layer.y,lipContour.top[lo]+(lipContour.top[hi]-lipContour.top[lo])*t-1);
        const bottom=Math.min(layer.y+layer.h,lipContour.bottom[lo]+(lipContour.bottom[hi]-lipContour.bottom[lo])*t+1);
        base[offset]=lipContour.left+(lipContour.right-lipContour.left)*i/nx;
        base[offset+1]=top+(bottom-top)*j/ny;
        uv[offset]=(base[offset]-layer.x)/layer.w;
        uv[offset+1]=(base[offset+1]-layer.y)/layer.h;
      }
      offset += 2;
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const typedIndices = new Uint16Array(indices);
  layer.base = base;
  layer.cur = new Float32Array(base);
  layer.inkVisibility = new Float32Array(vertexCount).fill(1);
  layer.lidShade = new Float32Array(vertexCount);
  layer.uv = uv;
  layer.indices = typedIndices;
  layer.nIdx = indices.length;

  if (layer.strands?.length) {
    const strands = layer.strands;
    let spacing = 120;
    if (strands.length > 1) {
      const distances = strands
        .slice(1)
        .map((strand, index) => strand.x - strands[index].x)
        .sort((a, b) => a - b);
      spacing = distances[distances.length >> 1];
    }
    const sigma = spacing * 0.6;
    layer.sw = new Float32Array(vertexCount * strands.length);
    layer.su = new Float32Array(vertexCount);
    layer.spr = strands.map((_, index) => ({
      stiff: { x: 0, v: 0, dx: 0 },
      soft: { x: 0, v: 0, dx: 0 },
      phase: index * 1.37 + layer.z,
    }));

    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const x = base[vertex * 2];
      const y = base[vertex * 2 + 1];
      let total = 0;
      for (let strand = 0; strand < strands.length; strand += 1) {
        const strandDistance = (x - strands[strand].x) / sigma;
        const weight = Math.exp(-(strandDistance ** 2));
        layer.sw[vertex * strands.length + strand] = weight;
        total += weight;
      }

      let rootY = 0;
      let tipY = 0;
      if (total > 1e-6) {
        for (let strand = 0; strand < strands.length; strand += 1) {
          const index = vertex * strands.length + strand;
          layer.sw[index] /= total;
          rootY += layer.sw[index] * strands[strand].rootY;
          tipY += layer.sw[index] * strands[strand].tipY;
        }
      } else {
        layer.sw[vertex * strands.length] = 1;
        rootY = strands[0].rootY;
        tipY = strands[0].tipY;
      }
      layer.su[vertex] = clamp((y - rootY) / Math.max(1, tipY - rootY), 0, 1);
    }

    if (layer.bn === 'front hair') {
      const faceWidth = anchors.face.x1 - anchors.face.x0;
      const faceCenterX = anchors.face.cx;
      const feather = 36;
      const leftBoundary = faceCenterX - faceWidth * 0.22;
      const rightBoundary = faceCenterX + faceWidth * 0.22;
      layer.bw = new Float32Array(vertexCount * 3);
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const x = base[vertex * 2];
        const s1 = smooth((x - leftBoundary) / feather + 0.5);
        const s2 = smooth((x - rightBoundary) / feather + 0.5);
        layer.bw[vertex * 3] = 1 - s1;
        layer.bw[vertex * 3 + 1] = s1 * (1 - s2);
        layer.bw[vertex * 3 + 2] = s2;
      }
    }
  }

  layer.vboPos = createBuffer(gl);
  layer.vboUV = createBuffer(gl);
  layer.vboInk = createBuffer(gl);
  layer.vboShade = createBuffer(gl);
  layer.ibo = createBuffer(gl);

  gl.bindBuffer(gl.ARRAY_BUFFER, layer.vboUV);
  gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, layer.ibo);
  gl.bufferData(
    gl.ELEMENT_ARRAY_BUFFER,
    typedIndices,
    gl.STATIC_DRAW,
  );

  layer.tex = createTexture(
    gl,
    new ImageData(
      new Uint8ClampedArray(layer.img.data),
      layer.img.width,
      layer.img.height,
    ),
  );

  return layer;
}

export function createAnime25RigAvatar(
  canvas: HTMLCanvasElement,
  rig: Anime25RigResult,
): Anime25RigAvatar {
  const context = canvas.getContext('webgl', {
    alpha: true,
    stencil: true,
    antialias: true,
    premultipliedAlpha: true,
  });
  if (!context) throw new Error('WebGL is not available.');
  const gl: WebGLRenderingContext = context;

  const program = createProgram(gl);
  gl.useProgram(program);
  const locPos = getAttribLocation(gl, program, 'aPos');
  const locUV = getAttribLocation(gl, program, 'aUV');
  const locInk = getAttribLocation(gl, program, 'aInk');
  const locShade = getAttribLocation(gl, program, 'aShade');
  const locRes = getUniformLocation(gl, program, 'uRes');
  const locViewOffset = getUniformLocation(gl, program, 'uViewOffset');
  const locViewScale = getUniformLocation(gl, program, 'uViewScale');
  const locCut = getUniformLocation(gl, program, 'uCut');
  const locAlpha = getUniformLocation(gl, program, 'uAlpha');
  const locMouthShade = getUniformLocation(gl, program, 'uMouthShade');
  const locResolveTexel = getUniformLocation(gl, program, 'uResolveTexel');
  const locUseEyeMask=getUniformLocation(gl,program,'uUseEyeMask');
  const locLashTrim=getUniformLocation(gl,program,'uLashTrim');
  const locEyeMaskTexel=getUniformLocation(gl,program,'uEyeMaskTexel');
  gl.uniform1i(getUniformLocation(gl,program,'uEyeMask'),1);
  gl.uniform2f(getUniformLocation(gl,program,'uMaskResolution'),rig.canvas.w,rig.canvas.h);

  gl.enableVertexAttribArray(locPos);
  gl.enableVertexAttribArray(locUV);
  gl.enableVertexAttribArray(locInk);
  gl.enableVertexAttribArray(locShade);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  const anchors = getAnchors(rig);
  const canvasWidth = rig.canvas.w;
  const canvasHeight = rig.canvas.h;
  const faceScale = anchors.faceScale;
  const neckPivot = anchors.neckPivot;
  const bodyPivot = anchors.bodyPivot;
  const faceCenter = { x: anchors.face.cx, y: anchors.face.cy };
  const chest = {
    cx: neckPivot.cx,
    cy: anchors.neckBottom + (anchors.face.y1 - anchors.face.y0) * 0.6,
    rx: (anchors.face.x1 - anchors.face.x0) * 0.6,
    ry: (anchors.face.y1 - anchors.face.y0) * 0.45,
  };
  const layers = rig.layers
    .map((layer) => createRenderLayer(gl, layer, canvasWidth, anchors))
    .filter((layer): layer is RenderLayer => Boolean(layer));
  const mouthContours: Record<string, MouthContour> = {};
  for (const layer of layers) if (layer.bn.startsWith('mouth_')) {
    const contour = mouthContour(layer,true,layer.bn==='mouth_close');
    if (contour) mouthContours[layer.bn] = contour;
  }
  const closedMouth = layers.find(layer=>layer.bn==='mouth_close');
  const mouthInk=[0,0,0];let inkWeight=0;
  if(closedMouth)for(let i=0;i<closedMouth.img.data.length;i+=4) {
    const data=closedMouth.img.data,a=data[i+3];
    if(a<128 || Math.min(data[i],data[i+1],data[i+2])>=160)continue;
    inkWeight+=a;for(let c=0;c<3;c++)mouthInk[c]+=data[i+c]*a;
  }
  for(let c=0;c<3;c++)mouthInk[c]=inkWeight?mouthInk[c]/inkWeight/255:[.3,.18,.12][c];
  const mouthController = createMouthController(mouthContours);
  let mouthFrame = mouthController.resolve(DEFAULT_PSD_MOTION_PARAMETERS);
  // Area-sample only the mouth. Narrow lips must retain fractional edge
  // coverage rather than aliasing a tall mouth texture into a jagged line.
  const sampleScale=Math.min(3,Math.floor(gl.getParameter(gl.MAX_TEXTURE_SIZE)/Math.max(canvasWidth,canvasHeight)));
  const mouthTexture=sampleScale>=2&&Object.keys(mouthContours).length?gl.createTexture():null;
  const mouthFramebuffer=mouthTexture?gl.createFramebuffer():null;
  const mouthQuad=mouthFramebuffer?[createBuffer(gl),createBuffer(gl),createBuffer(gl)]:[];
  if(mouthTexture&&mouthFramebuffer) {
    gl.bindTexture(gl.TEXTURE_2D,mouthTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,canvasWidth*sampleScale,canvasHeight*sampleScale,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER,mouthFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,mouthTexture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('口を表示する準備ができませんでした。ページを開き直してください。');
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    const values=[new Float32Array([0,0,canvasWidth,0,0,canvasHeight,0,canvasHeight,canvasWidth,0,canvasWidth,canvasHeight]),
      new Float32Array([0,1,1,1,0,0,0,0,1,1,1,0]),new Float32Array(6).fill(1)];
    mouthQuad.forEach((buffer,i)=>{gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,values[i],gl.STATIC_DRAW);});
  }
  const eyeMaskScale=Math.max(1,sampleScale);
  const eyeMaskTexture=gl.createTexture(),eyeMaskFramebuffer=gl.createFramebuffer();
  if(!eyeMaskTexture||!eyeMaskFramebuffer)throw new Error('目を表示する準備ができませんでした。');
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,eyeMaskTexture);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,canvasWidth*eyeMaskScale,canvasHeight*eyeMaskScale,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER,eyeMaskFramebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,eyeMaskTexture,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('目の表示を準備できませんでした。ページを開き直してください。');
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.activeTexture(gl.TEXTURE0);
  gl.uniform2f(locEyeMaskTexel,1/(canvasWidth*3),1/(canvasHeight*3));
  const hasEyeSmile = {
    L: layers.some(layer => layer.bn === 'eye_smile' && layer.side === 'L'),
    R: layers.some(layer => layer.bn === 'eye_smile' && layer.side === 'R'),
  };
  const hasEyeClose = {
    L: layers.some((layer) => layer.bn === 'eye_close' && layer.side === 'L'),
    R: layers.some((layer) => layer.bn === 'eye_close' && layer.side === 'R'),
  };
  const angryFeatures: Partial<Record<'L'|'R', DrawnEyeFeatures>> = {};
  for (const layer of layers) if(layer.bn === 'eyes_angry' && (layer.side==='L'||layer.side==='R')) {
    const anchor=layer.side==='L'?anchors.eyeL:anchors.eyeR;
    if(anchor) angryFeatures[layer.side]=drawnEyeFeatures(layer,anchor);
  }
  const hasEyeAngry = { L: !!angryFeatures.L, R: !!angryFeatures.R };
  const sadFeatures: Partial<Record<'L'|'R', DrawnEyeFeatures>> = {};
  for(const layer of layers)if(layer.bn==='eyes_sad'&&(layer.side==='L'||layer.side==='R')) {
    const anchor=layer.side==='L'?anchors.eyeL:anchors.eyeR;
    if(anchor)sadFeatures[layer.side]=drawnEyeFeatures(layer,anchor);
  }
  const hasEyeSad={L:!!sadFeatures.L,R:!!sadFeatures.R};
  const eyeSlots = { L: createEyeDrawingSlot(), R: createEyeDrawingSlot() };
  const eyeDrawings: Record<'L'|'R', EyeDrawing> = { L: 'neutral', R: 'neutral' };
  const eyeFrames = {L:eyeSlots.L.getFrame(),R:eyeSlots.R.getFrame()};

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  let disposed = false;
  let animationFrame = 0;
  let last = performance.now();
  let blinkT = -1;
  let nextBlink = last + 1800;
  let nextRandom = 0;
  let intensity = 1;
  let motionTuning: Anime25MotionTuning = {
    ...DEFAULT_ANIME25_MOTION_TUNING,
  };
  let motionEnabled = true;
  let mouthInput = 0;
  let eyeOpenOverride: number | null = null;
  let trackingInput: Partial<TrackingInput> | null = null;
  let trackingWeight = 0;
  let voiceMouth: number | null = null;
  let viewOffsetX = 0;
  let viewOffsetY = 0;
  let viewScale = 1;
  const dragInertia = { x: 0, y: 0, vx: 0, vy: 0, targetX: 0, targetY: 0, active: false };
  let averageFps = 0;
  let focusedLayer: string | null = null;
  let drawingLayers: { name: string; side: string; drawing: string; alpha: number }[] = [];
  let fpsFrames = 0;
  let fpsStart = last;
  const randomTarget = { ax: 0, ay: 0, az: 0, bd: 0, ex: 0, ey: 0 };
  const profileRuntime = createPsdMotionProfileRuntime();
  const target = { ...DEFAULT_PARAMS };
  const current = { ...DEFAULT_PARAMS };
  const bounce = { x: 0, v: 0, dy: 0 };

  function pointInTriangle(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ): [number, number, number] | null {
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denominator) < 1e-8) return null;
    const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denominator;
    const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denominator;
    const c = 1 - a - b;
    const epsilon = -0.0001;
    return a >= epsilon && b >= epsilon && c >= epsilon ? [a, b, c] : null;
  }

  function layerContainsPoint(layer: RenderLayer, x: number, y: number): boolean {
    for (let index = 0; index < layer.indices.length; index += 3) {
      const ia = layer.indices[index]!;
      const ib = layer.indices[index + 1]!;
      const ic = layer.indices[index + 2]!;
      const weights = pointInTriangle(
        x,
        y,
        layer.cur[ia * 2]!,
        layer.cur[ia * 2 + 1]!,
        layer.cur[ib * 2]!,
        layer.cur[ib * 2 + 1]!,
        layer.cur[ic * 2]!,
        layer.cur[ic * 2 + 1]!,
      );
      if (!weights) continue;
      const u =
        layer.uv[ia * 2]! * weights[0] +
        layer.uv[ib * 2]! * weights[1] +
        layer.uv[ic * 2]! * weights[2];
      const v =
        layer.uv[ia * 2 + 1]! * weights[0] +
        layer.uv[ib * 2 + 1]! * weights[1] +
        layer.uv[ic * 2 + 1]! * weights[2];
      const imageX = clamp(Math.round(u * (layer.img.width - 1)), 0, layer.img.width - 1);
      const imageY = clamp(Math.round(v * (layer.img.height - 1)), 0, layer.img.height - 1);
      if (layer.img.data[(imageY * layer.img.width + imageX) * 4 + 3]! >= 24) return true;
    }
    return false;
  }

  function deform(layer: RenderLayer, params: MotionParams) {
    if (layer.side === 'L' || layer.side === 'R') params = eyeSlotParameters(params, layer.side, eyeDrawings[layer.side], eyeFrames[layer.side]);
    const base = layer.base;
    const output = layer.cur;
    const isHead = layer.group === 'head';
    const angleZ = params.angleZ * 0.07;
    const cosZ = Math.cos(angleZ);
    const sinZ = Math.sin(angleZ);
    const bodyAngle = params.body * 0.028;
    const cosBody = Math.cos(bodyAngle);
    const sinBody = Math.sin(bodyAngle);
    const eyeAnchor =
      layer.side === 'L'
        ? anchors.eyeL
        : layer.side === 'R'
          ? anchors.eyeR
          : null;
    const requestedWink = layer.side === 'L' ? params.eyeWinkL : params.eyeWinkR;
    const hasSmile = Boolean(layer.side && hasEyeSmile[layer.side as 'L'|'R']);
    const wink = hasSmile ? 0 : requestedWink;
    const expression = resolveEyeExpression(Math.min(layer.side === 'L' ? params.eyeOpenL : params.eyeOpenR, 1 - wink),
      Math.max(smileForSide(params, layer.side), hasSmile ? requestedWink : 0), hasSmile);
    const eyeOpen = expression.eyeOpen;
    const sad = layer.side && hasEyeSad[layer.side as 'L'|'R'] ? params.eyeSad : 0;
    const angry = sad || (layer.side && hasEyeAngry[layer.side as 'L'|'R'] ? params.eyeAngry : 0);
    const drawnFeatures = layer.side ? (sad?sadFeatures:angryFeatures)[layer.side as 'L'|'R'] : undefined;
    const lowerProgress = Math.max(expression.smileProgress, params.eyeNarrow * 0.8 * (1 - Math.min(1, wink / 0.9)));
    const winkClosure = wink > 0 ? Math.max(Math.min(1, wink / 0.9), 1 - (layer.side === 'L' ? params.eyeOpenL : params.eyeOpenR)) : 0;
    const lidParameters = { upperLid: params.upperLid, eyeWide: params.eyeWide,
      lidTilt: params.lidTilt, faceCenterX: anchors.face.cx };
    const mouthHalfWidth = (anchors.mouth.x1 - anchors.mouth.x0) / 2;
    const strandCount = layer.strands?.length || 0;
    const centerX = layer.x + layer.w / 2;
    const centerY = layer.y + layer.h / 2;
    const isFrontHair = layer.bn === 'front hair';

    for (let index = 0; index < base.length; index += 2) {
      let x = base[index];
      let y = base[index + 1];
      const vertex = index >> 1;
      layer.inkVisibility[vertex] = 1;
      layer.lidShade[vertex] = 0;
      if(eyeAnchor && angry>0 && drawnFeatures && (layer.fade==='eyeAngry'||layer.fade==='eyeSad'||layer.fade==='eyeOpen'||layer.bn==='eyebrow')) {
        const drawing=layer.fade==='eyeAngry'||layer.fade==='eyeSad';
        const brow=layer.bn==='eyebrow'||(drawing&&y<drawnFeatures.browCut);
        const amount=!drawing&&brow&&angry>=.5?0:angry;
        const point=morphDrawnEye(x,y,eyeAnchor,drawnFeatures,amount,drawing,brow);
        x=point.x;y=point.y;
        if(drawing&&!brow) {
          y=eyeAnchor.closeY+(y-eyeAnchor.closeY)*eyeOpen;
        }
      }
      if (layer.fade === 'tears') {
        const edge = layer.y + params.tears * layer.h;
        layer.inkVisibility[vertex] = smooth((edge-y)/Math.max(1,layer.h*.08));
        if (eyeAnchor) {
          const lowerY = eyeAnchor.y1+(eyeAnchor.closeY-eyeAnchor.y1)*(1-eyeOpen);
          const attachedY = lowerY+((eyeAnchor.smileY ?? lowerY)-lowerY)*lowerProgress;
          y += (attachedY-eyeAnchor.y1)*Math.max(0,1-(y-layer.y)/layer.h);
        }
      }
      if (layer.fade === 'sweat') y -= (1-params.sweat)*5*faceScale;
      if (layer.fade === 'angerMark') {
        const scale = .75 + .25*smooth(params.angerMark);
        x = centerX+(x-centerX)*scale; y = centerY+(y-centerY)*scale;
      }
      if (layer.fade === 'eyeSmile' && eyeAnchor) {
        layer.inkVisibility[vertex] = smileInkVisibility(x, y, eyeAnchor, expression.smileRestore);
      }
      if (layer.bn === 'eyelash' && eyeAnchor && Math.max(lowerProgress, winkClosure) > 0) {
        // Remove the lower-lash fringe before it collapses into isolated dots.
        // This clips one drawing; it never blends two different eye drawings.
        const upper = upperLidY(eyeAnchor.upperLid, x, eyeAnchor.y0);
        const band = (eyeAnchor.y1 - eyeAnchor.y0) * 0.12;
        const lowerInk = smooth((y - upper - band) / Math.max(1, band));
        layer.inkVisibility[vertex] = 1 - lowerInk * smooth((Math.max(lowerProgress, winkClosure) - 0.45) / 0.4);
      }

      const isEyePart =
        Boolean(eyeAnchor) &&
        (layer.fade === 'eyeOpen' ||
          layer.fade === 'eyeClose' ||
          layer.fade === 'eyeSmile' ||
          layer.bn === 'eyebrow');

      if (eyeAnchor && isEyePart) {
        const scale = layer.side === 'L' ? params.eyeScaleL : params.eyeScaleR;
        if (scale !== 1) {
          const cx = (eyeAnchor.x0 + eyeAnchor.x1) / 2;
          const cy = (eyeAnchor.y0 + eyeAnchor.y1) / 2;
          x = cx + (x - cx) * scale;
          y = cy + (y - cy) * scale;
        }
      }

      if (layer.bn.startsWith('mouth_')) {
        const shaped = mouthController.warp(x,y,layer.bn,mouthFrame);
        x=shaped.x; y=shaped.y; layer.inkVisibility[vertex]=shaped.visibility;
        if (params.mouthScale !== 1) {
          x = anchors.mouth.cx + (x - anchors.mouth.cx) * params.mouthScale;
          y = anchors.mouth.cy + (y - anchors.mouth.cy) * params.mouthScale;
        }
      }

      if (layer.fade === 'eyeOpen' && eyeAnchor) {
        const fallbackNarrow=!hasSmile && lowerProgress>0 && winkClosure===0;
        const shaped = shapeUpperLid(x, y, eyeAnchor, lidParameters,
          layer.bn === 'eyelash', layer.bn === 'irides', lowerProgress);
        x = shaped.x; y = shaped.y;
        if(layer.bn==='eyelash' && params.lidTilt>0.0001 && params.upperLid>0.0001) {
          const lid=upperLidShape(x,eyeAnchor,lidParameters,lowerProgress);
          layer.lidShade[vertex]=(y-lid.target-lid.height*.035)/Math.max(1,lid.height*.02);
        }

        if (layer.bn === 'irides') {
          x = eyeAnchor.icx + (x - eyeAnchor.icx) * params.irisScale;
          y = eyeAnchor.icy + (y - eyeAnchor.icy) * params.irisScale;
          x += params.eyeX * 11 * faceScale;
          y += params.eyeY * 6 * faceScale;
          if(fallbackNarrow) {
            y=shapeWink(x,y,eyeAnchor,1-eyeOpen,false,true).y;
          } else if (winkClosure > 0) {
            const shaped = shapeWink(x, y, eyeAnchor, winkClosure, false, true); y = shaped.y;
          } else {
            const tuck = smooth((0.32 - eyeOpen) / 0.32);
            y = eyeAnchor.closeY + (y - eyeAnchor.closeY) * (1 - 0.8 * tuck);
          }
        } else if(fallbackNarrow) {
          y=raiseLowerLid(y,x,eyeAnchor,lowerProgress,layer.bn==='eyelash');
          const shaped=shapeWink(x,y,eyeAnchor,1-eyeOpen,layer.bn==='eyelash');x=shaped.x;y=shaped.y;
        } else if (winkClosure > 0) {
          const shaped = shapeWink(x, y, eyeAnchor, winkClosure, layer.bn === 'eyelash'); x = shaped.x; y = shaped.y;
        } else {
          y =
            eyeAnchor.closeY +
            (y - eyeAnchor.closeY) * (1 - 0.85 * (1 - eyeOpen));
        }
        if (lowerProgress > 0 && !fallbackNarrow) {
          if (layer.bn === 'irides') {
            // The rising white-of-eye stencil hides the lower iris first.
            const tuck = smooth((lowerProgress - 0.5) / 0.5);
            const pivot = eyeAnchor.smileY ?? eyeAnchor.y0;
            y = pivot + (y - pivot) * (1 - 0.4 * tuck);
          } else {
            y = raiseLowerLid(y, x, eyeAnchor, lowerProgress, layer.bn === 'eyelash');
          }
        }
      }

      if (layer.fade === 'eyeOpen' && eyeAnchor && (layer.bn==='eyewhite'||layer.bn==='irides')) {
        const lid=upperLidShape(x,eyeAnchor,lidParameters,lowerProgress);
        const edge=lid.target+lid.height*.07;
        const depth=Math.max(0,y-edge);
        layer.lidShade[vertex]=lid.lower*.18*Math.exp(-depth/Math.max(1,lid.height*.09))*eyeOpen;
      }

      if (layer.fade === 'eyeSmile' && eyeAnchor) {
        const shaped = morphSmile(x, y, eyeAnchor, expression.smileRestore);
        x = shaped.x; y = shaped.y;
      }

      if (layer.fade === 'eyeClose' && eyeAnchor) {
        if (wink > 0) {
          const shaped = morphClosedWink(x,y,eyeAnchor,Math.max(0,Math.min(1,(wink-0.9)/0.1)));
          x=shaped.x; y=shaped.y;
        } else y -= eyeOpen * 3;
      }

      if (layer.bn === 'eyebrow' && eyeAnchor) {
        const shaped = shapeBrow(x, y, eyeAnchor, layer.side, params);
        x = shaped.x; y = shaped.y;
        y += (-params.brow * 9 + expression.blinkBrow * 3.5) * faceScale;
        const sideAngle =
          layer.side === 'L' ? params.browAngL : params.browAngR;
        const symmetricAngle =
          params.browAngSym * (layer.side === 'L' ? 1 : -1);
        const browAngle = (sideAngle + symmetricAngle) * 0.25;
        if (browAngle) {
          const cosBrow = Math.cos(browAngle);
          const sinBrow = Math.sin(browAngle);
          const rx = x - eyeAnchor.icx;
          const ry = y - eyeAnchor.icy;
          x = eyeAnchor.icx + rx * cosBrow - ry * sinBrow;
          y = eyeAnchor.icy + rx * sinBrow + ry * cosBrow;
        }
      }

      if (layer.bn.startsWith('mouth_')) {
        const q = Math.abs(x - anchors.mouth.cx) / (mouthHalfWidth + 4);
        const form = params.mouthForm * mouthFrame.weights.base;
        const formAmplitude = 12 * faceScale + (form < 0 ? (anchors.mouth.closedHeight || 0) * 0.5 : 0);
        y -= form * formAmplitude * (q ** 1.5 - 0.35);
      }

      if (layer.bn.startsWith('mouth_')) {
        y += params.mouthCY * 14 * faceScale;
        const mouthAngle = params.mouthCAng * 0.35;
        if (mouthAngle) {
          const cosMouth = Math.cos(mouthAngle);
          const sinMouth = Math.sin(mouthAngle);
          const rx = x - anchors.mouth.cx;
          const ry = y - anchors.mouth.cy;
          x = anchors.mouth.cx + rx * cosMouth - ry * sinMouth;
          y = anchors.mouth.cy + rx * sinMouth + ry * cosMouth;
        }
      }

      if (eyeAnchor && isEyePart) {
        y += params.eyeCY * 14 * faceScale;
        const eyeAngle = params.eyeCAng * 0.22;
        if (eyeAngle) {
          const cosEye = Math.cos(eyeAngle);
          const sinEye = Math.sin(eyeAngle);
          const rx = x - eyeAnchor.icx;
          const ry = y - eyeAnchor.icy;
          x = eyeAnchor.icx + rx * cosEye - ry * sinEye;
          y = eyeAnchor.icy + rx * sinEye + ry * cosEye;
        }
      }

      if (layer.bn === 'face' && y > anchors.mouth.cy) {
        y +=
          params.mouthOpen *
          6 *
          faceScale *
          smooth((y - anchors.mouth.cy) / (anchors.face.y1 - anchors.mouth.cy));
      }

      let headWeight = isHead ? 1 : layer.group === 'body' ? 0.16 : 0;
      if (layer.bn === 'neck') {
        headWeight =
          0.55 *
          smooth(
            (anchors.neckBottom - y) /
              Math.max(1, anchors.neckBottom - anchors.neckTop),
          );
      }

      if (headWeight > 0) {
        const rx = x - neckPivot.cx;
        const ry = y - neckPivot.cy;
        const rotatedX = rx * cosZ - ry * sinZ;
        const rotatedY = rx * sinZ + ry * cosZ;
        x += (rotatedX - rx) * headWeight;
        y += (rotatedY - ry) * headWeight;
        x +=
          headWeight *
          faceScale *
          (params.angleX * (14 + 40 * (layer.depth - 1)) +
            params.angleX * (neckPivot.cy - y) * 0.028);
        y +=
          headWeight *
          faceScale *
          (-params.angleY * (9 + 30 * (layer.depth - 1)) -
            params.angleY * (layer.depth - 1) * (y - faceCenter.y) * 0.05);
      }

      y -=
        (layer.group === 'body'
          ? params.breath * 2 * BREATH_SCALE
          : params.breathHead * 1.6 * BREATH_SCALE) * faceScale;

      if (layer.bn === 'topwear' && y < chest.cy) {
        y -=
          params.breath *
          2.2 *
          BREATH_SCALE *
          faceScale *
          smooth((chest.cy - y) / (chest.ry * 2));
      }
      if (layer.bn === 'topwear') {
        x =
          neckPivot.cx +
          (x - neckPivot.cx) * (1 + params.breath * 0.003 * BREATH_SCALE);
        const gx = (x - chest.cx) / chest.rx;
        const gy = (y - (chest.cy + params.bustY * 70 * faceScale)) / chest.ry;
        y += bounce.dy * params.bust * Math.exp(-gx * gx - gy * gy);
      }

      if (layer.bn === 'handwear') {
        const weight = smooth(((y - layer.y) / layer.h) * 1.15);
        y -= params.armY * 30 * faceScale * weight;
        y += params.armPos * 40 * faceScale;
        x += params.armY * 6 * faceScale * weight * (x < neckPivot.cx ? 1 : -1);
      }

      if (layer.bw && layer.su) {
        const motion = layer.su[vertex] ** 1.4 * 22 * faceScale;
        x +=
          (params.bangL * layer.bw[vertex * 3] +
            params.bangC * layer.bw[vertex * 3 + 1] +
            params.bangR * layer.bw[vertex * 3 + 2]) *
          motion;
      }

      if (strandCount && layer.sw && layer.su && layer.spr) {
        const u = isFrontHair
          ? Math.min(1, layer.su[vertex] * 1.6)
          : layer.su[vertex];
        const amplitude =
          u ** (isFrontHair ? 1.8 : 2.1) *
          (isFrontHair ? params.fhAmp : params.physAmp) *
          HAIR_PHYSICS_SCALE;
        const softMix = u ** 1.2 * (isFrontHair ? params.fhSoft : params.soft);
        let dx = 0;
        for (let strand = 0; strand < strandCount; strand += 1) {
          const weight = layer.sw[vertex * strandCount + strand];
          if (weight < 0.001) continue;
          const spring = layer.spr[strand];
          dx +=
            weight *
            (spring.stiff.dx * (1 - softMix) + spring.soft.dx * softMix);
        }
        x += dx * amplitude;
        y += Math.abs(dx) * amplitude * 0.12;
      }

      output[index] = x;
      output[index + 1] = y;
    }

    if (Math.abs(bodyAngle) > 1e-4) {
      for (let index = 0; index < output.length; index += 2) {
        const rx = output[index] - bodyPivot.cx;
        const ry = output[index + 1] - bodyPivot.cy;
        output[index] = bodyPivot.cx + rx * cosBody - ry * sinBody;
        output[index + 1] = bodyPivot.cy + rx * sinBody + ry * cosBody;
      }
    }

    void centerX;
    void centerY;
  }

  function tick(now: number) {
    if (disposed) return;
    animationFrame = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const time = now / 1000;
    const profile = profileRuntime.getProfile();
    Object.assign(
      target,
      resolveBasePsdMotionParameters(profile, mouthInput, motionEnabled),
      { breath: 0, breathHead: 0 },
    );
    const activeIntensity = motionEnabled ? intensity : 0;
    const idleIntensity = profile.automation.idle ? activeIntensity : 0;
    const randomIntensity = profile.automation.randomMotion
      ? activeIntensity
      : 0;
    const physicsIntensity = profile.automation.physics ? activeIntensity : 0;

    target.angleX +=
      idleIntensity *
      motionTuning.idleScale *
      IDLE_SWAY_SCALE *
      (0.13 * Math.sin(time * 0.42) + 0.05 * Math.sin(time * 1.13));
    target.angleY +=
      idleIntensity * motionTuning.idleScale * IDLE_SWAY_SCALE * 0.08 * Math.sin(time * 0.31 + 1.7);
    target.angleZ +=
      idleIntensity * motionTuning.idleScale * IDLE_SWAY_SCALE * 0.07 * Math.sin(time * 0.23 + 0.5);
    target.body +=
      idleIntensity * motionTuning.idleScale * IDLE_SWAY_SCALE * 0.1 * Math.sin(time * 0.19 + 2.1);

    if (randomIntensity > 0 && now > nextRandom) {
      nextRandom = now + 1400 + Math.random() * 2600;
      randomTarget.ax = (Math.random() * 2 - 1) * 0.75;
      randomTarget.ay = (Math.random() * 2 - 1) * 0.55;
      randomTarget.az = (Math.random() * 2 - 1) * 0.5;
      randomTarget.bd = (Math.random() * 2 - 1) * 0.45;
      randomTarget.ex = (Math.random() * 2 - 1) * 0.8;
      randomTarget.ey = (Math.random() * 2 - 1) * 0.5;
    }

    target.angleX = clamp(
      target.angleX + randomTarget.ax * randomIntensity,
      -1,
      1,
    );
    target.angleY = clamp(
      target.angleY + randomTarget.ay * randomIntensity,
      -1,
      1,
    );
    target.angleZ = clamp(
      target.angleZ + randomTarget.az * randomIntensity,
      -1,
      1,
    );
    target.body = clamp(target.body + randomTarget.bd * randomIntensity, -1, 1);
    target.eyeX = clamp(target.eyeX + randomTarget.ex * randomIntensity, -1, 1);
    target.eyeY = clamp(target.eyeY + randomTarget.ey * randomIntensity, -1, 1);

    if (
      motionEnabled &&
      profile.automation.blink &&
      blinkT < 0 &&
      now > nextBlink
    ) {
      blinkT = 0;
      nextBlink = now + 1600 + Math.random() * 3800;
      if (Math.random() < 0.18) nextBlink = now + 280;
    }
    if (motionEnabled && profile.automation.blink && blinkT >= 0) {
      blinkT += dt;
      let value = 1;
      if (blinkT < 0.08) value = 1 - blinkT / 0.08;
      else if (blinkT < 0.42) value = 0;
      else if (blinkT < 0.58) value = (blinkT - 0.42) / 0.16;
      else blinkT = -1;
      target.eyeOpenL = Math.min(target.eyeOpenL, value);
      target.eyeOpenR = Math.min(target.eyeOpenR, value);
    } else if (!profile.automation.blink) {
      blinkT = -1;
    }

    if (eyeOpenOverride !== null) {
      target.eyeOpenL = eyeOpenOverride;
      target.eyeOpenR = eyeOpenOverride;
    }

    if (trackingInput && trackingWeight > 0) {
      for (const key of Object.keys(trackingInput) as (keyof TrackingInput)[]) {
        const value = trackingInput[key];
        if (value !== undefined) target[key] = composeTrackedExpression(key, target[key], value, trackingWeight);
      }
    }
    if (voiceMouth !== null) target.mouthOpen = Math.max(target.mouthOpen, voiceMouth);
    for (const key of Object.keys(current) as (keyof MotionParams)[]) {
      const tracked = (trackingInput?.[key as keyof TrackingInput] !== undefined && trackingWeight > 0) ||
        (key === 'mouthOpen' && voiceMouth !== null);
      const immediateBlink = (key === 'eyeOpenL' || key === 'eyeOpenR') && blinkT >= 0;
      const alpha = immediateBlink ? 1 : tracked
        ? (key === 'eyeOpenL' || key === 'eyeOpenR' ? 1 : 1 - Math.exp(-dt / 0.025))
        : Math.min(1, dt * 14);
      current[key] += (target[key] - current[key]) * alpha;
      // A discrete expression handoff must reach an exact slider threshold,
      // rather than approach it forever from one side through smoothing.
      if ((key.startsWith('eyeOpen') || key.startsWith('eyeSmile') || key.startsWith('eyeWink') || key === 'eyeSad' || key === 'eyeAngry' || key === 'mouthFrown' || key === 'mouthLaugh' || key === 'mouthRound') && Math.abs(target[key] - current[key]) < 0.001) current[key] = target[key];
    }

    const dragStiffness = dragInertia.active ? 90 : 34;
    const dragDamping = dragInertia.active ? 15 : 6.2;
    dragInertia.vx +=
      (-dragStiffness * (dragInertia.x - dragInertia.targetX) - dragDamping * dragInertia.vx) * dt;
    dragInertia.vy +=
      (-dragStiffness * (dragInertia.y - dragInertia.targetY) - dragDamping * dragInertia.vy) * dt;
    dragInertia.x += dragInertia.vx * dt;
    dragInertia.y += dragInertia.vy * dt;

    const params = { ...current };
    for (const side of ['L', 'R'] as const) {
      const smile = hasEyeSmile[side] ? Math.max(smileForSide(params, side), side === 'L' ? params.eyeWinkL : params.eyeWinkR) : 0;
      eyeDrawings[side] = eyeSlots[side].resolve(smile, hasEyeAngry[side] ? params.eyeAngry : 0,
        side === 'L' ? params.eyeOpenL : params.eyeOpenR, dt,
        hasEyeSmile[side] ? 0 : side === 'L' ? params.eyeWinkL : params.eyeWinkR,hasEyeSad[side]?params.eyeSad:0);
      eyeFrames[side] = eyeSlots[side].getFrame();
    }
    mouthFrame = mouthController.resolve(params,mouthRestWeight(trackingInput?.mouthOpen,trackingWeight));
    params.mouthOpen = mouthFrame.openness;
    const dragPhysics = clamp(
      Math.hypot(dragInertia.x, dragInertia.y) * 1.05 * motionTuning.dragScale,
      0,
      0.72,
    );
    const effectivePhysics = Math.max(physicsIntensity, dragPhysics);
    params.physAmp *= effectivePhysics * motionTuning.hairAmplitudeScale;
    params.soft *= effectivePhysics * motionTuning.hairSoftnessScale;
    params.fhAmp *= effectivePhysics * motionTuning.hairAmplitudeScale;
    params.fhSoft *= effectivePhysics * motionTuning.hairSoftnessScale;
    params.angleZ = clamp(params.angleZ + dragInertia.x * 0.22 * motionTuning.dragScale, -1, 1);
    params.body = clamp(params.body + dragInertia.x * 0.12 * motionTuning.dragScale, -1, 1);
    params.angleY = clamp(params.angleY + dragInertia.y * 0.1 * motionTuning.dragScale, -1, 1);
    params.breath =
      idleIntensity * motionTuning.breathScale *
        (0.5 + 0.5 * Math.sin((time * 2 * Math.PI) / 3.4)) -
      dragInertia.y * 0.22 * motionTuning.dragScale;
    params.breathHead =
      idleIntensity * motionTuning.breathScale *
        (0.5 + 0.5 * Math.sin((time * 2 * Math.PI) / 3.4 - 0.6)) -
      dragInertia.y * 0.14 * motionTuning.dragScale;

    const headDX =
      (params.angleX * 14 +
        params.angleZ * 0.07 * (neckPivot.cy - faceCenter.y)) *
      faceScale;
    for (const layer of layers) {
      if (!layer.spr) continue;
      for (const spring of layer.spr) {
        const wind =
          physicsIntensity *
          HAIR_WIND_SCALE *
          motionTuning.hairWindScale *
          (1.8 * Math.sin(time * 0.8 + spring.phase) +
            Math.sin(time * 1.9 + spring.phase * 2.3));
        const targetX =
          headDX +
          wind * faceScale +
          dragInertia.x * 18 * faceScale * motionTuning.dragScale;
        let kk = 70;
        let damping = 9;
        let acceleration =
          -kk * (spring.stiff.x - targetX) - damping * spring.stiff.v;
        spring.stiff.v += acceleration * dt;
        spring.stiff.x += spring.stiff.v * dt;
        spring.stiff.dx = -(spring.stiff.x - targetX) * 2.2;
        kk = 16;
        damping = 1.3;
        acceleration =
          -kk * (spring.soft.x - targetX) - damping * spring.soft.v;
        spring.soft.v += acceleration * dt;
        spring.soft.x += spring.soft.v * dt;
        spring.soft.dx = -(spring.soft.x - targetX) * 3;
      }
    }

    const bustTarget = physicsIntensity
      ? (params.breath * 3 - params.angleY * 6 + params.body * 4) * faceScale
      : 0;
    const bounceAcceleration = -140 * (bounce.x - bustTarget) - 4.2 * bounce.v;
    bounce.v += bounceAcceleration * dt;
    bounce.x += bounce.v * dt;
    bounce.dy = physicsIntensity ? -(bounce.x - bustTarget) * 3 : 0;

    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER,eyeMaskFramebuffer);gl.clear(gl.COLOR_BUFFER_BIT);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.uniform2f(locRes, canvasWidth, canvasHeight);
    gl.uniform2f(locViewOffset, viewOffsetX, viewOffsetY);
    gl.uniform1f(locViewScale, viewScale);
    drawingLayers = [];
    for (const layer of layers) {
      const alpha = fadeAlpha(layer, params, hasEyeClose, hasEyeSmile, mouthFrame.drawing, hasEyeAngry, eyeDrawings, eyeFrames);
      const drawing = layer.fade === 'eyeOpen' ? 'neutral' : layer.fade === 'eyeClose' ? 'closed'
        : layer.fade === 'eyeSmile' ? 'smile' : layer.fade === 'eyeAngry' ? 'angry' : layer.fade === 'eyeSad' ? 'sad'
        : layer.bn.startsWith('mouth_') ? layer.bn : layer.bn === 'eyebrow' ? 'brow' : '';
      if (drawing) drawingLayers.push({ name: layer.name, side: layer.side ?? '', drawing, alpha });
      if (
        alpha < 0.004 &&
        !(layer.fade === 'eyeOpen' && layer.name.startsWith('eyewhite'))
      ) {
        continue;
      }
      deform(layer, params);
      const sampledMouth=Boolean(mouthFramebuffer&&layer.bn.startsWith('mouth_'));
      if(sampledMouth) {
        gl.bindFramebuffer(gl.FRAMEBUFFER,mouthFramebuffer);
        gl.viewport(0,0,canvasWidth*sampleScale,canvasHeight*sampleScale);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      const focusAlpha =
        focusedLayer && layer.bn !== focusedLayer ? 0.2 : 1;
      gl.uniform1f(locAlpha, alpha * focusAlpha);
      const mouthShade=layer.bn.startsWith('mouth_')&&layer.bn!=='mouth_close'&&layer.bn!=='mouth_frown' ? 1-smooth((mouthFrame.progress-.05)/.28) : 0;
      gl.uniform4f(locMouthShade,mouthInk[0],mouthInk[1],mouthInk[2],mouthShade);
      const lashEye=layer.side==='L'?anchors.eyeL:layer.side==='R'?anchors.eyeR:null;
      if(layer.bn==='eyelash' && lashEye && params.lidTilt>0.0001 && params.upperLid>0.0001) {
        gl.uniform4f(locLashTrim,smooth(params.upperLid/.7)*params.lidTilt,
          ((lashEye.x0+lashEye.x1)/2-layer.x)/layer.w,(lashEye.x1-lashEye.x0)/2/layer.w,layer.side==='L'?-1:1);
      } else gl.uniform4f(locLashTrim,0,0,1,1);
      gl.bindBuffer(gl.ARRAY_BUFFER, layer.vboPos);
      gl.bufferData(gl.ARRAY_BUFFER, layer.cur, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, layer.vboUV);
      gl.vertexAttribPointer(locUV, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, layer.vboInk);
      gl.bufferData(gl.ARRAY_BUFFER, layer.inkVisibility, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(locInk, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER,layer.vboShade);
      gl.bufferData(gl.ARRAY_BUFFER,layer.lidShade,gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(locShade,1,gl.FLOAT,false,0,0);
      gl.bindTexture(gl.TEXTURE_2D, layer.tex);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, layer.ibo);

      // Use fractional coverage of the deformed whites instead of a binary stencil.
      // The iris keeps its own shape and follows the same view and eye movement.
      gl.uniform1f(locUseEyeMask,layer.bn==='irides'?1:0);
      if(layer.bn==='eyewhite') {
        gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,layer.tex);gl.activeTexture(gl.TEXTURE0);
        gl.bindFramebuffer(gl.FRAMEBUFFER,eyeMaskFramebuffer);
        gl.viewport(0,0,canvasWidth*eyeMaskScale,canvasHeight*eyeMaskScale);
        gl.uniform1f(locAlpha,alpha);
        gl.drawElements(gl.TRIANGLES,layer.nIdx,gl.UNSIGNED_SHORT,0);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,canvasWidth,canvasHeight);
        gl.uniform1f(locAlpha,alpha*focusAlpha);
        gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,eyeMaskTexture);gl.activeTexture(gl.TEXTURE0);
      }
      gl.drawElements(gl.TRIANGLES,layer.nIdx,gl.UNSIGNED_SHORT,0);
      if(sampledMouth) {
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);
        gl.viewport(0,0,canvasWidth,canvasHeight);
        [locPos,locUV,locInk].forEach((location,i)=>{gl.bindBuffer(gl.ARRAY_BUFFER,mouthQuad[i]);gl.vertexAttribPointer(location,i===2?1:2,gl.FLOAT,false,0,0);});
        gl.bindTexture(gl.TEXTURE_2D,mouthTexture);
        gl.uniform2f(locViewOffset,0,0);gl.uniform1f(locViewScale,1);
        gl.uniform1f(locAlpha,1);gl.uniform1f(locCut,0);gl.uniform4f(locMouthShade,0,0,0,0);
        gl.uniform2f(locResolveTexel,1/(3*canvasWidth),1/(3*canvasHeight));
        gl.disableVertexAttribArray(locShade);gl.vertexAttrib1f(locShade,0);
        gl.drawArrays(gl.TRIANGLES,0,6);
        gl.enableVertexAttribArray(locShade);
        gl.uniform2f(locResolveTexel,0,0);
        gl.uniform2f(locViewOffset,viewOffsetX,viewOffsetY);gl.uniform1f(locViewScale,viewScale);
      }
    }

    fpsFrames += 1;
    if (now - fpsStart > 500) {
      averageFps = Math.round((fpsFrames * 1000) / (now - fpsStart));
      fpsFrames = 0;
      fpsStart = now;
    }
  }

  animationFrame = requestAnimationFrame(tick);

  return {
    getMouthState() {
      return { ...mouthFrame, weights: { ...mouthFrame.weights },
        sampleScale:mouthFramebuffer?sampleScale:1,
        visibleDrawings: layers.filter(layer=>layer.bn.startsWith('mouth_') && layer.bn===mouthFrame.drawing).length };
    },
    setVoiceMouth(value) {
      voiceMouth = value !== null && Number.isFinite(value) ? clamp(value, 0, 1) : null;
    },
    setTrackingInput(input, weight) {
      trackingInput = input === null ? null : {};
      const keys: (keyof TrackingInput)[] = ['angleX', 'angleY', 'angleZ', 'body', 'eyeOpenL', 'eyeOpenR', 'eyeX', 'eyeY', 'mouthOpen', 'mouthForm', 'brow'];
      if (input && trackingInput) for (const key of keys) {
        const value = input[key];
        if (value !== undefined && Number.isFinite(value)) trackingInput[key] = clamp(value, key === 'eyeOpenL' || key === 'eyeOpenR' || key === 'mouthOpen' ? 0 : -1, 1);
      }
      trackingWeight = input && Number.isFinite(weight) ? clamp(weight, 0, 1) : 0;
    },
    setMouthOpen(value: number) {
      mouthInput = clamp(value, 0, 1);
    },
    setEyeOpen(value: number | null) {
      eyeOpenOverride = value === null ? null : clamp(value, 0, 1);
      if (eyeOpenOverride !== null) blinkT = -1;
    },
    setIntensity(value: number) {
      intensity = clamp(value, 0, 2);
    },
    setMotionTuning(value: Partial<Anime25MotionTuning>) {
      motionTuning = {
        idleScale: clamp(value.idleScale ?? motionTuning.idleScale, 0, 1.5),
        breathScale: clamp(value.breathScale ?? motionTuning.breathScale, 0, 1.5),
        hairWindScale: clamp(value.hairWindScale ?? motionTuning.hairWindScale, 0, 1.5),
        hairAmplitudeScale: clamp(
          value.hairAmplitudeScale ?? motionTuning.hairAmplitudeScale,
          0,
          1.5,
        ),
        hairSoftnessScale: clamp(
          value.hairSoftnessScale ?? motionTuning.hairSoftnessScale,
          0,
          1.2,
        ),
        dragScale: clamp(value.dragScale ?? motionTuning.dragScale, 0, 1.5),
      };
    },
    getMotionTuning() {
      return { ...motionTuning };
    },
    setViewTransform(offsetX: number, offsetY: number, scale: number) {
      viewOffsetX = clamp(offsetX, -canvasWidth * 2, canvasWidth * 2);
      viewOffsetY = clamp(offsetY, -canvasHeight * 2, canvasHeight * 2);
      viewScale = clamp(scale, 0.5, 2);
    },
    setDragMotion(velocityX: number, velocityY: number, active: boolean) {
      dragInertia.active = active;
      dragInertia.targetX = active ? -clamp(velocityX, -1, 1) : 0;
      dragInertia.targetY = active ? -clamp(velocityY, -1, 1) : 0;
    },
    resetDragMotion() {
      dragInertia.x = 0;
      dragInertia.y = 0;
      dragInertia.vx = 0;
      dragInertia.vy = 0;
      dragInertia.targetX = 0;
      dragInertia.targetY = 0;
      dragInertia.active = false;
    },
    getDragMotion() {
      return { x: dragInertia.x, y: dragInertia.y };
    },
    setMotionEnabled(value: boolean) {
      motionEnabled = value;
      if (!value) {
        blinkT = -1;
        randomTarget.ax = 0;
        randomTarget.ay = 0;
        randomTarget.az = 0;
        randomTarget.bd = 0;
        randomTarget.ex = 0;
        randomTarget.ey = 0;
      }
    },
    setMotionProfile(profile: PsdMotionProfile) {
      const wasBlinkEnabled = profileRuntime.getProfile().automation.blink;
      profileRuntime.setMotionProfile(profile);
      nextRandom = 0;
      if (!profile.automation.blink) blinkT = -1;
      else if (!wasBlinkEnabled) nextBlink = performance.now() + 650;
    },
    getEyeOpen() {
      return { left: current.eyeOpenL, right: current.eyeOpenR };
    },
    setEyeExpressionTarget(values) {
      for(const side of ['L','R'] as const) {
        if(!values){eyeSlots[side].clearTarget();continue;}
        const wink=(side==='L'?values.eyeWinkL:values.eyeWinkR)??0;
        const smile=hasEyeSmile[side]?Math.max(values.eyeSmile??0,(side==='L'?values.eyeSmileL:values.eyeSmileR)??0,wink):0;
        eyeSlots[side].request(smile,hasEyeAngry[side]?values.eyeAngry??0:0,hasEyeSmile[side]?0:wink,hasEyeSad[side]?values.eyeSad??0:0);
      }
    },
    getDrawingState() { return { eyes: {L:{...eyeFrames.L,drawing:eyeDrawings.L,open:current.eyeOpenL},R:{...eyeFrames.R,drawing:eyeDrawings.R,open:current.eyeOpenR}}, layers: drawingLayers.map(layer => ({ ...layer })) }; },
    getAverageFps() {
      return averageFps;
    },
    setLayerFocus(name) {
      focusedLayer = name;
    },
    getLayerFocus() {
      return focusedLayer;
    },
    pickLayersAt(canvasX, canvasY) {
      const modelX =
        (canvasX - canvasWidth * 0.5 - viewOffsetX) / viewScale + canvasWidth * 0.5;
      const modelY =
        (canvasY - canvasHeight * 0.5 - viewOffsetY) / viewScale + canvasHeight * 0.5;
      const matches: string[] = [];
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        const layer = layers[index]!;
        if (fadeAlpha(layer, current, hasEyeClose, hasEyeSmile, mouthFrame.drawing, hasEyeAngry, eyeDrawings, eyeFrames) < 0.08) continue;
        if (!layerContainsPoint(layer, modelX, modelY)) continue;
        if (!matches.includes(layer.bn)) matches.push(layer.bn);
      }
      return matches;
    },
    getAnimationState() {
      return { current: { ...current }, blinkT, nextBlink, nextRandom, mouthSelection:mouthController.getState(), eyeDrawings: { ...eyeDrawings },
        eyeSlots:{L:eyeSlots.L.getSnapshot(),R:eyeSlots.R.getSnapshot()},
        randomTarget: { ...randomTarget }, bounce: { ...bounce },
        springs: new Map(layers.map(layer => [layer.name, structuredClone(layer.spr ?? [])])) };
    },
    setAnimationState(state) {
      if(state.mouthSelection)mouthController.setState(state.mouthSelection);
      if(state.eyeSlots)for(const side of ['L','R'] as const)eyeSlots[side].restore(state.eyeSlots[side]);
      else if(state.eyeDrawings)for(const side of ['L','R'] as const)eyeSlots[side].setState(state.eyeDrawings[side]);
      Object.assign(current, state.current); Object.assign(randomTarget, state.randomTarget); Object.assign(bounce, state.bounce);
      blinkT = state.blinkT; nextBlink = state.nextBlink; nextRandom = state.nextRandom;
      for (const layer of layers) {
        const springs = state.springs.get(layer.name);
        if (layer.spr && springs?.length === layer.spr.length) layer.spr.forEach((spring, i) => Object.assign(spring, springs[i]));
      }
      // Draw the replacement before it becomes visible; keep the current pose at dt=0.
      cancelAnimationFrame(animationFrame); last = performance.now(); tick(last);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      gl.deleteTexture(eyeMaskTexture);gl.deleteFramebuffer(eyeMaskFramebuffer);
      for (const layer of layers) {
        gl.deleteTexture(layer.tex);
        gl.deleteBuffer(layer.vboPos);
        gl.deleteBuffer(layer.vboUV);
        gl.deleteBuffer(layer.vboInk);
        gl.deleteBuffer(layer.vboShade);
        gl.deleteBuffer(layer.ibo);
      }
      gl.deleteProgram(program);
      gl.deleteTexture(mouthTexture);gl.deleteFramebuffer(mouthFramebuffer);
      mouthQuad.forEach(buffer=>gl.deleteBuffer(buffer));
    },
  };
}
