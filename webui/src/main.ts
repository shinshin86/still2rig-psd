import { installCameraControls } from './tracking/controls';
import type { TrackingInput } from './tracking/pose.mjs';
import { detectAnime25RigFromBuffer } from './rig/anime25Rig';
import {
  createAnime25RigAvatar,
  DEFAULT_ANIME25_MOTION_TUNING,
  type Anime25MotionTuning,
  type Anime25RigAvatar,
} from './rig/anime25Renderer';
import {
  createDefaultPsdMotionProfile,
  DEFAULT_PSD_MOTION_PARAMETERS,
  PSD_MOTION_PARAMETER_DEFINITIONS,
  type PsdMotionParameterDefinition,
  type PsdMotionParameterGroup,
  type PsdMotionParameterName,
  type PsdMotionParameters,
  type PsdMotionProfile,
} from './psdMotionProfile';
import {
  buildReorderedPsd,
  editedPsdFileName,
  inspectEditablePsd,
  layerLabel,
  type EditablePsdLayer,
} from './psdLayerEditor';

type QaMode = 'static' | 'physics' | 'idle-physics';
type MotionPreset = 'calm' | 'standard' | 'active' | 'custom';
type WorkspaceMode = 'motion' | 'layers';
type UiMotionTuning = Anime25MotionTuning & { intensity: number };

interface GeneratedPsd {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  state: string;
  productionReady: boolean | null;
  bytes: number;
  jobId: string | null;
}

interface RigQaApi {
  setTrackingInput: (input: Partial<TrackingInput> | null, weight: number) => void;
  getCameraState: () => { state: string; active: boolean; liveTracks: number };
  ready: boolean;
  error: string | null;
  summary: unknown;
  anchors: Record<string, unknown>;
  setState: (eyeOpen: number, mouthOpen: number) => void;
  setMode: (mode: QaMode) => void;
  setAutoBlink: (enabled: boolean) => void;
  getAutoBlink: () => boolean;
  getEyeOpen: () => { left: number; right: number };
  setLabel: (phase: string, detail?: string, progress?: number) => void;
  setBackground: (mode: 'checker' | 'solid') => void;
  setViewTransform: (offsetX: number, offsetY: number, scale: number) => void;
  getViewTransform: () => { offsetX: number; offsetY: number; scale: number };
  getDragMotion: () => { x: number; y: number };
  setMotionTuning: (value: Partial<UiMotionTuning>) => void;
  getMotionTuning: () => UiMotionTuning;
  setProfileParameter: (name: PsdMotionParameterName, value: number) => void;
  getProfileParameters: () => PsdMotionParameters;
  resetProfileParameters: () => void;
  getAverageFps: () => number;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  setLayerProcessingPreview: (active: boolean) => Promise<void>;
  getLayerEditorState: () => {
    mode: WorkspaceMode;
    originalOrder: string[];
    currentOrder: string[];
    selectedLayer: string | null;
    layerFocus: string | null;
    dirty: boolean;
    showingOriginal: boolean;
  };
}

declare global {
  interface Window { rigQa: RigQaApi; }
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`QA harness DOM is missing ${selector}.`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>('#rig-canvas');
const stage = requireElement<HTMLElement>('.stage');
const controlPanel = requireElement<HTMLElement>('.control-panel');
const modelNode = requireElement<HTMLElement>('#model-name');
const phaseNode = requireElement<HTMLElement>('#phase');
const detailNode = requireElement<HTMLElement>('#detail');
const progressNode = requireElement<HTMLElement>('#progress');
const progressTrack = requireElement<HTMLElement>('.track');
const statusNode = requireElement<HTMLElement>('#status');
const reportNode = requireElement<HTMLElement>('#report');
const generatedPsdSelect = requireElement<HTMLSelectElement>('#generated-psd-select');
const generatedPsdRefresh = requireElement<HTMLButtonElement>('#generated-psd-refresh');
const generatedPsdOpenFolder = requireElement<HTMLButtonElement>('#generated-psd-open-folder');
const generatedPsdNote = requireElement<HTMLElement>('#generated-psd-note');
const expressionRequestControl = requireElement<HTMLDetailsElement>('#expression-request-control');
const expressionRequestCopy = requireElement<HTMLButtonElement>('#expression-request-copy');
const expressionRequestStatus = requireElement<HTMLElement>('#expression-request-status');
const expressionRequestSummary = requireElement<HTMLElement>('#expression-request-summary');
const expressionRequestBody = requireElement<HTMLElement>('#expression-request-body');
const expressionRequestDisclosure = requireElement<HTMLElement>('#expression-request-disclosure');
const expressionRecipientButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-recipient]')];
const expressionRecipientSteps = [...document.querySelectorAll<HTMLElement>('[data-recipient-steps]')];
const startRequestCopy = requireElement<HTMLButtonElement>('#start-request-copy');
const startRequestStatus = requireElement<HTMLElement>('#start-request-status');
const startRecipientButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-start-recipient]')];
const startRecipientNames = [...document.querySelectorAll<HTMLElement>('[data-start-recipient-name]')];
type ExpressionRecipient = 'codex' | 'claude';
// One saved choice serves both the new-conversion request and the expression request.
const EXPRESSION_RECIPIENT_KEY = 'still2rig-psd-expression-recipient';
let expressionRequestSource: 'none' | 'local' | 'generated' = 'none';
let expressionRecipient: ExpressionRecipient = readExpressionRecipient();

const psdFileInput = requireElement<HTMLInputElement>('#psd-file-input');
const dropOverlay = requireElement<HTMLElement>('#drop-overlay');
const motionTab = requireElement<HTMLButtonElement>('#motion-tab');
const layerEditTab = requireElement<HTMLButtonElement>('#layer-edit-tab');
const motionPanel = requireElement<HTMLElement>('#motion-panel');
const layerEditPanel = requireElement<HTMLElement>('#layer-edit-panel');
const layerEditorUnavailable = requireElement<HTMLElement>('#layer-editor-unavailable');
const layerEditorContent = requireElement<HTMLElement>('#layer-editor-content');
const commonFixes = requireElement<HTMLElement>('#common-fixes');
const commonFixesList = requireElement<HTMLElement>('#common-fixes-list');
const selectedLayerCard = requireElement<HTMLElement>('#selected-layer-card');
const selectedLayerName = requireElement<HTMLElement>('#selected-layer-name');
const selectedLayerHelp = requireElement<HTMLElement>('#selected-layer-help');
const moveLayerFront = requireElement<HTMLButtonElement>('#move-layer-front');
const moveLayerBack = requireElement<HTMLButtonElement>('#move-layer-back');
const openLayerList = requireElement<HTMLButtonElement>('#open-layer-list');
const beforeAfterToggle = requireElement<HTMLButtonElement>('#before-after-toggle');
const layerOrderDetails = requireElement<HTMLDetailsElement>('#layer-order-details');
const layerOrderList = requireElement<HTMLOListElement>('#layer-order-list');
const layerOrderCount = requireElement<HTMLElement>('#layer-order-count');
const layerOrderTouchNotice = requireElement<HTMLElement>('#layer-order-touch-notice');
const undoLayerEdit = requireElement<HTMLButtonElement>('#undo-layer-edit');
const resetLayerEdit = requireElement<HTMLButtonElement>('#reset-layer-edit');
const layerWarning = requireElement<HTMLElement>('#layer-warning');
const layerSaveFile = requireElement<HTMLElement>('#layer-save-file');
const saveLayerEdit = requireElement<HTMLButtonElement>('#save-layer-edit');
const layerEditStatus = requireElement<HTMLElement>('#layer-edit-status');
const layerEditLiveRegion = requireElement<HTMLElement>('#layer-edit-live-region');
const previewModeBadge = requireElement<HTMLElement>('#preview-mode-badge');
const selectedPartBadge = requireElement<HTMLElement>('#selected-part-badge');
const canvasSelectionMarker = requireElement<HTMLElement>('#canvas-selection-marker');
const canvasPickMenu = requireElement<HTMLElement>('#canvas-pick-menu');
const canvasPickTitle = requireElement<HTMLElement>('#canvas-pick-title');
const canvasPickCopy = requireElement<HTMLElement>('#canvas-pick-copy');
const canvasPickOptions = requireElement<HTMLElement>('#canvas-pick-options');
const layerProcessingOverlay = requireElement<HTMLElement>('#layer-processing-overlay');
const layerProcessingTitle = requireElement<HTMLElement>('#layer-processing-title');
const layerProcessingDetail = requireElement<HTMLElement>('#layer-processing-detail');
const eyeControl = requireElement<HTMLInputElement>('#eye-control');
const mouthControl = requireElement<HTMLInputElement>('#mouth-control');
const eyeValue = requireElement<HTMLOutputElement>('#eye-value');
const mouthValue = requireElement<HTMLOutputElement>('#mouth-value');
const blinkToggle = requireElement<HTMLButtonElement>('#blink-toggle');
const blinkValue = requireElement<HTMLOutputElement>('#blink-value');
const zoomControl = requireElement<HTMLInputElement>('#zoom-control');
const zoomValue = requireElement<HTMLOutputElement>('#zoom-value');
const viewReset = requireElement<HTMLButtonElement>('#view-reset');
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
const presetButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-motion-preset]')];
const tuningPresetValue = requireElement<HTMLOutputElement>('#tuning-preset-value');
const tuningInputIds = [
  'motion-intensity',
  'idle-scale',
  'breath-scale',
  'hair-wind-scale',
  'hair-amplitude-scale',
  'hair-softness-scale',
  'drag-scale',
] as const;
type TuningInputId = (typeof tuningInputIds)[number];
const tuningInputs = Object.fromEntries(
  tuningInputIds.map((id) => [id, requireElement<HTMLInputElement>(`#${id}`)]),
) as Record<TuningInputId, HTMLInputElement>;
const tuningOutputs = Object.fromEntries(
  tuningInputIds.map((id) => [id, requireElement<HTMLOutputElement>(`#${id}-value`)]),
) as Record<TuningInputId, HTMLOutputElement>;
const demoStart = requireElement<HTMLButtonElement>('#demo-start');
const demoStop = requireElement<HTMLButtonElement>('#demo-stop');
const advancedParameterGroups = requireElement<HTMLElement>('#advanced-parameter-groups');
const advancedReset = requireElement<HTMLButtonElement>('#advanced-reset');

if (presetButtons.length !== 3) {
  throw new Error('QA harness DOM is incomplete.');
}

