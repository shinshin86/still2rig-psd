import { SMILE_SWITCH } from './eyeExpression.mjs';
const clamp = value => Math.max(0, Math.min(1, value ?? 0));
export const drawnEyeDefinitions = ['angry','sad','surprised','shy','flustered','half'].map(drawing => ({drawing,part:`eyes_${drawing}`,parameter:`eye${drawing[0].toUpperCase()}${drawing.slice(1)}`}));
const kinds = ['smile', ...drawnEyeDefinitions.map(def => def.drawing)];
const shapeKeys = [...kinds, 'wink'];
const normalize = values => Object.fromEntries(shapeKeys.map(key => [key, clamp(values?.[key])]));

/** A side owns one drawing. Retarget from the displayed slot, never a queue. */
export function createEyeDrawingSlot(initial = 'neutral') {
  let drawing = initial;
  let shape = normalize({[initial]:1});
  let destination = null, transition = null, locked = false, closed = false, awaitClosure = false;
  const choose = () => {
    const weights = {neutral:1-Math.max(...kinds.map(key=>shape[key])),...Object.fromEntries(kinds.map(key=>[key,shape[key]]))};
    const next=Object.keys(weights).reduce((best,key)=>weights[key]>weights[best]?key:best,drawing);
    if(weights[next]>weights[drawing]+.001)drawing=next;
  };
  const begin = () => { transition={from:{...shape},elapsed:0}; };
  return {
    getState: () => drawing,
    getFrame: () => ({...shape,locked}),
    getSnapshot: () => ({drawing,shape:{...shape},destination:destination&&{...destination},transition:transition&&{from:{...transition.from},elapsed:transition.elapsed},locked,closed,awaitClosure}),
    setState(value) { drawing = ['neutral',...kinds].includes(value) ? value : 'neutral'; shape=normalize({[drawing]:1}); },
    restore(state) { drawing=state.drawing;shape=normalize(state.shape);destination=state.destination&&normalize(state.destination);transition=state.transition&&{from:normalize(state.transition.from),elapsed:state.transition.elapsed};locked=state.locked;closed=state.closed;awaitClosure=state.awaitClosure; },
    request(smile,angry,wink=0,sad=0) { this.requestFrame({smile,angry,wink,sad}); },
    requestFrame(values) { destination=normalize(values);awaitClosure=locked;if(!locked)begin(); },
    clearTarget() { destination=null;transition=null;awaitClosure=false; },
    resolve(smile, angry, open=1, dt=1/60, wink=0,sad=0) {
      return this.resolveFrame({smile,angry,wink,sad},open,dt);
    },
    resolveFrame(values,open=1,dt=1/60) {
      const incoming=normalize(values);
      if(open<1) {
        if(!locked){locked=true;closed=false;awaitClosure=!!destination;transition=null;}
        if(open===0){shape={...(destination??incoming)};choose();closed=true;awaitClosure=false;}
        return drawing;
      }
      if(locked){locked=false;if(destination&&awaitClosure){awaitClosure=false;begin();}}
      if(destination) {
        if(transition) {
          transition.elapsed+=dt;const t=clamp(transition.elapsed/.25),ease=t*t*(3-2*t);
          for(const key of shapeKeys)shape[key]=transition.from[key]+(destination[key]-transition.from[key])*ease;
          if(t===1)transition=null;
        }
      } else shape=incoming;
      choose();
      return drawing;
    },
  };
}

/** All layers of a drawing share the slot; only blink closure may overlap it. */
export function eyeDrawingAlpha(fade, baseName, drawing, blink, fallback) {
  const drawn = drawnEyeDefinitions.find(def=>def.parameter===fade);
  if (drawn) return drawing === drawn.drawing ? blink.open : 0;
  // Smiling eyes are already closed arcs, so a blink leaves them unchanged.
  if (fade === 'eyeSmile') return drawing === 'smile' ? 1 : 0;
  if (fade === 'eyeOpen') return drawing === 'neutral' ? fallback * blink.open : 0;
  if (fade === 'eyeClose') return drawing === 'neutral' ? Math.max(fallback,blink.closed) : drawing === 'smile' ? 0 : blink.closed;
  if (baseName === 'eyebrow' && drawnEyeDefinitions.some(def=>def.drawing===drawing)) return blink.closed;
  return fallback;
}

/** Do not bend the visible drawing toward two interrupted expressions at once. */
export function eyeSlotParameters(params, side, drawing, frame) {
  const smile = frame?.smile ?? Math.max(params.eyeSmile || 0, params[`eyeSmile${side}`] || 0);
  const strengths=drawnEyeDefinitions.map(def=>({...def,value:frame?.[def.drawing]??params[def.parameter]??0}));
  const strongest=strengths.reduce((best,def)=>def.value>best.value?def:best,strengths[0]);
  const active=strengths.find(def=>def.drawing===drawing)??(drawing==='neutral'&&strongest.value>smile?strongest:null);
  const drawn=!!active;
  return { ...params, ...Object.fromEntries(strengths.map(def=>[def.parameter,def===active?def.value:0])),
    // While the slot still shows the open eyes, keep them below the smile drawing's switch point.
    eyeSmile: drawn ? 0 : drawing === 'neutral' ? Math.min(smile, SMILE_SWITCH - 1e-6) : smile, eyeSmileL: 0, eyeSmileR: 0,
    eyeWinkL: drawn ? 0 : side==='L' ? frame?.wink ?? params.eyeWinkL : 0,
    eyeWinkR: drawn ? 0 : side==='R' ? frame?.wink ?? params.eyeWinkR : 0 };
}
