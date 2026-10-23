import test from 'node:test';
import assert from 'node:assert/strict';
import { expressionPresets } from '../src/expressionPresets.mjs';
import { expressionShortcut } from '../webui/src/expressionShortcuts.mjs';

const choices = expressionPresets.map(preset => ({id:preset.id,disabled:false}));

test('number-row and keypad keys follow the expression button order', () => {
  for (const [index, choice] of choices.entries()) {
    const digit = String(index + 1);
    assert.equal(expressionShortcut({key:digit,code:`Digit${digit}`},choices),choice.id);
    assert.equal(expressionShortcut({key:digit,code:`Numpad${digit}`},choices),choice.id);
    assert.equal(expressionShortcut({key:'End',code:`Numpad${digit}`},choices),choice.id);
  }
  for (const key of ['0','a','Escape','!','F1']) assert.equal(expressionShortcut({key},choices),null);
});

test('typing in inputs, selects and editable content never changes an expression', () => {
  for (const tag of ['input','textarea','select']) {
    const target = {closest:selector=>selector.split(', ').includes(tag)?{}:null};
    assert.equal(expressionShortcut({key:'2',target},choices),null);
  }
  for (const target of [{isContentEditable:true},{parentElement:{isContentEditable:true}}]) {
    assert.equal(expressionShortcut({key:'2',target},choices),null);
  }
  assert.equal(expressionShortcut({key:'2',composedPath:()=>[{isContentEditable:true}]},choices),null);
  assert.equal(expressionShortcut({key:'2',target:{isContentEditable:false}},choices),'joy');
});

test('modifiers, held keys, composition and handled events are ignored', () => {
  for (const flag of ['ctrlKey','metaKey','altKey','repeat','isComposing','defaultPrevented']) {
    assert.equal(expressionShortcut({key:'2',[flag]:true},choices),null);
  }
});

test('unavailable expressions keep their number and cannot be selected', () => {
  const limited = choices.map((choice,index)=>({...choice,disabled:index===1}));
  assert.equal(expressionShortcut({key:'2'},limited),null);
  assert.equal(expressionShortcut({key:'3'},limited),'shy');
  assert.equal(expressionShortcut({key:'1'},[]),null);
});