let avatar: Anime25RigAvatar | null = null;
let cameraControls: ReturnType<typeof installCameraControls> | null = null;
let cameraActive = false;
let generatedPsds: GeneratedPsd[] = [];
let eyeOpen = 1;
let mouthOpen = 0;
let autoBlinkEnabled = true;
let demoToken = 0;
let loadToken = 0;
let currentMode: QaMode = 'static';
let currentPreset: MotionPreset = 'standard';
let motionTuning: UiMotionTuning = {
  intensity: 1,
  ...DEFAULT_ANIME25_MOTION_TUNING,
};
let profileParameters: PsdMotionParameters = { ...DEFAULT_PSD_MOTION_PARAMETERS };
let viewOffsetX = 0;
let viewOffsetY = 0;
const DEFAULT_VIEW_SCALE = 0.9;
let viewScale = DEFAULT_VIEW_SCALE;
let dragState: {
  pointerId: number;
  pointerType: string;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  time: number;
  moved: boolean;
} | null = null;
let workspaceMode: WorkspaceMode = 'motion';
let sourcePsdBuffer: ArrayBuffer | null = null;
let sourcePsdFileName = '';
let editableLayers: EditablePsdLayer[] = [];
let originalLayerOrder: string[] = [];
let currentLayerOrder: string[] = [];
let savedLayerOrderSignature = '';
let selectedLayerId: string | null = null;
let layerEditHistory: string[][] = [];
let editedPreviewBuffer: ArrayBuffer | null = null;
let showingOriginal = false;
let layerEditBusy = false;
let layerFocusTimer: number | null = null;
let layerProcessingActive = false;
let layerProcessingStartedAt = 0;
let draggedLayerId: string | null = null;
let layerTouchNoticeTimer: number | null = null;
let activeGeneratedPsdId = '';

const layerDropIndicator = document.createElement('li');
layerDropIndicator.className = 'layer-drop-indicator';
layerDropIndicator.setAttribute('aria-hidden', 'true');
const layerDropIndicatorLabel = document.createElement('span');
layerDropIndicatorLabel.textContent = 'ここに移動';
layerDropIndicator.append(layerDropIndicatorLabel);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const MOTION_PRESETS: Record<Exclude<MotionPreset, 'custom'>, UiMotionTuning> = {
  calm: {
    intensity: 0.65,
    idleScale: 0.6,
    breathScale: 0.75,
    hairWindScale: 0.5,
    hairAmplitudeScale: 0.65,
    hairSoftnessScale: 0.7,
    dragScale: 0.7,
  },
  standard: {
    intensity: 1,
    ...DEFAULT_ANIME25_MOTION_TUNING,
  },
  active: {
    intensity: 1.15,
    idleScale: 1.15,
    breathScale: 1.1,
    hairWindScale: 1.2,
    hairAmplitudeScale: 1.15,
    hairSoftnessScale: 1.05,
    dragScale: 1.15,
  },
};

const PRESET_LABELS: Record<MotionPreset, string> = {
  calm: 'おだやか',
  standard: '標準',
  active: 'よく動く',
  custom: 'カスタム',
};

const tuningKeys: Record<TuningInputId, keyof UiMotionTuning> = {
  'motion-intensity': 'intensity',
  'idle-scale': 'idleScale',
  'breath-scale': 'breathScale',
  'hair-wind-scale': 'hairWindScale',
  'hair-amplitude-scale': 'hairAmplitudeScale',
  'hair-softness-scale': 'hairSoftnessScale',
  'drag-scale': 'dragScale',
};

const PARAMETER_GROUP_LABELS: Record<PsdMotionParameterGroup, string> = {
  face: '姿勢・上半身',
  eyes: '目・眉',
  mouth: '口',
  physics: '髪・物理',
};

const PARAMETER_LABELS: Partial<Record<PsdMotionParameterName, string>> = {
  angleX: '顔の左右向き',
  angleY: '顔の上下向き',
  angleZ: '顔の傾き',
  body: '上半身の傾き',
  armY: '腕の上下',
  armPos: '腕の位置',
  eyeOpenL: '左目の開き',
  eyeOpenR: '右目の開き',
  eyeX: '視線の左右',
  eyeY: '視線の上下',
  irisScale: '瞳の大きさ',
  eyeEase: '目の変形の滑らかさ',
  eyeCY: '目の中心位置',
  eyeCAng: '目の傾き',
  eyeScaleL: '左目の大きさ',
  eyeScaleR: '右目の大きさ',
  brow: '眉の高さ',
  browAngL: '左眉の角度',
  browAngR: '右眉の角度',
  browAngSym: '眉の対称角度',
  mouthOpen: '口の開き',
  mouthForm: '口の形',
  mouthCY: '口の中心位置',
  mouthEase: '口の変形の滑らかさ',
  mouthCAng: '口の傾き',
  mouthScale: '口の大きさ',
  physAmp: '髪全体の揺れ幅',
  soft: '髪全体の柔らかさ',
  fhAmp: '前髪の揺れ幅',
  fhSoft: '前髪の柔らかさ',
  bangL: '左前髪の位置',
  bangC: '中央前髪の位置',
  bangR: '右前髪の位置',
  bust: '胸元の揺れ幅',
  bustY: '胸元の中心位置',
};

const BASIC_PARAMETER_KEYS = new Set<PsdMotionParameterName>([
  'eyeOpenL',
  'eyeOpenR',
  'mouthOpen',
]);

interface AdvancedParameterControl {
  definition: PsdMotionParameterDefinition;
  range: HTMLInputElement;
  number: HTMLInputElement;
}

const advancedControls = new Map<PsdMotionParameterName, AdvancedParameterControl>();

function formatParameterValue(value: number, step: number): string {
  const decimals = String(step).split('.')[1]?.length ?? 0;
  return value.toFixed(decimals);
}

function normalizeParameterValue(
  definition: PsdMotionParameterDefinition,
  value: number,
): number {
  const clamped = clampValue(
    Number.isFinite(value) ? value : DEFAULT_PSD_MOTION_PARAMETERS[definition.key],
    definition.min,
    definition.max,
  );
  const steps = Math.round((clamped - definition.min) / definition.step);
  return Number((definition.min + steps * definition.step).toFixed(6));
}

function syncAdvancedParameterControl(name: PsdMotionParameterName): void {
  const control = advancedControls.get(name);
  if (!control) return;
  const formatted = formatParameterValue(
    profileParameters[name],
    control.definition.step,
  );
  control.range.value = formatted;
  control.number.value = formatted;
}

function applyProfileParameter(
  definition: PsdMotionParameterDefinition,
  value: number,
  announce = true,
): void {
  profileParameters = {
    ...profileParameters,
    [definition.key]: normalizeParameterValue(definition, value),
  };
  syncAdvancedParameterControl(definition.key);
  applyAvatarMotionMode(currentMode);
  if (announce) {
    api.setLabel(
      '細かい設定を変更',
      `${PARAMETER_LABELS[definition.key] ?? definition.label}を${formatParameterValue(profileParameters[definition.key], definition.step)}に設定しました。`,
      0,
    );
  }
}

function resetAdvancedProfileParameters(): void {
  profileParameters = { ...DEFAULT_PSD_MOTION_PARAMETERS };
  for (const name of advancedControls.keys()) syncAdvancedParameterControl(name);
  applyAvatarMotionMode(currentMode);
  api.setLabel('細かい設定を元に戻しました', 'すべて最初の値に戻しました。', 0);
}

function createAdvancedParameterControls(): void {
  const definitions = PSD_MOTION_PARAMETER_DEFINITIONS.filter(
    (definition) => !BASIC_PARAMETER_KEYS.has(definition.key),
  );
  for (const group of ['face', 'eyes', 'mouth', 'physics'] as const) {
    const groupDefinitions = definitions.filter((definition) => definition.group === group);
    const details = document.createElement('details');
    details.className = 'parameter-group';
    details.dataset.parameterGroup = group;
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = PARAMETER_GROUP_LABELS[group];
    const count = document.createElement('span');
    count.className = 'parameter-count';
    count.textContent = `${groupDefinitions.length}項目`;
    summary.append(label, count);
    const grid = document.createElement('div');
    grid.className = 'parameter-grid';
    for (const definition of groupDefinitions) {
      const item = document.createElement('label');
      item.className = 'advanced-item';
      const heading = document.createElement('span');
      heading.className = 'field-head';
      const name = document.createElement('span');
      name.textContent = PARAMETER_LABELS[definition.key] ?? definition.label;
      const defaultValue = document.createElement('span');
      defaultValue.className = 'parameter-default';
      defaultValue.textContent = `最初の値 ${formatParameterValue(DEFAULT_PSD_MOTION_PARAMETERS[definition.key], definition.step)}`;
      heading.append(name, defaultValue);
      const inputRow = document.createElement('span');
      inputRow.className = 'parameter-input-row';
      const range = document.createElement('input');
      range.type = 'range';
      range.id = `parameter-${definition.key}`;
      range.min = String(definition.min);
      range.max = String(definition.max);
      range.step = String(definition.step);
      const number = document.createElement('input');
      number.type = 'number';
      number.id = `parameter-${definition.key}-number`;
      number.className = 'parameter-number';
      number.min = String(definition.min);
      number.max = String(definition.max);
      number.step = String(definition.step);
      number.setAttribute('aria-label', `${name.textContent}の数値`);
      advancedControls.set(definition.key, { definition, range, number });
      syncAdvancedParameterControl(definition.key);
      const update = (input: HTMLInputElement) => {
        demoToken += 1;
        applyProfileParameter(definition, Number(input.value));
      };
      range.addEventListener('input', () => update(range));
      number.addEventListener('change', () => update(number));
      inputRow.append(range, number);
      item.htmlFor = range.id;
      item.append(heading, inputRow);
      grid.append(item);
    }
    details.append(summary, grid);
    advancedParameterGroups.append(details);
  }
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function layerOrderSignature(order: readonly string[]): string {
  return order.join('\n');
}

function hasUnsavedLayerChanges(): boolean {
  return (
    currentLayerOrder.length > 0 &&
    layerOrderSignature(currentLayerOrder) !== savedLayerOrderSignature
  );
}

function selectedEditableLayer(): EditablePsdLayer | null {
  return editableLayers.find((layer) => layer.id === selectedLayerId) ?? null;
}

function editableLayerByName(name: string): EditablePsdLayer | null {
  const normalized = name.toLowerCase();
  return (
    editableLayers.find((layer) => layer.name.toLowerCase() === normalized) ?? null
  );
}

function layerSymbol(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes('hair')) return '⌁';
  if (normalized.includes('eye') || normalized === 'irides') return '◉';
  if (normalized.includes('mouth')) return '◡';
  if (normalized === 'handwear') return '✦';
  if (normalized.includes('wear')) return '◇';
  if (normalized === 'face') return '○';
  return '◆';
}

