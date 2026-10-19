import { describe, expect, test } from 'bun:test';
import { mergeTurns, renderLeadTab, type LeadTabModel, type TabTurn } from './leadView';
import { newTurn, type LeadHistoryTurn } from './lead';

const base: LeadTabModel = { project: 'agents', turns: [], busy: false, mic: 'idle', loading: false, now: 0 };
const turn = (over: Partial<TabTurn>): TabTurn => ({ key: 'k', ask: 'hi', segments: [], confirms: [], refs: [], live: false, ...over });

describe('renderLeadTab', () => {
  test('an empty tab says what the Lead can do and that changes wait for ✓', () => {
    expect(renderLeadTab(base)).toContain('Anything that changes something waits for your ✓.');
  });

  test('a live turn without words shows one quiet working line, never the commands it runs', () => {
    const html = renderLeadTab({ ...base, busy: true, turns: [turn({ live: true, phase: 'tool' })] });
    expect(html).toContain('Working…');
    expect(html).not.toContain('agents lead tool');
  });

  test('one held action has a single ✓ Confirm; several have their own ✓ and ✓ Confirm all', () => {
    const one = renderLeadTab({ ...base, turns: [turn({ confirms: [{ token: 'c_1', action: 'answer', label: 'Answer PHNX-4409', detail: 'Release the API first.', state: 'open' }] })] });
    expect(one).toContain('data-lead-confirm="c_1">✓ Confirm</button>');
    expect(one).not.toContain('class="one"');
    expect(one).toContain('Release the API first.');
    const three = renderLeadTab({ ...base, turns: [turn({ confirms: ['a', 'b', 'c'].map((x) => ({ token: `c_${x}`, action: 'send', label: x, state: x === 'a' ? 'done' : 'open' })) })] });
    expect(three).toContain('data-lead-confirm-all="c_b c_c">✓ Confirm all 2</button>');
    expect(three).toContain('Done: a');
    expect((three.match(/class="one"/g) ?? []).length).toBe(2);
  });

  test('a busy Lead disables the confirm buttons', () => {
    const html = renderLeadTab({ ...base, busy: true, turns: [turn({ confirms: [{ token: 'c_1', action: 'stop', label: 'Stop x', state: 'open' }] })] });
    expect(html).toContain('data-lead-confirm="c_1" disabled');
  });

  test('every string from the Lead goes in escaped', () => {
    const html = renderLeadTab({ ...base, project: '<p>', turns: [turn({ ask: '<b>x</b>', segments: [{ kind: 'text', text: '<img src=x>' }], confirms: [{ token: 'c_"1', action: 'send', label: '<em>', detail: '"&', state: 'open' }] })] });
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<em>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  test('the mic and busy state ride on the kept box’s attributes', () => {
    const html = renderLeadTab({ ...base, mic: 'listening', busy: true });
    expect(html).toContain('<div class="lead-ask" data-keep data-mic="listening" data-busy="true">');
  });
});

describe('mergeTurns', () => {
  test('history first, then live turns it does not hold; a turn a Confirm started draws nothing of its own', () => {
    const history: LeadHistoryTurn[] = [{ turn: 't_0', ask: 'old', text: 'Old answer.', summary: 'Old answer.', refs: [], tools: [] }];
    const asked = newTurn('new', 1);
    const confirmed = { ...newTurn('', 2), text: 'Stopped it.', finished: true };
    const again = { ...newTurn('old', 3), turn: 't_0' };
    expect(mergeTurns(history, [again, asked, confirmed]).map((t) => t.ask)).toEqual(['old', 'new']);
  });

  test('a Confirm turn that failed, or that holds another action, still draws', () => {
    const failed = { ...newTurn('', 1), error: 'confirm token c_1 expired', finished: true };
    const holding = newTurn('', 2);
    holding.confirms.push({ token: 'c_2', action: 'send', label: 'Message “x”', state: 'open' });
    const turns = mergeTurns([], [failed, holding]);
    expect(turns.map((t) => [t.error ?? '', t.confirms.length])).toEqual([['confirm token c_1 expired', 0], ['', 1]]);
  });
});
