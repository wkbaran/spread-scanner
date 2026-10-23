import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, earningsVerdict, splitReportDates } from '../src/earnings.ts';
import { config } from './fixtures.ts';

const today = '2026-10-23';

test('days between dates, across a month end and a daylight saving change', () => {
  assert.equal(daysBetween('2026-10-23', '2026-12-04'), 42);
  assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2);
  assert.equal(daysBetween('2026-11-05', '2026-11-05'), 0);
});

test('dates split around today, and the next report is the earliest future one', () => {
  const dates = ['2026-10-20', '2026-07-24', '2026-11-06', '2026-11-04'];
  assert.deepEqual(splitReportDates(dates, today), { last: '2026-10-20', next: '2026-11-04' });
  assert.deepEqual(splitReportDates(['2026-10-23'], today), { last: null, next: '2026-10-23' }, 'a report today is still to come');
  assert.deepEqual(splitReportDates([], today), { last: null, next: null });
});

test('eligible when the last report is far enough back and the next far enough ahead', () => {
  const v = earningsVerdict(['2026-10-12', '2026-12-10'], today, config());
  assert.equal(v.ok, true);
  assert.equal(v.daysSinceLast, 11);
  assert.equal(v.daysUntilNext, 48);
});

test('the boundaries: 4 days back is fine, 3 is not; 37 days ahead is fine, 36 is not', () => {
  const cfg = config();
  assert.equal(earningsVerdict(['2026-10-19', '2026-12-31'], today, cfg).ok, true);
  assert.match(earningsVerdict(['2026-10-20', '2026-12-31'], today, cfg).reason, /reported 3 days ago/);
  assert.equal(earningsVerdict(['2026-10-01', '2026-11-29'], today, cfg).ok, true);
  assert.match(earningsVerdict(['2026-10-01', '2026-11-28'], today, cfg).reason, /reports in 36 days/);
});

test('an unknown date fails closed', () => {
  assert.match(earningsVerdict(['2026-10-01'], today, config()).reason, /no upcoming/);
  assert.match(earningsVerdict(['2026-12-31'], today, config()).reason, /no past/);
  assert.equal(earningsVerdict([], today, config()).ok, false);
});

test('two sources that disagree: the nearer next date decides', () => {
  const v = earningsVerdict(['2026-10-01', '2026-11-24', '2026-12-01'], today, config());
  assert.equal(v.next, '2026-11-24');
  assert.equal(v.ok, false);
});