function announceLayerEdit(message: string): void {
  layerEditStatus.dataset.state = '';
  layerEditStatus.textContent = message;
  layerEditLiveRegion.textContent = '';
  window.setTimeout(() => {
    layerEditLiveRegion.textContent = message;
  }, 20);
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function syncLayerProcessingBounds(): void {
  const canvasRect = canvas.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  layerProcessingOverlay.style.left = `${canvasRect.left - stageRect.left}px`;
  layerProcessingOverlay.style.top = `${canvasRect.top - stageRect.top}px`;
  layerProcessingOverlay.style.width = `${canvasRect.width}px`;
  layerProcessingOverlay.style.height = `${canvasRect.height}px`;
}

async function beginLayerProcessing(title: string, detail: string): Promise<void> {
  layerProcessingActive = true;
  layerProcessingStartedAt = performance.now();
  layerProcessingTitle.textContent = title;
  layerProcessingDetail.textContent = detail;
  syncLayerProcessingBounds();
  document.body.dataset.layerProcessing = 'true';
  layerProcessingOverlay.setAttribute('aria-hidden', 'false');
  canvas.setAttribute('aria-busy', 'true');
  stage.setAttribute('aria-busy', 'true');
  await waitForAnimationFrame();
  await waitForAnimationFrame();
}

async function updateLayerProcessing(title: string, detail: string): Promise<void> {
  if (!layerProcessingActive) return;
  layerProcessingTitle.textContent = title;
  layerProcessingDetail.textContent = detail;
  await waitForAnimationFrame();
}

async function finishLayerProcessing(): Promise<void> {
  if (!layerProcessingActive) return;
  const wasLongEnoughToShow = performance.now() - layerProcessingStartedAt >= 180;
  if (wasLongEnoughToShow) {
    await waitForAnimationFrame();
    await delay(140);
  }
  layerProcessingActive = false;
  document.body.dataset.layerProcessing = 'false';
  layerProcessingOverlay.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('aria-busy', 'false');
  stage.setAttribute('aria-busy', 'false');
}

function clearLayerFocus(): void {
  if (layerFocusTimer !== null) {
    window.clearTimeout(layerFocusTimer);
    layerFocusTimer = null;
  }
  avatar?.setLayerFocus(null);
}

function flashLayerFocus(name: string): void {
  clearLayerFocus();
  const focusedAvatar = avatar;
  if (!focusedAvatar) return;
  focusedAvatar.setLayerFocus(name);
  layerFocusTimer = window.setTimeout(() => {
    focusedAvatar.setLayerFocus(null);
    layerFocusTimer = null;
  }, 800);
}

function hideCanvasPickMenu(hideMarker = false): void {
  canvasPickMenu.hidden = true;
  canvasPickOptions.replaceChildren();
  if (hideMarker) canvasSelectionMarker.hidden = true;
}

function positionCanvasFeedback(clientX: number, clientY: number): void {
  const stageRect = stage.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const markerX = clampValue(clientX - stageRect.left, canvasRect.left - stageRect.left, canvasRect.right - stageRect.left);
  const markerY = clampValue(clientY - stageRect.top, canvasRect.top - stageRect.top, canvasRect.bottom - stageRect.top);
  canvasSelectionMarker.style.left = `${markerX}px`;
  canvasSelectionMarker.style.top = `${markerY}px`;
  canvasSelectionMarker.hidden = false;

  canvasPickMenu.style.left = '0px';
  canvasPickMenu.style.top = '0px';
  const menuWidth = canvasPickMenu.offsetWidth;
  const menuHeight = canvasPickMenu.offsetHeight;
  const left = clampValue(markerX + 18, 12, Math.max(12, stageRect.width - menuWidth - 12));
  const preferredTop = markerY + 24;
  const top = preferredTop + menuHeight <= stageRect.height - 12
    ? preferredTop
    : Math.max(12, markerY - menuHeight - 24);
  canvasPickMenu.style.left = `${left}px`;
  canvasPickMenu.style.top = `${top}px`;
}

function setSelectedLayer(
  id: string,
  point?: { clientX: number; clientY: number },
): void {
  selectedLayerId = id;
  const selected = selectedEditableLayer();
  if (!selected) return;
  if (point) positionCanvasFeedback(point.clientX, point.clientY);
  else canvasSelectionMarker.hidden = true;
  renderLayerEditor();
  selectedPartBadge.textContent = `選択中：${selected.label}`;
  selectedPartBadge.hidden = workspaceMode !== 'layers';
  avatar?.setMotionEnabled(false);
  avatar?.setMouthOpen(selected.name.toLowerCase() === 'mouth_open' ? 1 : 0);
  avatar?.setEyeOpen(selected.name.toLowerCase() === 'eye_close' ? 0 : 1);
  flashLayerFocus(selected.name.toLowerCase());
  announceLayerEdit(`${selected.label}を選びました。水色の印と、明るく表示された部分を確認してください。`);
  if (layerOrderDetails.open) {
    window.requestAnimationFrame(() => {
      layerOrderList
        .querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(selected.id)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }
}

function editableHitCandidates(names: readonly string[]): EditablePsdLayer[] {
  const matches: EditablePsdLayer[] = [];
  for (const name of names) {
    const match = editableLayerByName(name);
    if (match && !matches.some((candidate) => candidate.id === match.id)) matches.push(match);
  }
  return matches;
}

function pickLayerFromCanvas(clientX: number, clientY: number): void {
  if (!avatar || workspaceMode !== 'layers' || layerEditBusy) return;
  if (showingOriginal) {
    announceLayerEdit('変更前を表示中です。「修正後に戻す」を押すと、部分を選べます。');
    return;
  }
  const point = canvasPoint(clientX, clientY);
  const candidates = editableHitCandidates(avatar.pickLayersAt(point.x, point.y));
  canvasPickOptions.replaceChildren();
  canvasPickMenu.hidden = false;
  if (candidates.length === 0) {
    canvasSelectionMarker.hidden = true;
    canvasPickTitle.textContent = 'ここには選べる部分がありません';
    canvasPickCopy.textContent = '人物の色がある場所をクリックするか、右側の「一覧から選ぶ」を使ってください。';
    positionCanvasFeedback(clientX, clientY);
    canvasSelectionMarker.hidden = true;
    announceLayerEdit('ここには選べる部分がありません。人物の色がある場所か、一覧から選んでください。');
    return;
  }

  const first = candidates[0]!;
  setSelectedLayer(first.id, { clientX, clientY });
  if (candidates.length === 1) {
    canvasPickMenu.hidden = true;
    return;
  }

  canvasPickTitle.textContent = `この場所には${candidates.length}個の部分があります`;
  canvasPickCopy.textContent = '明るくしたい部分を選んでください。手前にある順です。';
  for (const candidate of candidates) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = candidate.label;
    button.setAttribute('aria-pressed', String(candidate.id === first.id));
    button.addEventListener('click', () => {
      setSelectedLayer(candidate.id, { clientX, clientY });
      hideCanvasPickMenu();
    });
    canvasPickOptions.append(button);
  }
  positionCanvasFeedback(clientX, clientY);
}

function renderCommonFixes(): void {
  commonFixesList.replaceChildren();
  const fixes = [
    {
      subject: 'handwear',
      reference: 'topwear',
      label: '腕・手',
      front: '服の手前にする',
      back: '服の奥にする',
    },
    {
      subject: 'front hair',
      reference: 'face',
      label: '前髪',
      front: '顔の手前にする',
      back: '顔の奥にする',
    },
  ];
  for (const fix of fixes) {
    const subject = editableLayerByName(fix.subject);
    const reference = editableLayerByName(fix.reference);
    if (!subject || !reference) continue;
    const subjectIndex = currentLayerOrder.indexOf(subject.id);
    const referenceIndex = currentLayerOrder.indexOf(reference.id);
    const row = document.createElement('div');
    row.className = 'common-fix-row';
    const label = document.createElement('div');
    label.className = 'common-fix-label';
    label.textContent = fix.label;
    const actions = document.createElement('div');
    actions.className = 'common-fix-actions';
    for (const option of [
      { text: fix.front, front: true },
      { text: fix.back, front: false },
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.text;
      button.setAttribute(
        'aria-pressed',
        String(option.front ? subjectIndex > referenceIndex : subjectIndex < referenceIndex),
      );
      button.disabled = layerEditBusy || showingOriginal;
      button.addEventListener('click', () => {
        hideCanvasPickMenu(true);
        void moveLayerRelative(subject.id, reference.id, option.front);
      });
      actions.append(button);
    }
    row.append(label, actions);
    commonFixesList.append(row);
  }
  commonFixes.hidden = commonFixesList.childElementCount === 0;
}

function clearLayerOrderDragUi(): void {
  draggedLayerId = null;
  layerDropIndicator.remove();
  document.body.dataset.layerOrderDragging = 'false';
  for (const row of layerOrderList.querySelectorAll<HTMLElement>('.layer-order-item')) {
    row.setAttribute('aria-grabbed', 'false');
  }
}

function showLayerOrderTouchNotice(): void {
  layerOrderTouchNotice.hidden = false;
  if (layerTouchNoticeTimer !== null) window.clearTimeout(layerTouchNoticeTimer);
  layerTouchNoticeTimer = window.setTimeout(() => {
    layerOrderTouchNotice.hidden = true;
    layerTouchNoticeTimer = null;
  }, 6000);
}

function updateLayerDropIndicator(clientY: number): void {
  if (!draggedLayerId) return;
  layerDropIndicator.remove();
  const rows = [...layerOrderList.querySelectorAll<HTMLElement>('.layer-order-item')]
    .filter((row) => row.dataset.layerId !== draggedLayerId);
  const nextRow = rows.find((row) => {
    const rect = row.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2;
  });
  if (nextRow) layerOrderList.insertBefore(layerDropIndicator, nextRow);
  else layerOrderList.append(layerDropIndicator);
}

function droppedLayerDisplayOrder(): string[] | null {
  if (!draggedLayerId || !layerDropIndicator.isConnected) return null;
  const nextDisplayOrder: string[] = [];
  for (const child of layerOrderList.children) {
    if (child === layerDropIndicator) nextDisplayOrder.push(draggedLayerId);
    else if (child instanceof HTMLElement && child.dataset.layerId !== draggedLayerId) {
      const id = child.dataset.layerId;
      if (id) nextDisplayOrder.push(id);
    }
  }
  return nextDisplayOrder;
}

function renderLayerOrder(): void {
  clearLayerOrderDragUi();
  layerOrderList.replaceChildren();
  const displayOrder = [...currentLayerOrder].reverse();
  for (const id of displayOrder) {
    const layer = editableLayers.find((candidate) => candidate.id === id);
    if (!layer) continue;
    const item = document.createElement('li');
    item.className = 'layer-order-item';
    item.tabIndex = 0;
    item.draggable = false;
    item.dataset.layerId = layer.id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(layer.id === selectedLayerId));
    item.setAttribute('aria-grabbed', 'false');
    item.setAttribute('aria-label', `${layer.label}。選択して手前または奥へ移動できます。`);

    const symbol = document.createElement('span');
    symbol.className = 'layer-symbol';
    symbol.textContent = layerSymbol(layer.name);
    const copy = document.createElement('span');
    copy.className = 'layer-item-copy';
    const label = document.createElement('strong');
    label.textContent = layer.label;
    const position = document.createElement('span');
    position.textContent = `手前から${displayOrder.indexOf(id) + 1}番目`;
    copy.append(label, position);
    const handle = document.createElement('span');
    handle.className = 'layer-drag-handle';
    handle.draggable = !layerEditBusy && !showingOriginal;
    handle.title = 'ドラッグして並べ替える（PCのみ）';
    handle.setAttribute('aria-label', `${layer.label}をドラッグして並べ替える（PCのみ）`);
    handle.textContent = '⠿';
    item.append(symbol, copy, handle);

    const select = () => {
      hideCanvasPickMenu(true);
      setSelectedLayer(layer.id);
    };
    item.addEventListener('click', select);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
    handle.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch') return;
      event.stopPropagation();
      showLayerOrderTouchNotice();
    });
    handle.addEventListener('dragstart', (event) => {
      if (layerEditBusy || showingOriginal) {
        event.preventDefault();
        return;
      }
      if (!event.dataTransfer) return;
      hideCanvasPickMenu(true);
      selectedLayerId = layer.id;
      for (const row of layerOrderList.querySelectorAll<HTMLElement>('.layer-order-item')) {
        row.setAttribute('aria-selected', String(row === item));
      }
      selectedLayerCard.dataset.hasSelection = 'true';
      selectedLayerName.textContent = layer.label;
      selectedLayerHelp.textContent = '移動中です。水色の線が表示された場所で離してください。';
      selectedPartBadge.textContent = `選択中：${layer.label}`;
      selectedPartBadge.hidden = workspaceMode !== 'layers';
      draggedLayerId = layer.id;
      document.body.dataset.layerOrderDragging = 'true';
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', layer.id);
      const preview = item.cloneNode(true) as HTMLElement;
      preview.classList.add('layer-order-drag-preview');
      preview.setAttribute('aria-grabbed', 'false');
      preview.style.width = `${item.getBoundingClientRect().width}px`;
      document.body.append(preview);
      event.dataTransfer.setDragImage(preview, 32, 26);
      window.setTimeout(() => preview.remove(), 0);
      item.setAttribute('aria-grabbed', 'true');
      announceLayerEdit(`${layer.label}を移動中です。水色の線が表示された場所で離してください。`);
    });
    handle.addEventListener('dragend', () => {
      const wasDragging = draggedLayerId !== null;
      clearLayerOrderDragUi();
      if (wasDragging && !layerEditBusy) renderLayerEditor();
    });
    layerOrderList.append(item);
  }
}

