import { generatableExpressions } from './expressions.mjs';

export const expressionRequestGroups = Object.freeze([
  {id:'basic',label:'まばたきと口パク',parts:['eye_close','mouth_open']},
  {id:'joy',label:'笑顔',parts:['eye_smile','mouth_laugh','blush']},
  {id:'shy',label:'照れ',parts:['eyes_shy','blush']},
  {id:'angry',label:'怒り',parts:['eyes_angry','mouth_frown']},
  {id:'sad',label:'悲しみ',parts:['eyes_sad','mouth_frown','tears']},
  {id:'surprised',label:'驚き',parts:['eyes_surprised','mouth_round']},
  {id:'flustered',label:'焦り',parts:['eyes_flustered','sweat']},
  {id:'unamused',label:'ジト目',parts:['eyes_half']},
  {id:'mark',label:'怒りマーク',parts:['anger_mark']},
]);
export function expressionArtworkLabel(name) {
  return ({mouth_frown:'への字の口',eyes_half:'ジト目の目元'})[name]??generatableExpressions.find(item=>item.name===name)?.label??name;
}
export function expressionGroupState(group, parts) {
  const available=new Set(parts);
  const present=group.parts.filter(name=>available.has(name)),missing=group.parts.filter(name=>!available.has(name));
  return {present,missing,complete:missing.length===0};
}
export function selectedExpressionArtwork(ids,parts,redrawIds=[]) {
  const names=new Set(expressionRequestGroups.flatMap(group=>redrawIds.includes(group.id)?group.parts:
    ids.includes(group.id)?expressionGroupState(group,parts).missing:[]));
  return generatableExpressions.filter(item=>names.has(item.name));
}
export function expressionFlowRequest({jobId,name,recipient,groupIds,parts,redrawGroupIds=[],notes={}}) {
  if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(jobId))throw new Error('Invalid conversion name.');
  const selected=selectedExpressionArtwork(groupIds,parts,redrawGroupIds);
  if(!selected.length)throw new Error('Choose expression artwork first.');
  const groups=expressionRequestGroups.filter(group=>groupIds.includes(group.id)||redrawGroupIds.includes(group.id));
  const missing=groups.filter(group=>groupIds.includes(group.id)&&!redrawGroupIds.includes(group.id)).map(group=>group.label);
  const redraw=groups.filter(group=>redrawGroupIds.includes(group.id));
  const selection=selected.map(item=>item.name).join(',');
  const root=`.still2rig-psd/jobs/${jobId}`;
  return [
    recipient==='codex'?'$still2rig-psd を使い、このPSDに必要な表情の絵をまとめて用意してください。':'このPSDに必要な表情の絵をまとめて用意する準備をしてください。',
    `対象: ${name}。リポジトリの AGENTS.md と .agents/skills/still2rig-psd/SKILL.md に従ってください。`,
    ...(missing.length?[`足りない絵を作る表情: ${missing.join('・')}。入っている絵は残してください。`]:[]),
    ...redraw.map(group=>`作り直す表情: ${group.label}。既存の絵を新しい絵で置き換えてください。${notes[group.id]?.trim()?`希望（表情の描き方にだけ反映）: ${JSON.stringify(notes[group.id].trim())}`:''}`),
    '笑い目や頬の赤らみ、への字の口など、複数の表情で共有する絵を置き換えると、それを使うほかの表情にも反映されます。',
    `まず npm run still2rig-psd -- expression-requests ${jobId} --only ${selection} を実行し、必要な依頼をまとめて作ってください。`,
    recipient==='codex'?'ユーザーはこの画面で、顔の切り抜き画像をCodexの組み込みの画像生成（imagegen）に送ることに同意済みです。ほかの外部サービスは使わないでください。':'Claude Codeは画像を生成できません。画像生成や外部サービスへの送信はせず、全ての絵についてinput.png・mask.pngの場所、prompt.txtの内容、下記の保存先をまとめて案内してください。画像を用意する必要がある場合だけ待ち、保存の連絡後は下記の判定・取り込み・修復をまとめて進めてください。',
    ...selected.map(item=>`${item.name}: 同名フォルダのinput.png・mask.png・prompt.txtを使って1枚生成し、${root}/expression-requests/results/${item.name}.png に保存してください。`),
    '各絵を1枚ずつ生成し、取り込み判定と目視を通った最初の1枚を採用してください。途中で候補を選ばせたり、表情ごとに承認を求めたりせず、全て進めてください。',
    '目視基準: その表情に見える／元の絵柄・線の太さ・色に合う／目・眉・口が二重になっていない／指定範囲の外に描き足していない。',
    `各絵は npm run still2rig-psd -- import-expressions ${jobId} --only 絵の名前 --read-only --preview-dir .still2rig-psd/review/${jobId}/絵の名前 で判定し、画像も確認してください。`,
    '判定や目視基準を満たさなければ、その絵だけ最大2回まで作り直してください。通った絵はそれ以上生成しないでください。なお満たせない絵は見送り、理由を記録してほかの絵へ進んでください。判定基準を緩めないでください。',
    `全ての判定後、採用した絵だけを npm run still2rig-psd -- import-expressions ${jobId} --only 採用した絵の名前（カンマ区切り）でまとめて取り込み、npm run still2rig-psd -- repair ${jobId} --expressions ${root}/generated-expressions を実行してください。採用が0枚なら修復せず理由を報告してください。見送った絵と、依頼に含まれない既存の絵は残してください。`,
    '最後に表情ボタンの完成形を並べた一覧1枚、作り直し回数と見送った表情・理由の短い表、検査結果を報告してください。引き継がれた画像も確認し、途中の強さ・往復の切り替え・まばたきを確認してください。テストとビルドは最後に1回ずつ実行してください。全体で30分前後を目標にしてください。',
    '仮の表情（derive-expressions）で置き換えないでください。保存済みPSDのレイヤーを対象にし、ブラウザ内の未保存の並べ替えは含めません。コミット・pushはしないでください。',
  ].join('\n');
}
