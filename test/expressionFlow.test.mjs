import test from 'node:test';
import assert from 'node:assert/strict';
import { expressionRequestGroups,expressionGroupState,selectedExpressionArtwork,expressionFlowRequest } from '../src/expressionFlow.mjs';
import {generatableExpressions} from '../src/expressions.mjs';

test('expression choices cover every generated drawing and request only missing shared art',()=>{
  assert.deepEqual(new Set([...expressionRequestGroups.flatMap(g=>g.parts),'mouth_close']),new Set(generatableExpressions.map(item=>item.name)));
  const parts=['blush','mouth_frown'];
  assert.deepEqual(selectedExpressionArtwork(['shy','sad'],parts).map(item=>item.name),['tears','eyes_sad','eyes_shy']);
  assert.deepEqual(selectedExpressionArtwork(['angry'],['eyes_angry','mouth_frown']),[]);
  assert.deepEqual(selectedExpressionArtwork([],['eyes_angry','mouth_frown'],['angry']).map(item=>item.name),['mouth_frown','eyes_angry']);
  assert.equal(expressionGroupState(expressionRequestGroups.find(g=>g.id==='angry'),['eyes_angry','mouth_frown']).complete,true);
  assert.ok(selectedExpressionArtwork(['shy'],parts,['shy']).some(item=>item.name==='blush'));
  assert.deepEqual(selectedExpressionArtwork(expressionRequestGroups.map(group=>group.id),generatableExpressions.map(item=>item.name)),[]);
});

test('both recipients request one image, bounded retries and one final overview',()=>{
  for(const recipient of ['codex','claude']) {
    const text=expressionFlowRequest({jobId:'demo',name:'sample.psd',recipient,groupIds:['angry'],parts:[]});
    assert.match(text,/results\/eyes_angry\.png/);assert.match(text,/各絵を1枚ずつ生成/);
    assert.match(text,/import-expressions demo --only/);assert.match(text,/--read-only/);
    assert.match(text,/閉じた口がない・使えない場合/);assert.match(text,/results\/mouth_close\.png/);assert.match(text,/新しい依頼用画像/);
    assert.match(text,/最大2回/);assert.match(text,/全ての判定後/);assert.match(text,/一覧1枚/);
    assert.match(text,/元の絵柄・線の太さ・色/);assert.match(text,/ほかの絵へ進んで/);
    assert.doesNotMatch(text,/--pick|expression-candidates|候補を3つ|私が候補を選/);
    assert.match(text,recipient==='codex'?/同意済み/:/画像生成や外部サービスへの送信はせず/);
  }
});

test('a single request combines missing art and selected redos with only their notes',()=>{
  const options={jobId:'demo',name:'sample.psd',recipient:'codex',groupIds:['sad'],parts:['eyes_angry','mouth_frown'],redrawGroupIds:['angry'],notes:{angry:'もう少し静かな怒りに',sad:'選んでいない希望'}};
  assert.deepEqual(selectedExpressionArtwork(options.groupIds,options.parts,options.redrawGroupIds).map(item=>item.name),['tears','mouth_frown','eyes_angry','eyes_sad']);
  const text=expressionFlowRequest(options);
  assert.match(text,/足りない絵を作る表情: 悲しみ/);assert.match(text,/作り直す表情: 怒り/);
  assert.match(text,/既存の絵を新しい絵で置き換え/);assert.match(text,/もう少し静かな怒りに/);
  assert.doesNotMatch(text,/選んでいない希望/);assert.match(text,/共有する絵/);
});