function renderLayerWarning(): void {
  const hand = editableLayerByName('handwear');
  const top = editableLayerByName('topwear');
  if (
    hand &&
    top &&
    currentLayerOrder.indexOf(hand.id) > currentLayerOrder.indexOf(top.id)
  ) {
    layerWarning.textContent =
      '腕・手を服より手前にしています。手先は直っても、肩まわりまで手前に出ることがあります。プレビューで確認してください。';
    layerWarning.hidden = false;
    return;
  }
  layerWarning.hidden = true;
}

function renderLayerEditor(): void {
  const selected = selectedEditableLayer();
  const selectedIndex = selected ? currentLayerOrder.indexOf(selected.id) : -1;
  const changed = hasUnsavedLayerChanges();
  selectedLayerCard.dataset.hasSelection = String(Boolean(selected));
  selectedLayerName.textContent = selected?.label ?? 'まだ選んでいません';
  selectedLayerHelp.textContent = selected
    ? '水色の印で選んだ部分です。下のボタンで重なりを調整できます。'
    : '左の人物をクリックすると、ここに部分の名前が表示されます。';
  moveLayerFront.disabled =
    layerEditBusy || showingOriginal || selectedIndex < 0 || selectedIndex >= currentLayerOrder.length - 1;
  moveLayerBack.disabled = layerEditBusy || showingOriginal || selectedIndex <= 0;
  undoLayerEdit.disabled = layerEditBusy || showingOriginal || layerEditHistory.length === 0;
  resetLayerEdit.disabled =
    layerEditBusy ||
    showingOriginal ||
    layerOrderSignature(currentLayerOrder) === layerOrderSignature(originalLayerOrder);
  beforeAfterToggle.disabled = layerEditBusy || !editedPreviewBuffer;
  beforeAfterToggle.setAttribute('aria-pressed', String(showingOriginal));
  beforeAfterToggle.textContent = !editedPreviewBuffer
    ? '重なりを変更すると比較できます'
    : showingOriginal
      ? '修正後に戻す'
      : '元の見た目を表示';
  saveLayerEdit.disabled = layerEditBusy || showingOriginal || !changed;
  saveLayerEdit.textContent = changed
    ? '修正版を保存'
    : '重なりを変更すると保存できます';
  layerSaveFile.textContent = sourcePsdFileName
    ? `保存名：${editedPsdFileName(sourcePsdFileName)}`
    : '';
  previewModeBadge.textContent = showingOriginal ? '変更前' : '修正後';
  document.body.dataset.comparisonView = showingOriginal ? 'original' : 'edited';
  layerEditTab.textContent = changed
    ? '重なりを直す・未保存'
    : '重なりを直す';
  layerOrderCount.textContent = String(currentLayerOrder.length);
  openLayerList.setAttribute('aria-expanded', String(layerOrderDetails.open));
  previewModeBadge.hidden = workspaceMode !== 'layers';
  selectedPartBadge.hidden = workspaceMode !== 'layers' || !selected;
  if (selected) selectedPartBadge.textContent = `選択中：${selected.label}`;
  renderCommonFixes();
  renderLayerOrder();
  renderLayerWarning();
}

function initializeLayerEditor(buffer: ArrayBuffer, fileName: string): void {
  sourcePsdBuffer = buffer.slice(0);
  sourcePsdFileName = fileName;
  editedPreviewBuffer = null;
  showingOriginal = false;
  layerEditBusy = false;
  layerEditHistory = [];
  try {
    const summary = inspectEditablePsd(sourcePsdBuffer);
    editableLayers = summary.layers;
    originalLayerOrder = summary.layers.map((layer) => layer.id);
    currentLayerOrder = [...originalLayerOrder];
    savedLayerOrderSignature = layerOrderSignature(originalLayerOrder);
    selectedLayerId = null;
    layerEditTab.disabled = false;
    layerEditorUnavailable.hidden = summary.editable;
    layerEditorContent.hidden = !summary.editable;
    layerEditorUnavailable.textContent = summary.reason ?? '';
  } catch (error) {
    editableLayers = [];
    originalLayerOrder = [];
    currentLayerOrder = [];
    savedLayerOrderSignature = '';
    selectedLayerId = null;
    layerEditTab.disabled = false;
    layerEditorUnavailable.hidden = false;
    layerEditorContent.hidden = true;
    layerEditorUnavailable.textContent =
      error instanceof Error ? error.message : '重なりの情報を読み込めませんでした。';
  }
  hideCanvasPickMenu(true);
  renderLayerEditor();
}

async function refreshEditedPreview(message: string): Promise<void> {
  if (!sourcePsdBuffer) return;
  layerEditBusy = true;
  renderLayerEditor();
  announceLayerEdit('修正後の見た目を準備しています…');
  await beginLayerProcessing(
    '重なりを変更しています',
    'PSDを組み直しています。数秒かかることがあります。',
  );
  try {
    clearLayerFocus();
    const result = buildReorderedPsd(sourcePsdBuffer, currentLayerOrder);
    editedPreviewBuffer = result.buffer;
    showingOriginal = false;
    await updateLayerProcessing(
      '表示を更新しています',
      '修正後のPSDを読み込み、プレビューを整えています。',
    );
    await activatePsd(editedPreviewBuffer, sourcePsdFileName, {
      editorRefresh: true,
      preserveView: true,
    });
    statusNode.textContent = '未保存';
    phaseNode.textContent = '未保存の変更があります';
    detailNode.textContent = message;
    announceLayerEdit(message);
  } finally {
    await finishLayerProcessing();
    layerEditBusy = false;
    renderLayerEditor();
  }
}

async function commitLayerOrder(nextOrder: string[], message: string): Promise<void> {
  if (layerEditBusy || showingOriginal) return;
  if (layerOrderSignature(nextOrder) === layerOrderSignature(currentLayerOrder)) return;
  const previousOrder = [...currentLayerOrder];
  layerEditHistory.push(previousOrder);
  currentLayerOrder = nextOrder;
  try {
    await refreshEditedPreview(message);
  } catch (error) {
    currentLayerOrder = previousOrder;
    layerEditHistory.pop();
    announceLayerEdit(error instanceof Error ? error.message : String(error));
    showLoadError(error);
    renderLayerEditor();
  }
}

async function moveSelectedLayer(direction: 'front' | 'back'): Promise<void> {
  const selected = selectedEditableLayer();
  if (!selected) return;
  const index = currentLayerOrder.indexOf(selected.id);
  const target = direction === 'front' ? index + 1 : index - 1;
  if (target < 0 || target >= currentLayerOrder.length) return;
  const reference = editableLayers.find(
    (layer) => layer.id === currentLayerOrder[target],
  );
  const next = [...currentLayerOrder];
  [next[index], next[target]] = [next[target]!, next[index]!];
  await commitLayerOrder(
    next,
    `${selected.label}を、${reference?.label ?? '隣の部分'}より${direction === 'front' ? '手前へ' : '奥へ'}移動しました。`,
  );
}

async function moveLayerRelative(
  subjectId: string,
  referenceId: string,
  front: boolean,
): Promise<void> {
  const subject = editableLayers.find((layer) => layer.id === subjectId);
  const reference = editableLayers.find((layer) => layer.id === referenceId);
  if (!subject || !reference) return;
  const next = currentLayerOrder.filter((id) => id !== subjectId);
  const referenceIndex = next.indexOf(referenceId);
  next.splice(referenceIndex + (front ? 1 : 0), 0, subjectId);
  selectedLayerId = subjectId;
  await commitLayerOrder(
    next,
    `${subject.label}を、${reference.label}より${front ? '手前へ' : '奥へ'}移動しました。`,
  );
}

