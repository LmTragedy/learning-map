import assert from 'node:assert/strict';
import test from 'node:test';
import { backfillBridgeBatches } from '../src/bridgeBackfill.ts';

const course = (id, revision, gaps) => ({ id, revision, edges: Array(gaps).fill({ pending: true }) });
const countGaps = (value) => value.edges.filter((edge) => edge.pending).length;

test('bridge batches run sequentially with each returned revision until the gaps are filled', async () => {
  const sent = [];
  const progress = [];
  const applied = [];

  await backfillBridgeBatches({
    course: course('course-a', 2, 25),
    batchSize: 12,
    countGaps,
    backfill: async (id, revision) => {
      sent.push([id, revision]);
      const remaining = sent.length === 1 ? 13 : sent.length === 2 ? 1 : 0;
      return course(id, revision + 1, remaining);
    },
    isCurrent: () => true,
    onProgress: (batch) => progress.push(batch),
    onBatch: (updated) => applied.push(updated.revision),
  });

  assert.deepEqual(sent, [['course-a', 2], ['course-a', 3], ['course-a', 4]]);
  assert.deepEqual(progress.map(({ batch, total, remaining }) => [batch, total, remaining]), [[1, 3, 25], [2, 3, 13], [3, 3, 1]]);
  assert.deepEqual(applied, [3, 4, 5]);
});

test('bridge batches stop when a completed batch does not reduce gaps', async () => {
  let calls = 0;

  await assert.rejects(backfillBridgeBatches({
    course: course('course-a', 2, 4),
    batchSize: 12,
    countGaps,
    backfill: async () => { calls += 1; return course('course-a', 3, 4); },
    isCurrent: () => true,
    onProgress: () => {},
    onBatch: () => {},
  }), /没有减少待补充联系/);
  assert.equal(calls, 1);
});

test('bridge batches do not enqueue another request after the course session changes', async () => {
  let current = true;
  let calls = 0;
  let applied = 0;

  await backfillBridgeBatches({
    course: course('course-a', 2, 20),
    batchSize: 12,
    countGaps,
    backfill: async () => { calls += 1; current = false; return course('course-a', 3, 8); },
    isCurrent: () => current,
    onProgress: () => {},
    onBatch: () => { applied += 1; },
  });
  assert.equal(calls, 1);
  assert.equal(applied, 0);
});

test('a failed later batch keeps earlier progress and stops without retrying', async () => {
  const saved = [];
  const revisions = [];
  await assert.rejects(backfillBridgeBatches({
    course: course('course-a', 2, 25),
    batchSize: 12,
    countGaps,
    backfill: async (id, revision) => {
      revisions.push(revision);
      if (revision === 3) throw new Error('AI connection interrupted');
      return course(id, 3, 13);
    },
    isCurrent: () => true,
    onProgress: () => {},
    onBatch: (updated) => saved.push(updated),
  }), /AI connection interrupted/);
  assert.deepEqual(revisions, [2, 3]);
  assert.equal(saved.length, 1);
  assert.equal(countGaps(saved[0]), 13);
});
