import { upperLidY } from './eyeExpression.mjs';
const clamp = value => Math.max(0, Math.min(1, value));
const mix = (a,b,t) => a+(b-a)*t;

/** Blend only during the blink; each endpoint shows exactly one drawing. */
export function drawnBlinkOpacity(eyeOpen) {
  const t=clamp(eyeOpen),open=t*t*(3-2*t);
  return {open,closed:1-open};
}

/** Read the drawing's visible whites and brow, without character-specific coordinates. */
export function drawnEyeFeatures(layer, anchor) {
  const {width,height,data}=layer.img, eye=[],brow=[];
  const h=anchor.y1-anchor.y0,w=anchor.x1-anchor.x0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const i=(y*width+x)*4,X=x+layer.x,Y=y+layer.y;
    if(data[i+3]<128 || X<anchor.x0-w*.25 || X>anchor.x1+w*.25)continue;
    if(Y>=anchor.y0-h*.3 && Y<=anchor.y1+h*.3 && data[i]>150 && data[i+1]>data[i]*.88 && data[i+2]>data[i]*.88)eye.push([X,Y]);
    if(anchor.browBounds && Y>=anchor.browBounds.y0-h*.4 && Y<anchor.y0-h*.18 && Math.max(data[i],data[i+1],data[i+2])<165)brow.push([X,Y]);
  }
  const bounds=points=>points.length?{x0:Math.min(...points.map(p=>p[0])),x1:Math.max(...points.map(p=>p[0]))+1,
    y0:Math.min(...points.map(p=>p[1])),y1:Math.max(...points.map(p=>p[1]))+1}:null;
  const eyeBounds=bounds(eye)??anchor,browBounds=bounds(brow)??anchor.browBounds;
  const curve=[];
  if(browBounds)for(let bin=0;bin<17;bin++) {
    const left=mix(browBounds.x0,browBounds.x1,bin/17),right=mix(browBounds.x0,browBounds.x1,(bin+1)/17);
    const ys=brow.filter(p=>p[0]>=left&&p[0]<right);
    if(ys.length)curve.push({x:(left+right)/2,y:ys.reduce((sum,p)=>sum+p[1],0)/ys.length});
  }
  return {eye:eyeBounds,brow:browBounds,browCurve:curve,browCut:(eyeBounds.y0+(browBounds?.y1??eyeBounds.y0-h))/2};
}

/** The shared intermediate geometry swaps one drawing at halfway, then restores its art. */
export function morphDrawnEye(x,y,anchor,features,strength,drawing,brow=false) {
  const t=clamp(strength);
  if(!features || (drawing&&t===1) || (!drawing&&t===0))return {x,y};
  const target=features.eye, source=drawing?target:anchor;
  const common={x0:mix(anchor.x0,target.x0,t),x1:mix(anchor.x1,target.x1,t),y0:mix(anchor.y0,target.y0,t),y1:mix(anchor.y1,target.y1,t)};
  if(brow && anchor.browBounds && features.brow) {
    const a=anchor.browBounds,b=features.brow,s=drawing?b:a;
    const u=(x-s.x0)/Math.max(1,s.x1-s.x0),nx=mix(mix(a.x0,b.x0,t),mix(a.x1,b.x1,t),u);
    const ay=upperLidY(anchor.browCurve,mix(a.x0,a.x1,u),(a.y0+a.y1)/2);
    const by=upperLidY(features.browCurve,mix(b.x0,b.x1,u),(b.y0+b.y1)/2);
    return {x:nx,y:y+mix(ay,by,t)-(drawing?by:ay)};
  }
  return {x:common.x0+(x-source.x0)*(common.x1-common.x0)/Math.max(1,source.x1-source.x0),
    y:common.y0+(y-source.y0)*(common.y1-common.y0)/Math.max(1,source.y1-source.y0)};
}