async function undoLastLayerEdit(): Promise<void> {
  const previous = layerEditHistory.pop();
  if (!previous) return;
  currentLayerOrder = previous;
  try {
    await refreshEditedPreview('1つ前の重なりに戻しました。');
  } catch (error) {
    announceLayerEdit(error instanceof Error ? error.message : String(error));
  }
}

async function resetLayerEdits(): Promise<void> {
  if (layerOrderSignature(currentLayerOrder) === layerOrderSignature(originalLayerOrder)) return;
  layerEditHistory.push([...currentLayerOrder]);
  currentLayerOrder = [...originalLayerOrder];
  await refreshEditedPreview('今回の変更をすべて取り消しました。');
}

async function toggleOriginalPreview(): Promise<void> {
  if (!sourcePsdBuffer || !editedPreviewBuffer || layerEditBusy) return;
  showingOriginal = !showingOriginal;
  layerEditBusy = true;
  renderLayerEditor();
  await beginLayerProcessing(
    showingOriginal ? '変更前を表示しています' : '修正後を表示しています',
    'PSDを読み込み、プレビューを切り替えています。',
  );
  try {
    await activatePsd(
      showingOriginal ? sourcePsdBuffer : editedPreviewBuffer,
      sourcePsdFileName,
      { editorRefresh: true, preserveView: true },
    );
    announceLayerEdit(
      showingOriginal
        ? '変更前の見た目を表示しています。修正を続けるには「修正後に戻す」を押してください。'
        : '修正後の見た目に戻りました。',
    );
  } finally {
    await finishLayerProcessing();
    layerEditBusy = false;
    renderLayerEditor();
  }
}

async function saveEditedPsd(): Promise<void> {
  if (!sourcePsdBuffer || !hasUnsavedLayerChanges() || layerEditBusy) return;
  layerEditBusy = true;
  renderLayerEditor();
  announceLayerEdit('修正版を作成し、保存後も開けることを確認しています…');
  await beginLayerProcessing(
    '修正版を準備しています',
    'PSDを組み直し、保存後も開けることを確認しています。',
  );
  try {
    const result = buildReorderedPsd(sourcePsdBuffer, currentLayerOrder);
    const fileName = editedPsdFileName(sourcePsdFileName);
    await updateLayerProcessing(
      '保存を開始しています',
      '確認済みの修正版をダウンロードします。',
    );
    const url = URL.createObjectURL(
      new Blob([result.buffer], { type: 'image/vnd.adobe.photoshop' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    savedLayerOrderSignature = layerOrderSignature(currentLayerOrder);
    announceLayerEdit(
      `修正版を保存しました。元のPSDはそのまま残っています。通常はダウンロードフォルダに「${fileName}」があります。`,
    );
    layerEditStatus.dataset.state = 'success';
    statusNode.textContent = '保存済み';
    phaseNode.textContent = '修正版を保存しました';
    detailNode.textContent = '元のPSDは変更されていません。';
  } catch (error) {
    announceLayerEdit(
      `保存できませんでした。元のPSDは変更されていません。${error instanceof Error ? ` ${error.message}` : ''}`,
    );
  } finally {
    await finishLayerProcessing();
    layerEditBusy = false;
    renderLayerEditor();
  }
}

function confirmDiscardLayerChanges(): boolean {
  if (!hasUnsavedLayerChanges()) return true;
  return window.confirm(
    'まだ保存していない変更があります。\n\n「キャンセル」で編集に戻ります。「OK」で変更を破棄して別のPSDを開きます。',
  );
}

function setWorkspaceMode(mode: WorkspaceMode): void {
  if (mode === 'layers' && layerEditTab.disabled) return;
  workspaceMode = mode;
  document.body.dataset.workspaceMode = mode;
  motionTab.setAttribute('aria-selected', String(mode === 'motion'));
  layerEditTab.setAttribute('aria-selected', String(mode === 'layers'));
  motionPanel.hidden = mode !== 'motion';
  layerEditPanel.hidden = mode !== 'layers';
  previewModeBadge.hidden = mode !== 'layers';
  selectedPartBadge.hidden = mode !== 'layers' || !selectedEditableLayer();
  demoToken += 1;
  if (mode === 'layers') {
    cameraControls?.stop();
    avatar?.setMotionEnabled(false);
    avatar?.setEyeOpen(1);
    avatar?.setMouthOpen(0);
    clearLayerFocus();
    statusNode.textContent = hasUnsavedLayerChanges() ? '未保存' : '変更なし';
    phaseNode.textContent = hasUnsavedLayerChanges()
      ? '未保存の変更があります'
      : '重なりを修正できます';
    detailNode.textContent = '人物の直したい部分をクリックし、「手前へ」「奥へ」で調整してください。';
  } else {
    hideCanvasPickMenu(true);
    clearLayerFocus();
    applyAvatarMotionMode(currentMode);
    statusNode.textContent = '準備完了';
    phaseNode.textContent = 'PSD読み込み完了';
    detailNode.textContent = '「動きを自動チェック」または個別の操作を試せます。';
  }
  renderLayerEditor();
}

function syncMotionTuningControls(): void {
  for (const id of tuningInputIds) {
    const key = tuningKeys[id];
    const percent = Math.round(motionTuning[key] * 100);
    tuningInputs[id]!.value = String(percent);
    tuningOutputs[id]!.value = `${percent}%`;
  }
  tuningPresetValue.value = PRESET_LABELS[currentPreset];
  for (const button of presetButtons) {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.motionPreset === currentPreset),
    );
  }
}

function applyMotionTuning(
  value: Partial<UiMotionTuning>,
  preset: MotionPreset = 'custom',
): void {
  motionTuning = {
    intensity: clampValue(value.intensity ?? motionTuning.intensity, 0, 1.5),
    idleScale: clampValue(value.idleScale ?? motionTuning.idleScale, 0, 1.5),
    breathScale: clampValue(value.breathScale ?? motionTuning.breathScale, 0, 1.5),
    hairWindScale: clampValue(value.hairWindScale ?? motionTuning.hairWindScale, 0, 1.5),
    hairAmplitudeScale: clampValue(
      value.hairAmplitudeScale ?? motionTuning.hairAmplitudeScale,
      0,
      1.5,
    ),
    hairSoftnessScale: clampValue(
      value.hairSoftnessScale ?? motionTuning.hairSoftnessScale,
      0,
      1.2,
    ),
    dragScale: clampValue(value.dragScale ?? motionTuning.dragScale, 0, 1.5),
  };
  currentPreset = preset;
  avatar?.setIntensity(motionTuning.intensity);
  avatar?.setMotionTuning(motionTuning);
  syncMotionTuningControls();
}

function syncControls(): void {
  eyeControl.value = String(Math.round(eyeOpen * 100));
  mouthControl.value = String(Math.round(mouthOpen * 100));
  eyeValue.value = `${eyeControl.value}%`;
  mouthValue.value = `${mouthControl.value}%`;
  zoomControl.value = String(Math.round(viewScale * 100));
  zoomValue.value = `${zoomControl.value}%`;
}

function syncBlinkControls(): void {
  const label = autoBlinkEnabled ? 'ON' : 'OFF';
  blinkToggle.textContent = label;
  blinkToggle.setAttribute('aria-pressed', String(autoBlinkEnabled));
  blinkValue.value = label;
}

function syncViewTransform(): void {
  avatar?.setViewTransform(viewOffsetX, viewOffsetY, viewScale);
  zoomControl.value = String(Math.round(viewScale * 100));
  zoomValue.value = `${zoomControl.value}%`;
}

function setProgress(progress: number): void {
  const normalized = Math.max(0, Math.min(1, progress));
  progressNode.style.width = `${normalized * 100}%`;
  progressTrack.setAttribute('aria-valuenow', String(Math.round(normalized * 100)));
}

function setViewScale(nextScale: number, origin?: { x: number; y: number }): void {
  const scale = Math.max(0.5, Math.min(2, nextScale));
  if (origin && Math.abs(scale - viewScale) > 1e-6) {
    const ratio = scale / viewScale;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    viewOffsetX = origin.x - centerX - (origin.x - centerX - viewOffsetX) * ratio;
    viewOffsetY = origin.y - centerY - (origin.y - centerY - viewOffsetY) * ratio;
  }
  viewScale = scale;
  syncViewTransform();
}

function canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * canvas.width,
    y: ((clientY - rect.top) / rect.height) * canvas.height,
  };
}

function applyAvatarMotionMode(mode: QaMode): void {
  if (!avatar) return;
  const profile: PsdMotionProfile = createDefaultPsdMotionProfile();
  profile.parameters = {
    ...profileParameters,
    eyeOpenL: eyeOpen,
    eyeOpenR: eyeOpen,
    mouthOpen: 0,
  };
  profile.automation = {
    idle: mode === 'idle-physics',
    randomMotion: false,
    blink: autoBlinkEnabled,
    physics: mode !== 'static',
  };
  avatar.setMotionEnabled(true);
  avatar.setIntensity(motionTuning.intensity);
  avatar.setMotionTuning(motionTuning);
  avatar.setMotionProfile(profile);
  avatar.setEyeOpen(autoBlinkEnabled ? null : eyeOpen);
  avatar.setMouthOpen(mouthOpen);
}

function selectMode(mode: QaMode): void {
  currentMode = mode;
  api.setMode(mode);
  for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  const labels: Record<QaMode, string> = { static: '静止表示', physics: '髪揺れ', 'idle-physics': '全身＋髪' };
  const details: Record<QaMode, string> = {
    static: '自動まばたき以外のモーションを止めます。',
    physics: '顔と胴体を固定し、髪だけを動かします。',
    'idle-physics': '呼吸・上半身・髪をまとめて動かします。',
  };
  api.setLabel(labels[mode], details[mode], 0);
}

