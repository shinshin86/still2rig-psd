const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t=clamp(value); return t*t*(3-2*t); };
const mix = (a,b,t) => a+(b-a)*t;
const sample = (values,u) => {
  const x=clamp(u)*(values.length-1),i=Math.floor(x);
  return mix(values[i],values[Math.min(i+1,values.length-1)],x-i);
};

/** Visible contours, in model coordinates, retain each drawing's lip curve. */
export function mouthContour(layer, outlineOnly=false, lipLineOnly=false) {
  const {width,height,data}=layer.img;
  const columns=Array.from({length:width},()=>[]);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const offset=(y*width+x)*4;
    if(data[offset+3]>16 && (!outlineOnly || Math.min(data[offset],data[offset+1],data[offset+2])<160))columns[x].push(y+layer.y);
  }
  if(lipLineOnly)for(let x=0;x<columns.length;x++){const ys=columns[x];const end=ys.findIndex((y,i)=>i>0&&y>ys[i-1]+1);if(end>0)columns[x]=ys.slice(0,end);}
  const used=columns.map((ys,x)=>ys.length?x:-1).filter(x=>x>=0);
  if(!used.length)return null;
  const left=used[0],right=used.at(-1),top=[],bottom=[];
  for(let x=left;x<=right;x++) {
    const nearest=columns[x].length?x:used.reduce((best,next)=>Math.abs(next-x)<Math.abs(best-x)?next:best,used[0]);
    if(lipLineOnly) {
      let weight=0,center=0;
      for(const y of columns[nearest]) {const a=data[((y-layer.y)*width+nearest)*4+3];weight+=a;center+=(y+.5)*a;}
      center/=weight;
      const thickness=Math.max(.7,Math.min(3,weight/255));
      top.push(center-thickness/2);bottom.push(center+thickness/2);
    } else {top.push(columns[nearest][0]);bottom.push(columns[nearest].at(-1)+1);}
  }
  if(lipLineOnly)for(const values of [top,bottom]) {
    const before=[...values];
    for(let i=0;i<values.length;i++)values[i]=[1,4,6,4,1].reduce((sum,w,j)=>sum+w*before[Math.max(0,Math.min(before.length-1,i+j-2))],0)/16;
  }
  return {left:left+layer.x,right:right+layer.x+1,top,bottom};
}

/** One drawing at a time. Handoffs happen inside a shared narrow-lip band. */
export function createMouthController(contours) {
  const closed=contours.mouth_close??contours.mouth_open;
  const base=contours.mouth_open??closed;
  let shape='base',isClosed=true,seamClosed=false;
  const drawings={base:'mouth_open',laugh:'mouth_laugh',round:'mouth_round'};
  const available={base,laugh:contours.mouth_laugh,round:contours.mouth_round};
  return {
    getState() {return {shape,isClosed,seamClosed};},
    setState(state) {shape=available[state.shape]?state.shape:'base';isClosed=Boolean(state.isClosed);seamClosed=Boolean(state.seamClosed);},
    resolve(params,restWeight=1) {
      if(!closed)return {drawing:'',openness:clamp(params.mouthOpen??0),progress:0,weights:{base:1,laugh:0,round:0}};
      let laugh=available.laugh?clamp(params.mouthLaugh??0):0;
      let round=available.round?clamp(params.mouthRound??0):0;
      const total=Math.max(1,laugh+round);laugh/=total;round/=total;
      const weights={base:1-laugh-round,laugh,round};
      const ranked=Object.keys(weights).filter(key=>available[key]).sort((a,b)=>weights[b]-weights[a]);
      if(!available[shape])shape=ranked[0];
      if(weights[ranked[0]]>weights[shape]+.04)shape=ranked[0];
      const gap=weights[ranked[0]]-(weights[ranked[1]]??0);
      const shapeGate=smooth((gap-.08)/.24);
      const openness=clamp(Math.max(params.mouthOpen??0,Math.max(.22*laugh+.4*round,params.expressionMouthOpen??0)*clamp(restWeight)));
      const threshold=.065+.07*clamp(params.mouthEase??.45);
      if(isClosed && openness>threshold+.012)isClosed=false;
      else if(!isClosed && openness<threshold-.012)isClosed=true;
      const opening=clamp((openness-threshold-.018)/(1-threshold-.018))**(.55+.2*clamp(params.mouthEase??.45));
      const progress=(weights.base*opening+(laugh+round)*Math.sqrt(opening))*shapeGate;
      if(shapeGate<.01)seamClosed=true;
      else if(shapeGate>.08)seamClosed=false;
      const drawing=(isClosed||seamClosed)&&contours.mouth_close?'mouth_close':(contours[drawings[shape]]?drawings[shape]:'mouth_close');
      return {drawing,openness,progress:isClosed?0:progress,weights,opening,shapeGate};
    },
    warp(x,y,name,frame) {
      const source=contours[name];
      if(!source || !closed || !base)return {x,y,visibility:1};
      if(name==='mouth_close') {
        const u=(x-closed.left)/(closed.right-closed.left),edge=sample(closed.bottom,u);
        const tuck=smooth((frame.openness-.025)/.06);
        return {x,y:y>edge?edge+(y-edge)*(1-tuck):y,visibility:1};
      }
      const u=(x-source.left)/(source.right-source.left);
      const sourceTop=sample(source.top,u),sourceBottom=sample(source.bottom,u);
      const v=(y-sourceTop)/Math.max(1,sourceBottom-sourceTop);
      let fullLeft=0,fullRight=0,fullTop=0,fullBottom=0;
      const closedTop=sample(closed.top,u),closedBottom=sample(closed.bottom,u);
      const opening=frame.opening,root=Math.sqrt(opening);
      for(const key of ['base','laugh','round']) {
        const contour=available[key]??base,w=frame.weights[key];
        const scale=key==='base'?opening:root;
        const widthScale=key==='round'?.25+.75*root:1;
        const center=(contour.left+contour.right)/2,half=(contour.right-contour.left)*widthScale/2;
        fullLeft+=(center-half)*w;fullRight+=(center+half)*w;
        fullTop+=mix(closedTop,sample(contour.top,u),scale)*w;
        fullBottom+=mix(closedBottom,sample(contour.bottom,u),scale)*w;
      }
      const widthRestore=smooth((frame.weights.base*opening+(1-frame.weights.base)*root)/.25)*frame.shapeGate;
      const left=mix(closed.left,fullLeft,widthRestore),right=mix(closed.right,fullRight,widthRestore);
      const top=mix(closedTop,fullTop,frame.shapeGate),bottom=mix(closedBottom,fullBottom,frame.shapeGate);
      return {x:mix(left,right,u),y:mix(top,bottom,v),visibility:1};
    },
  };
}

export function mouthRestWeight(trackedOpen,weight) {
  return trackedOpen===undefined||weight<=0?1:smooth((trackedOpen-.025)/.075);
}
