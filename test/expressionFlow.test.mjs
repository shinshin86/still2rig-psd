import test from 'node:test';
import assert from 'node:assert/strict';
import { expressionRequestGroups,expressionGroupState,selectedExpressionArtwork,expressionFlowRequest } from '../src/expressionFlow.mjs';
import {generatableExpressions} from '../src/expressions.mjs';

test('expression choices cover every generated drawing and request only missing shared art',()=>{
  assert.deepEqual(new Set(expressionRequestGroups.flatMap(g=>g.parts)),new Set(generatableExpressions.map(item=>item.name)));
  const parts=['blush','mouth_frown'];
  assert.deepEqual(selectedExpressionArtwork(['shy','sad'],parts).map(item=>item.name),['tears','eyes_sad','eyes_shy']);
  assert.deepEqual(selectedExpressionArtwork(['angry'],['eyes_angry','mouth_frown']),[]);
  assert.deepEqual(selectedExpressionArtwork(['angry'],['eyes_angry','mouth_frown'],true),[]);
  assert.equal(expressionGroupState(expressionRequestGroups.find(g=>g.id==='angry'),['eyes_angry','mouth_frown']).complete,true);
  assert.ok(selectedExpressionArtwork(['shy'],parts,true).some(item=>item.name==='blush'));
  assert.deepEqual(selectedExpressionArtwork(expressionRequestGroups.map(group=>group.id),generatableExpressions.map(item=>item.name),true),[]);
});

test('both recipient requests require three candidates and user selection before importing',()=>{
  for(const recipient of ['codex','claude']) {
    const text=expressionFlowRequest({jobId:'demo',name:'sample.psd',recipient,groupIds:['angry'],parts:[]});
    assert.match(text,/results\/candidates\//);assert.match(text,/eyes_angry-1\.png/);
    assert.match(text,/expression-candidates demo/);assert.match(text,/import-expressions demo --pick/);
    assert.match(text,/必ずここで止まって選択を待って/);assert.match(text,/同じ問題で2回失敗/);
    assert.doesNotMatch(text,/つまみ/);
    assert.ok(text.indexOf('必ずここで止まって')<text.indexOf('import-expressions'));
    assert.match(text,recipient==='codex'?/同意済み/:/画像生成や外部サービスへの送信はせず/);
  }
});