async function runDemo(): Promise<void> {
  const token = ++demoToken;
  selectMode('static');
  api.setLabel('動きを自動チェック', '口 → まばたき → 髪揺れ → 全身＋髪', 0.05);
  for (let cycle = 0; cycle < 2 && token === demoToken; cycle += 1) {
    for (let step = 0; step <= 10 && token === demoToken; step += 1) { api.setState(1, step / 10); syncControls(); await delay(55); }
    for (let step = 9; step >= 0 && token === demoToken; step -= 1) { api.setState(1, step / 10); syncControls(); await delay(55); }
  }
  api.setLabel('動きを自動チェック', 'まばたきを確認中', 0.35);
  for (let cycle = 0; cycle < 2 && token === demoToken; cycle += 1) {
    for (let step = 10; step >= 0 && token === demoToken; step -= 1) { api.setState(step / 10, 0); syncControls(); await delay(42); }
    await delay(160);
    for (let step = 1; step <= 10 && token === demoToken; step += 1) { api.setState(step / 10, 0); syncControls(); await delay(42); }
  }
  if (token !== demoToken) return;
  api.setState(1, 0); syncControls(); selectMode('physics'); api.setLabel('動きを自動チェック', '髪揺れを確認中', 0.62); await delay(3500);
  if (token !== demoToken) return;
  selectMode('idle-physics'); api.setLabel('動きを自動チェック', '全身＋髪を確認中', 0.82); await delay(5000);
  if (token !== demoToken) return;
  selectMode('static'); api.setLabel('自動チェック完了', '続けて個別の操作を試せます。', 1);
}

const api: RigQaApi = {
  setTrackingInput(input, weight) { avatar?.setTrackingInput(input, weight); },
  getCameraState() { return cameraControls?.getState() ?? { state: 'off', active: false, liveTracks: 0 }; },
  ready: false,
  error: null,
  summary: null,
  anchors: {},
  setState(nextEyeOpen, nextMouthOpen) {
    const previousEyeOpen = eyeOpen;
    eyeOpen = Math.max(0, Math.min(1, nextEyeOpen));
    mouthOpen = Math.max(0, Math.min(1, nextMouthOpen));
    if (avatar && autoBlinkEnabled && Math.abs(previousEyeOpen - eyeOpen) > 1e-6) {
      applyAvatarMotionMode(currentMode);
    } else {
      avatar?.setEyeOpen(autoBlinkEnabled ? null : eyeOpen);
    }
    avatar?.setMouthOpen(mouthOpen);
  },
  setMode(mode) {
    currentMode = mode;
    applyAvatarMotionMode(mode);
  },
  setAutoBlink(enabled) {
    autoBlinkEnabled = enabled;
    syncBlinkControls();
    applyAvatarMotionMode(currentMode);
  },
  getAutoBlink() { return autoBlinkEnabled; },
  getEyeOpen() { return avatar?.getEyeOpen() ?? { left: eyeOpen, right: eyeOpen }; },
  setLabel(phase, detail = '', progress = 0) {
    phaseNode.textContent = phase;
    detailNode.textContent = detail;
    setProgress(progress);
  },
  setBackground(mode) {
    document.body.dataset.qaBackground = mode === 'solid' ? 'solid' : 'checker';
  },
  setViewTransform(offsetX, offsetY, scale) {
    viewOffsetX = offsetX;
    viewOffsetY = offsetY;
    viewScale = Math.max(0.5, Math.min(2, scale));
    syncViewTransform();
  },
  getViewTransform() { return { offsetX: viewOffsetX, offsetY: viewOffsetY, scale: viewScale }; },
  getDragMotion() { return avatar?.getDragMotion() ?? { x: 0, y: 0 }; },
  setMotionTuning(value) { applyMotionTuning(value); },
  getMotionTuning() { return { ...motionTuning }; },
  setProfileParameter(name, value) {
    const definition = PSD_MOTION_PARAMETER_DEFINITIONS.find(
      (candidate) => candidate.key === name,
    );
    if (!definition || BASIC_PARAMETER_KEYS.has(name)) return;
    applyProfileParameter(definition, value, false);
  },
  getProfileParameters() { return { ...profileParameters }; },
  resetProfileParameters() { resetAdvancedProfileParameters(); },
  getAverageFps() { return avatar?.getAverageFps() ?? 0; },
  setWorkspaceMode(mode) { setWorkspaceMode(mode); },
  async setLayerProcessingPreview(active) {
    if (active) {
      await beginLayerProcessing(
        '重なりを変更しています',
        'PSDを組み直しています。数秒かかることがあります。',
      );
    } else {
      await finishLayerProcessing();
    }
  },
  getLayerEditorState() {
    return {
      mode: workspaceMode,
      originalOrder: [...originalLayerOrder],
      currentOrder: [...currentLayerOrder],
      selectedLayer: selectedEditableLayer()?.name ?? null,
      layerFocus: avatar?.getLayerFocus() ?? null,
      dirty: hasUnsavedLayerChanges(),
      showingOriginal,
    };
  },
};
window.rigQa = api;

function setLoadingState(fileName: string): void {
  demoToken += 1;
  api.error = null;
  statusNode.textContent = '読込中';
  phaseNode.textContent = 'PSDを読み込み中';
  detailNode.textContent = `${fileName} をブラウザ内で解析しています。`;
  setProgress(0.36);
  document.body.dataset.fileLoadState = 'loading';
}

function showLoadError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  api.error = message;
  api.ready = Boolean(avatar);
  statusNode.textContent = avatar ? '表示中・読込エラー' : '読込エラー';
  phaseNode.textContent = 'PSDを読み込めませんでした';
  detailNode.textContent = avatar
    ? `${message}（現在のモデルはそのまま操作できます）`
    : message;
  reportNode.textContent = message;
  setProgress(0);
  document.body.dataset.fileLoadState = 'error';
}

async function activatePsd(
  buffer: ArrayBuffer,
  fileName: string,
  options: { editorRefresh?: boolean; preserveView?: boolean } = {},
): Promise<void> {
  const token = ++loadToken;
  const previousView = { offsetX: viewOffsetX, offsetY: viewOffsetY, scale: viewScale };
  if (!options.editorRefresh) setLoadingState(fileName);
  const detection = await detectAnime25RigFromBuffer(buffer);
  if (token !== loadToken) return;
  if (!detection.usable || !detection.rig || !detection.summary) {
    throw new Error(detection.reason || 'Anime2.5リグとして利用できないPSDです。');
  }

  const nextAvatar = createAnime25RigAvatar(canvas, detection.rig);
  if (token !== loadToken) {
    nextAvatar.dispose();
    return;
  }
  const previousAvatar = avatar;
  clearLayerFocus();
  cameraControls?.stop();
  avatar = nextAvatar;
  previousAvatar?.dispose();

  viewOffsetX = options.preserveView ? previousView.offsetX : 0;
  viewOffsetY = options.preserveView ? previousView.offsetY : 0;
  viewScale = options.preserveView ? previousView.scale : DEFAULT_VIEW_SCALE;
  dragState = null;
  document.body.dataset.avatarDragging = 'false';
  syncViewTransform();

  api.summary = detection.summary;
  api.anchors = detection.rig.anchors;
  api.error = null;
  api.ready = true;
  modelNode.textContent = fileName;
  document.body.dataset.avatarReady = 'true';
  setAvatarControlsDisabled(false);
  currentMode = 'static';
  if (workspaceMode === 'layers') {
    avatar.setMotionEnabled(false);
    avatar.setEyeOpen(1);
    avatar.setMouthOpen(0);
  } else {
    selectMode('static');
    api.setState(eyeOpen, mouthOpen);
  }
  syncControls();
  if (!options.editorRefresh) statusNode.textContent = '準備完了';
  reportNode.textContent = JSON.stringify({ summary: detection.summary, anchors: detection.rig.anchors }, null, 2);
  if (!options.editorRefresh) {
    api.setLabel('PSD読み込み完了', '「動きを自動チェック」または個別の操作を試せます。', 1);
  }
  document.body.dataset.fileLoadState = 'ready';
}

function isPsdFile(file: File): boolean {
  return /\.psd$/i.test(file.name) || file.type === 'image/vnd.adobe.photoshop';
}

async function loadLocalPsd(file: File): Promise<void> {
  if (!isPsdFile(file)) {
    throw new Error('PSDファイル（.psd）を選択してください。');
  }
  if (!confirmDiscardLayerChanges()) return;
  generatedPsdSelect.value = '';
  activeGeneratedPsdId = '';
  generatedPsdOpenFolder.disabled = true;
  expressionRequestSource = 'local';
  expressionRequestControl.open = false;
  syncExpressionRequestControl();
  const buffer = await file.arrayBuffer();
  initializeLayerEditor(buffer, file.name);
  setWorkspaceMode('motion');
  await activatePsd(buffer, file.name);
}

function generatedPsdLabel(item: GeneratedPsd): string {
  const readiness = item.productionReady === true
    ? '基本チェック済み'
    : item.productionReady === false
      ? '要確認'
      : '';
  return readiness ? `${item.name} · ${readiness}` : item.name;
}

async function loadGeneratedPsd(item: GeneratedPsd): Promise<void> {
  const token = ++loadToken;
  activeGeneratedPsdId = '';
  expressionRequestSource = 'generated';
  syncExpressionRequestControl();
  setLoadingState(item.name);
  const response = await fetch(item.url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`生成済みPSDを読み込めませんでした（${response.status}）。`);
  const buffer = await response.arrayBuffer();
  if (token !== loadToken) return;
  initializeLayerEditor(buffer, item.name);
  setWorkspaceMode('motion');
  await activatePsd(buffer, item.name);
  generatedPsdSelect.value = item.id;
  activeGeneratedPsdId = item.id;
  generatedPsdOpenFolder.disabled = false;
  // Open the panel by default only when the PSD still lacks checked expression art.
  expressionRequestControl.open = Boolean(item.jobId) && item.productionReady !== true;
  syncExpressionRequestControl();
}

function readExpressionRecipient(): ExpressionRecipient {
  try {
    return localStorage.getItem(EXPRESSION_RECIPIENT_KEY) === 'claude' ? 'claude' : 'codex';
  } catch {
    return 'codex';
  }
}

function setExpressionRecipient(recipient: ExpressionRecipient): void {
  expressionRecipient = recipient;
  try {
    localStorage.setItem(EXPRESSION_RECIPIENT_KEY, recipient);
  } catch {
    // The choice is a convenience; the panel still works without storage.
  }
  syncExpressionRequestControl();
}

