const clamp = value => Math.max(0, Math.min(1, value ?? 0));

/** A side owns one drawing. Retarget from the displayed slot, never a queue. */
export function createEyeDrawingSlot(initial = 'neutral') {
  let drawing = initial;
  let shape = {smile: initial === 'smile' ? 1 : 0, angry: initial === 'angry' ? 1 : 0, sad: initial === 'sad' ? 1 : 0, wink: 0};
  let destination = null, transition = null, locked = false, closed = false, awaitClosure = false;
  const choose = () => {
    const weights = {neutral:1-Math.max(shape.smile,shape.angry,shape.sad),smile:shape.smile,angry:shape.angry,sad:shape.sad};
    const next=Object.keys(weights).reduce((best,key)=>weights[key]>weights[best]?key:best,drawing);
    if(weights[next]>weights[drawing]+.001)drawing=next;
  };
  const begin = () => { transition={from:{...shape},elapsed:0}; };
  return {
    getState: () => drawing,
    getFrame: () => ({...shape,locked}),
    getSnapshot: () => ({drawing,shape:{...shape},destination:destination&&{...destination},transition:transition&&{from:{...transition.from},elapsed:transition.elapsed},locked,closed,awaitClosure}),
    setState(value) { drawing = ['neutral', 'smile', 'angry', 'sad'].includes(value) ? value : 'neutral'; shape={smile:drawing==='smile'?1:0,angry:drawing==='angry'?1:0,sad:drawing==='sad'?1:0,wink:0}; },
    restore(state) { drawing=state.drawing;shape={sad:0,...state.shape};destination=state.destination&&{sad:0,...state.destination};transition=state.transition&&{from:{sad:0,...state.transition.from},elapsed:state.transition.elapsed};locked=state.locked;closed=state.closed;awaitClosure=state.awaitClosure; },
    request(smile,angry,wink=0,sad=0) { destination={smile:clamp(smile),angry:clamp(angry),sad:clamp(sad),wink:clamp(wink)};awaitClosure=locked;if(!locked)begin(); },
    clearTarget() { destination=null;transition=null;awaitClosure=false; },
    resolve(smile, angry, open=1, dt=1/60, wink=0,sad=0) {
      const incoming={smile:clamp(smile),angry:clamp(angry),sad:clamp(sad),wink:clamp(wink)};
      if(open<1) {
        if(!locked){locked=true;closed=false;awaitClosure=!!destination;transition=null;}
        if(open===0){shape={...(destination??incoming)};choose();closed=true;awaitClosure=false;}
        return drawing;
      }
      if(locked){locked=false;if(destination&&awaitClosure){awaitClosure=false;begin();}}
      if(destination) {
        if(transition) {
          transition.elapsed+=dt;const t=clamp(transition.elapsed/.25),ease=t*t*(3-2*t);
          for(const key of ['smile','angry','sad','wink'])shape[key]=transition.from[key]+(destination[key]-transition.from[key])*ease;
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
  if (fade === 'eyeSad') return drawing === 'sad' ? blink.open : 0;
  if (fade === 'eyeAngry') return drawing === 'angry' ? blink.open : 0;
  if (fade === 'eyeSmile') return drawing === 'smile' ? blink.open : 0;
  if (fade === 'eyeOpen') return drawing === 'neutral' ? fallback * blink.open : 0;
  if (fade === 'eyeClose') return drawing === 'neutral' ? Math.max(fallback,blink.closed) : blink.closed;
  if (baseName === 'eyebrow' && (drawing === 'angry' || drawing === 'sad')) return blink.closed;
  return fallback;
}

/** Do not bend the visible drawing toward two interrupted expressions at once. */
export function eyeSlotParameters(params, side, drawing, frame) {
  const smile = frame?.smile ?? Math.max(params.eyeSmile || 0, params[`eyeSmile${side}`] || 0);
  const angry = frame?.angry ?? params.eyeAngry ?? 0;
  const sad = frame?.sad ?? params.eyeSad ?? 0;
  const useSad = drawing === 'sad' || (drawing === 'neutral' && sad > Math.max(smile,angry));
  const useAngry = drawing === 'angry' || (drawing === 'neutral' && !useSad && angry > smile);
  const drawn = useAngry || useSad;
  return { ...params, eyeSad: useSad ? sad : 0, eyeAngry: useAngry ? angry : 0,
    eyeSmile: drawn ? 0 : smile, eyeSmileL: 0, eyeSmileR: 0,
    eyeWinkL: drawn ? 0 : side==='L' ? frame?.wink ?? params.eyeWinkL : 0,
    eyeWinkR: drawn ? 0 : side==='R' ? frame?.wink ?? params.eyeWinkR : 0 };
}
