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
export function selectedExpressionArtwork(ids,parts,redraw=false) {
  const names=new Set(expressionRequestGroups.filter(group=>ids.includes(group.id)).flatMap(group=>{
    const state=expressionGroupState(group,parts);
    return state.complete?[]:redraw?group.parts:state.missing;
  }));
  return generatableExpressions.filter(item=>names.has(item.name));
}
export function expressionFlowRequest({jobId,name,recipient,groupIds,parts,redraw=false}) {
  if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(jobId))throw new Error('Invalid conversion name.');
  const selected=selectedExpressionArtwork(groupIds,parts,redraw);
  if(!selected.length)throw new Error('Choose expression artwork first.');
  const labels=expressionRequestGroups.filter(group=>groupIds.includes(group.id)).map(group=>group.label).join('・');
  const selection=selected.map(item=>item.name).join(',');
  const root=`.still2rig-psd/jobs/${jobId}`;
  const files=selected.map(item=>`${item.name}: input.png・mask.png・prompt.txt を使い、${root}/expression-requests/results/candidates/ に ${item.name}-1.png、${item.name}-2.png、${item.name}-3.png を保存。`);
  return [
    recipient==='codex'?`$still2rig-psd を使い、このPSDの${labels}の絵を用意してください。`:`このPSDの${labels}の絵を用意する準備をしてください。`,
    `対象: ${name}。リポジトリの AGENTS.md（特に Working pace）と .agents/skills/still2rig-psd/SKILL.md の Image-generated expressions に従ってください。`,
    `まず npm run still2rig-psd -- expression-requests ${jobId} --only ${selection} を実行してください。`,
    recipient==='codex'?'ユーザーはこの画面で、顔の切り抜き画像をCodexの組み込みの画像生成（imagegen）に送ることに同意済みです。ほかの外部サービスは使わないでください。':'Claude Codeは画像を生成できません。画像生成や外部サービスへの送信はせず、各絵のinput.png・mask.pngの場所、prompt.txtの内容、候補3つの保存先を具体的に案内して止まってください。私が保存したと伝えたら比較画像の作成へ進めてください。',
    '一度に1つの表情だけ進めてください。各絵の候補を3つ用意し、元の顔と候補を比較して私が選ぶまで、取り込み・repairをしないでください。',
    ...files,
    `候補がそろったら npm run still2rig-psd -- expression-candidates ${jobId} --only ${selection} で比較画像を作ってください。複数の表情を選んだ場合は、いま確認する表情の絵だけを--onlyへ渡してください。`,
    '検査結果を添えた比較画像を私に見せ、必ずここで止まって選択を待ってください。検査を通ったことだけで候補を決めないでください。',
    `私が候補を選んだあと、npm run still2rig-psd -- import-expressions ${jobId} --pick ${selected[0].name}=番号（複数の絵はカンマ区切り）を選ばれた名前と番号で実行し、通ったら npm run still2rig-psd -- repair ${jobId} --expressions ${root}/generated-expressions を実行してください。`,
    '引き継がれた差し替え画像と表情も確認してください。プレビューの表情ボタンで完成形の拡大、表情の往復、まばたきを確認し、画像と検査結果を報告して止まってください。1つの表情が承認されてから次へ進んでください。',
    '1つの表情の作業は20分を目安にし、過ぎたら途中でも報告して止まってください。同じ問題で2回失敗したら、原因と選択肢を報告して止まってください。',
    '仮の表情（derive-expressions）で置き換えないでください。保存済みPSDのレイヤーを対象にし、ブラウザ内の未保存の並べ替えは含めません。コミット・pushはしないでください。',
  ].join('\n');
}