function syncExpressionRequestControl(): void {
  const item = generatedPsds.find((candidate) => candidate.id === activeGeneratedPsdId);
  const usable = Boolean(item?.jobId);
  const unavailable = !usable && (expressionRequestSource === 'local' || Boolean(item));
  expressionRequestControl.hidden = !usable && !unavailable;
  expressionRequestBody.hidden = !usable;
  if (usable) {
    expressionRequestSummary.textContent = item?.productionReady === true
      ? 'このPSDには閉じた目と開いた口の絵が入っています。絵を描き直したいときに使えます。'
      : 'このPSDには閉じた目と開いた口の絵がまだないため、まばたきや口パクが不自然になります。画像生成でその絵を描き足し、このPSDに組み込めます。';
  } else if (unavailable) {
    expressionRequestSummary.textContent =
      'この機能は、このツールで変換したPSD（上の一覧から選ぶPSD）で使えます。手元から開いたPSDには、絵を組み込むための変換時のデータがありません。';
  }
  for (const button of expressionRecipientButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.recipient === expressionRecipient));
  }
  for (const steps of expressionRecipientSteps) {
    steps.hidden = steps.dataset.recipientSteps !== expressionRecipient;
  }
  expressionRequestDisclosure.hidden = expressionRecipient !== 'codex';
  expressionRequestStatus.textContent = '';
  for (const button of startRecipientButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.startRecipient === expressionRecipient));
  }
  for (const name of startRecipientNames) {
    name.textContent = recipientLabel(expressionRecipient);
  }
  startRequestStatus.textContent = '';
}

function recipientLabel(recipient: ExpressionRecipient): string {
  return recipient === 'codex' ? 'Codex' : 'Claude Code';
}

function startRequestMessage(): string {
  const common = [
    'Google Colab のページを開く・ログインする・GPU（L4）を選ぶのは私が行います。必要になったら、開くページを案内して待ってください。',
    '完成したら、プレビュー画面の一覧に新しいPSDが出ることを確かめ、品質検査の結果を報告してください。',
    '閉じた目と開いた口の絵の画像生成は、私が別に依頼するまで行わないでください。',
    'コミット・pushはしないでください。',
    'チャットに貼り付けた画像は画質が落ちることがあるため、変換には次の場所にある元の画像ファイルを使ってください。',
    '画像ファイルの場所: ',
  ];
  if (expressionRecipient === 'codex') {
    return [
      '$still2rig-psd を使い、私が渡すキャラクター画像から、まばたきと口パクを確認できるPSDを作ってください。',
      'リポジトリの AGENTS.md とスキルの手順に従ってください。',
      ...common,
    ].join('\n');
  }
  return [
    'リポジトリの AGENTS.md と .agents/skills/still2rig-psd/SKILL.md を読み、その手順で、私が渡すキャラクター画像から、まばたきと口パクを確認できるPSDを作ってください。',
    ...common,
  ].join('\n');
}

async function copyStartRequest(): Promise<void> {
  try {
    await navigator.clipboard.writeText(startRequestMessage());
    startRequestStatus.textContent = `依頼文をコピーしました。${recipientLabel(expressionRecipient)}に貼り付け、最後の行に画像ファイルの場所を書き足してください。`;
  } catch {
    startRequestStatus.textContent = 'コピーできませんでした。ブラウザのクリップボード許可を確認してください。';
  }
}

function expressionRequestMessage(item: GeneratedPsd, id: string): string {
  const root = `.still2rig-psd/jobs/${id}`;
  const target = `対象: ${item.name}（変換の識別名: ${id}）。`;
  const prepare = `まず npm run still2rig-psd -- expression-requests ${id} を実行してください。`;
  const results = `${root}/expression-requests/results/eye_close.png と mouth_open.png`;
  const finish = [
    `npm run still2rig-psd -- import-expressions ${id} を実行し、取り込みが通ったら npm run still2rig-psd -- repair ${id} --expressions ${root}/generated-expressions を実行してください。`,
    '前回の修復で使った差し替え画像は自動で引き継がれます。引き継いだ内容も実行結果で確認してください。',
    '既存の品質検査の結果と、閉じた目・開いた口の両方の見た目を確認して報告してください。',
  ];
  const common = [
    '仮の表情（derive-expressions）で置き換えないでください。',
    '対象は保存済みPSDのレイヤーです。ブラウザ内の未保存の並べ替えは含めません。コミット・pushはしないでください。',
  ];
  if (expressionRecipient === 'codex') {
    return [
      '$still2rig-psd を使い、このPSDの閉じた目と開いた口の絵を作って組み込んでください。',
      `${target}リポジトリの AGENTS.md とスキルの「Image-generated expressions」の手順に従ってください。`,
      prepare,
      'ユーザーはこの画面で、顔の切り抜き画像を Codex の組み込みの画像生成（imagegen）に送ることに同意済みです。ほかの外部サービスは使わないでください。',
      `eye_close と mouth_open それぞれの input.png、mask.png、prompt.txt を使って画像を生成し、${results} に保存してください。`,
      ...finish,
      ...common,
    ].join('\n');
  }
  return [
    'リポジトリの AGENTS.md と .agents/skills/still2rig-psd/SKILL.md を読み、このPSDの閉じた目と開いた口の絵を用意する準備をしてください。',
    target,
    prepare,
    'Claude Code は画像を生成できません。画像の生成や外部サービスへの送信はしないでください。',
    `eye_close と mouth_open それぞれについて、画像生成に渡すファイル（input.png と mask.png の場所、prompt.txt の内容）と、結果を保存するファイル名（${results}）を具体的に案内して、そこで止まってください。`,
    '私が結果を保存したと伝えたら、続きを進めてください。',
    ...finish,
    ...common,
  ].join('\n');
}

async function copyExpressionRequest(): Promise<void> {
  const item = generatedPsds.find((candidate) => candidate.id === activeGeneratedPsdId);
  if (!item?.jobId) return;
  const message = expressionRequestMessage(item, item.jobId);
  try {
    await navigator.clipboard.writeText(message);
    expressionRequestStatus.textContent = `依頼文をコピーしました。${recipientLabel(expressionRecipient)}に貼り付けてください。`;
  } catch {
    expressionRequestStatus.textContent = 'コピーできませんでした。ブラウザのクリップボード許可を確認してください。';
  }
}

async function openGeneratedPsdFolder(): Promise<void> {
  const item = generatedPsds.find((candidate) => candidate.id === generatedPsdSelect.value);
  if (!item) return;
  generatedPsdOpenFolder.disabled = true;
  const previousLabel = generatedPsdOpenFolder.textContent;
  generatedPsdOpenFolder.textContent = '開いています…';
  try {
    const response = await fetch('/api/generated-psds/open-folder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Still2Rig-Action': 'open-generated-folder',
      },
      body: JSON.stringify({ id: item.id }),
    });
    const payload = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `保存先を開けませんでした（${response.status}）。`);
    }
    generatedPsdNote.textContent = `${item.name} の保存先を開きました。`;
  } catch (error) {
    generatedPsdNote.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    generatedPsdOpenFolder.textContent = previousLabel;
    generatedPsdOpenFolder.disabled = !generatedPsds.some(
      (candidate) => candidate.id === generatedPsdSelect.value,
    );
  }
}

async function refreshGeneratedPsdList(autoLoad = false): Promise<void> {
  generatedPsdRefresh.disabled = true;
  generatedPsdOpenFolder.disabled = true;
  generatedPsdNote.textContent = '生成済みPSDを検索しています…';
  try {
    const response = await fetch('/api/generated-psds', { cache: 'no-store' });
    if (!response.ok) throw new Error(`一覧の取得に失敗しました（${response.status}）。`);
    const payload = await response.json() as { items?: GeneratedPsd[] };
    generatedPsds = Array.isArray(payload.items) ? payload.items : [];
    const previousValue = generatedPsdSelect.value;
    generatedPsdSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = generatedPsds.length
      ? '生成済みPSDを選択'
      : '生成済みPSDはありません';
    generatedPsdSelect.append(placeholder);
    for (const item of generatedPsds) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = generatedPsdLabel(item);
      generatedPsdSelect.append(option);
    }
    generatedPsdSelect.disabled = generatedPsds.length === 0;
    generatedPsdNote.textContent = generatedPsds.length
      ? `${generatedPsds.length}件を検出しました。新しいPSDを先頭に表示しています。`
      : '生成が完了したPSDはここへ自動的に表示されます。';
    if (generatedPsds.some((item) => item.id === previousValue)) {
      generatedPsdSelect.value = previousValue;
      generatedPsdOpenFolder.disabled = false;
    }
    if (autoLoad && generatedPsds[0]) {
      await loadGeneratedPsd(generatedPsds[0]);
    } else if (!avatar && generatedPsds.length > 0) {
      api.setLabel('生成済みPSDを選択できます', '一覧から選ぶか、手元のPSDを読み込んでください。', 0);
    }
  } catch (error) {
    generatedPsds = [];
    generatedPsdSelect.disabled = true;
    generatedPsdOpenFolder.disabled = true;
    generatedPsdSelect.replaceChildren(new Option('一覧を取得できませんでした', ''));
    generatedPsdNote.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    generatedPsdRefresh.disabled = false;
    syncExpressionRequestControl();
  }
}

function setAvatarControlsDisabled(disabled: boolean): void {
  const controls: Array<HTMLInputElement | HTMLButtonElement> = [
    eyeControl,
    mouthControl,
    blinkToggle,
    zoomControl,
    viewReset,
    ...modeButtons,
    ...presetButtons,
    ...Object.values(tuningInputs),
    ...[...advancedControls.values()].flatMap((control) => [control.range, control.number]),
    advancedReset,
    demoStart,
    demoStop,
  ];
  for (const control of controls) control.disabled = disabled;
  cameraControls?.setAvatarReady(!disabled);
  if (!disabled && cameraActive) setCameraConflicts(true);
}

function setCameraConflicts(active: boolean): void {
  cameraActive = active;
  eyeControl.disabled = active || !avatar;
  mouthControl.disabled = active || !avatar;
  blinkToggle.disabled = active || !avatar;
  demoStart.disabled = active || !avatar;
  demoStop.disabled = active || !avatar;
  advancedReset.disabled = active || !avatar;
  const trackedParameters = new Set<PsdMotionParameterName>([
    'angleX', 'angleY', 'angleZ', 'body', 'eyeOpenL', 'eyeOpenR',
    'eyeX', 'eyeY', 'mouthOpen', 'mouthForm', 'brow',
  ]);
  for (const [name, control] of advancedControls) {
    const disabled = !avatar || (active && trackedParameters.has(name));
    control.range.disabled = disabled;
    control.number.disabled = disabled;
  }
  if (active) demoToken += 1;
}

