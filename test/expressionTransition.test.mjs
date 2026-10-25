import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpressionTransition } from '../webui/src/expressionTransition.mjs';

test('expression time sampling preserves 250ms smoothstep and completes without animation frames', () => {
  const transition = createExpressionTransition(['eyeSad', 'mouthFrown']);
  transition.start({ eyeSad: 0, mouthFrown: 0, angleX: 9 }, { eyeSad: 1, mouthFrown: 0.5 }, 100);
  assert.deepEqual(transition.sample(100), { eyeSad: 0, mouthFrown: 0 });
  assert.deepEqual(transition.sample(162.5), { eyeSad: 0.15625, mouthFrown: 0.078125 });
  assert.deepEqual(transition.sample(225), { eyeSad: 0.5, mouthFrown: 0.25 });
  assert.deepEqual(transition.sample(5000), { eyeSad: 1, mouthFrown: 0.5 });
  assert.equal(transition.active(), false);
  assert.equal(transition.sample(5100), null);
});

test('interruption starts from the current time value, not the last rendered frame', () => {
  const transition = createExpressionTransition(['eyeSad', 'eyeAngry']);
  transition.start({ eyeSad: 0, eyeAngry: 0 }, { eyeSad: 1, eyeAngry: 0 }, 0);
  // No sample/render happened before the user changes the target at halfway.
  const current = transition.sample(125);
  transition.start(current, { eyeSad: 0, eyeAngry: 1 }, 125);
  assert.deepEqual(transition.sample(125), { eyeSad: 0.5, eyeAngry: 0 });
  assert.deepEqual(transition.sample(250), { eyeSad: 0.25, eyeAngry: 0.5 });
  assert.deepEqual(transition.sample(375), { eyeSad: 0, eyeAngry: 1 });
  transition.start(current, { eyeSad: 0, eyeAngry: 1 }, 400);
  transition.cancel();
  assert.equal(transition.sample(600), null);
});