function installEventListeners(): void {
  createAdvancedParameterControls();
  cameraControls = installCameraControls({
    input(input, weight) { avatar?.setTrackingInput(input, weight); },
    active(active) { setCameraConflicts(active); },
  });
  canvas.getContext('webgl', {
    alpha: true,
    stencil: true,
    antialias: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
  });

  motionTab.addEventListener('click', () => setWorkspaceMode('motion'));
  layerEditTab.addEventListener('click', () => setWorkspaceMode('layers'));
  moveLayerFront.addEventListener('click', () => {
    hideCanvasPickMenu();
    void moveSelectedLayer('front');
  });
  moveLayerBack.addEventListener('click', () => {
    hideCanvasPickMenu();
    void moveSelectedLayer('back');
  });
  openLayerList.addEventListener('click', () => {
    hideCanvasPickMenu(true);
    layerOrderDetails.open = true;
    openLayerList.setAttribute('aria-expanded', 'true');
    const panelRect = controlPanel.getBoundingClientRect();
    const detailsRect = layerOrderDetails.getBoundingClientRect();
    controlPanel.scrollTo({
      top: controlPanel.scrollTop + detailsRect.top - panelRect.top,
      behavior: 'smooth',
    });
  });
  layerOrderDetails.addEventListener('toggle', () => {
    openLayerList.setAttribute('aria-expanded', String(layerOrderDetails.open));
  });
  layerOrderList.addEventListener('dragover', (event) => {
    if (!draggedLayerId || layerEditBusy || showingOriginal) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    updateLayerDropIndicator(event.clientY);
  });
  layerOrderList.addEventListener('drop', (event) => {
    if (!draggedLayerId || layerEditBusy || showingOriginal) return;
    event.preventDefault();
    const draggedId = draggedLayerId;
    const nextDisplayOrder = droppedLayerDisplayOrder();
    clearLayerOrderDragUi();
    if (!nextDisplayOrder) return;
    const nextOrder = nextDisplayOrder.reverse();
    if (layerOrderSignature(nextOrder) === layerOrderSignature(currentLayerOrder)) {
      announceLayerEdit('位置は変わっていません。右端の点々を別の場所まで動かしてください。');
      renderLayerEditor();
      return;
    }
    void commitLayerOrder(
      nextOrder,
      `${editableLayers.find((candidate) => candidate.id === draggedId)?.label ?? '選んだ部分'}の重なりを変更しました。`,
    );
  });
  beforeAfterToggle.addEventListener('click', () => {
    void toggleOriginalPreview();
  });
  undoLayerEdit.addEventListener('click', () => {
    void undoLastLayerEdit();
  });
  resetLayerEdit.addEventListener('click', () => {
    void resetLayerEdits();
  });
  saveLayerEdit.addEventListener('click', () => {
    void saveEditedPsd();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedLayerChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !canvasPickMenu.hidden) hideCanvasPickMenu();
  });
  window.addEventListener('resize', () => {
    if (layerProcessingActive) syncLayerProcessingBounds();
  });

  psdFileInput.addEventListener('change', () => {
    const file = psdFileInput.files?.[0];
    psdFileInput.value = '';
    if (!file) return;
    void loadLocalPsd(file).catch(showLoadError);
  });

  generatedPsdSelect.addEventListener('change', () => {
    const item = generatedPsds.find((candidate) => candidate.id === generatedPsdSelect.value);
    if (!item) return;
    if (!confirmDiscardLayerChanges()) {
      generatedPsdSelect.value = activeGeneratedPsdId;
      return;
    }
    void loadGeneratedPsd(item).catch(showLoadError);
  });
  generatedPsdRefresh.addEventListener('click', () => {
    void refreshGeneratedPsdList(!avatar).catch(showLoadError);
  });
  generatedPsdOpenFolder.addEventListener('click', () => {
    void openGeneratedPsdFolder();
  });
  expressionRequestCopy.addEventListener('click', () => {
    void copyExpressionRequest();
  });
  for (const button of expressionRecipientButtons) {
    button.addEventListener('click', () => {
      setExpressionRecipient(button.dataset.recipient === 'claude' ? 'claude' : 'codex');
    });
  }
  startRequestCopy.addEventListener('click', () => {
    void copyStartRequest();
  });
  for (const button of startRecipientButtons) {
    button.addEventListener('click', () => {
      setExpressionRecipient(button.dataset.startRecipient === 'claude' ? 'claude' : 'codex');
    });
  }

  let fileDragDepth = 0;
  const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const hideDropOverlay = (): void => {
    fileDragDepth = 0;
    document.body.dataset.fileDragging = 'false';
    dropOverlay.setAttribute('aria-hidden', 'true');
  };
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    fileDragDepth += 1;
    document.body.dataset.fileDragging = 'true';
    dropOverlay.setAttribute('aria-hidden', 'false');
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0) hideDropOverlay();
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    hideDropOverlay();
    const file = files.find(isPsdFile) ?? files[0];
    if (!file) return;
    void loadLocalPsd(file).catch(showLoadError);
  });

  eyeControl.addEventListener('input', () => {
    demoToken += 1;
    api.setState(Number(eyeControl.value) / 100, mouthOpen);
    syncControls();
    api.setLabel('手動操作', '目の開閉を調整中', Number(eyeControl.value) / 100);
  });
  mouthControl.addEventListener('input', () => {
    demoToken += 1;
    api.setState(eyeOpen, Number(mouthControl.value) / 100);
    syncControls();
    api.setLabel('手動操作', '口の開閉を調整中', Number(mouthControl.value) / 100);
  });
  blinkToggle.addEventListener('click', () => {
    demoToken += 1;
    api.setAutoBlink(!autoBlinkEnabled);
    api.setLabel(
      '自動まばたき',
      autoBlinkEnabled ? '自然な間隔で自動的にまばたきします。' : '自動まばたきを停止しました。',
      autoBlinkEnabled ? 1 : 0,
    );
  });
  zoomControl.addEventListener('input', () => {
    setViewScale(Number(zoomControl.value) / 100);
    api.setLabel('表示操作', `倍率 ${zoomControl.value}%`, Number(zoomControl.value) / 200);
  });
  viewReset.addEventListener('click', () => {
    viewOffsetX = 0;
    viewOffsetY = 0;
    viewScale = DEFAULT_VIEW_SCALE;
    avatar?.resetDragMotion();
    syncViewTransform();
    api.setLabel('表示をリセット', '位置と倍率を初期状態へ戻しました。', 0);
  });
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !avatar) return;
    dragState = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startClientX: event.clientX,
      startClientY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      time: performance.now(),
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const threshold = dragState.pointerType === 'touch' ? 10 : 5;
    if (!dragState.moved) {
      const distance = Math.hypot(
        event.clientX - dragState.startClientX,
        event.clientY - dragState.startClientY,
      );
      if (distance <= threshold) return;
      dragState.moved = true;
      avatar?.setDragMotion(0, 0, true);
      document.body.dataset.avatarDragging = 'true';
      hideCanvasPickMenu(true);
    }
    const rect = canvas.getBoundingClientRect();
    const deltaX = ((event.clientX - dragState.clientX) / rect.width) * canvas.width;
    const deltaY = ((event.clientY - dragState.clientY) / rect.height) * canvas.height;
    const now = performance.now();
    const elapsed = Math.max(8, Math.min(50, now - dragState.time));
    viewOffsetX += deltaX;
    viewOffsetY += deltaY;
    avatar?.setDragMotion(deltaX / elapsed / 4, deltaY / elapsed / 4, true);
    dragState.clientX = event.clientX;
    dragState.clientY = event.clientY;
    dragState.time = now;
    syncViewTransform();
  });
  const endDrag = (event: PointerEvent, allowSelection: boolean) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const completedGesture = dragState;
    dragState = null;
    avatar?.setDragMotion(0, 0, false);
    document.body.dataset.avatarDragging = 'false';
    if (allowSelection && !completedGesture.moved) {
      pickLayerFromCanvas(event.clientX, event.clientY);
    }
  };
  canvas.addEventListener('pointerup', (event) => endDrag(event, true));
  canvas.addEventListener('pointercancel', (event) => endDrag(event, false));
  canvas.addEventListener('lostpointercapture', (event) => endDrag(event, false));
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    setViewScale(viewScale * Math.exp(-event.deltaY * 0.001), canvasPoint(event.clientX, event.clientY));
    api.setLabel('表示操作', `倍率 ${Math.round(viewScale * 100)}%`, viewScale / 2);
  }, { passive: false });
  for (const button of modeButtons) button.addEventListener('click', () => {
    demoToken += 1;
    selectMode((button.dataset.mode ?? 'static') as QaMode);
  });
  for (const button of presetButtons) button.addEventListener('click', () => {
    const preset = button.dataset.motionPreset as Exclude<MotionPreset, 'custom'>;
    if (!MOTION_PRESETS[preset]) return;
    demoToken += 1;
    applyMotionTuning(MOTION_PRESETS[preset], preset);
    api.setLabel(
      `${PRESET_LABELS[preset]}モーション`,
      '現在のPSDへ動きの強さを反映しました。',
      motionTuning.intensity / 1.5,
    );
  });
  for (const id of tuningInputIds) {
    tuningInputs[id]!.addEventListener('input', () => {
      demoToken += 1;
      const key = tuningKeys[id];
      applyMotionTuning({ [key]: Number(tuningInputs[id]!.value) / 100 });
      api.setLabel(
        'モーションを微調整',
        `${tuningOutputs[id]!.closest('.tuning-item')?.querySelector('span span')?.textContent ?? 'パラメータ'}を${tuningInputs[id]!.value}%に設定しました。`,
        Number(tuningInputs[id]!.value) / Number(tuningInputs[id]!.max),
      );
    });
  }
  advancedReset.addEventListener('click', () => {
    demoToken += 1;
    resetAdvancedProfileParameters();
  });
  demoStart.addEventListener('click', () => { void runDemo(); });
  demoStop.addEventListener('click', () => {
    demoToken += 1;
    api.setState(1, 0); syncControls(); selectMode('static');
    api.setLabel('停止しました', '自由に操作できます。', 0);
  });
  syncControls();
  syncBlinkControls();
  syncMotionTuningControls();
  setAvatarControlsDisabled(true);
  document.body.dataset.workspaceMode = 'motion';
  layerEditorUnavailable.textContent = 'PSDを読み込むと、重なりを修正できます。';
  layerEditorUnavailable.hidden = false;
  layerEditorContent.hidden = true;
}

async function run(): Promise<void> {
  installEventListeners();
  const params = new URLSearchParams(window.location.search);
  const psdUrl = params.get('psd');
  await refreshGeneratedPsdList(!psdUrl && params.get('autoload') !== '0');
  if (!psdUrl) return;
  const selectedModel = psdUrl.split('/').pop() ?? 'avatar.psd';
  try {
    const response = await fetch(psdUrl);
    if (!response.ok) throw new Error(`PSD fetch failed: ${response.status}`);
    const buffer = await response.arrayBuffer();
    initializeLayerEditor(buffer, selectedModel);
    await activatePsd(buffer, selectedModel);
  } catch (error) {
    showLoadError(error);
  }
}

void run();
