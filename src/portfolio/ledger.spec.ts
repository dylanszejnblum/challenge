import { D } from '../common/money';
import { computeHoldings, LedgerOrder } from './ledger';

const o = (
  side: LedgerOrder['side'],
  size: number,
  price: string | number = 1,
  status: LedgerOrder['status'] = 'FILLED',
  instrumentid = 1,
): LedgerOrder => ({ side, size, price: new D(price), status, instrumentid });

describe('computeHoldings', () => {
  it('replays cash movements, buys and sells', () => {
    const h = computeHoldings([
      o('CASH_IN', 10_000, 1, 'FILLED', 66),
      o('BUY', 10, '100.50'),
      o('SELL', 4, '120'),
      o('CASH_OUT', 1_000, 1, 'FILLED', 66),
    ]);
    // 10000 - 1005 + 480 - 1000
    expect(h.cash.toFixed(2)).toBe('8475.00');
    expect(h.positions.get(1)).toMatchObject({ quantity: 6 });
    expect(h.positions.get(1)!.costBasis.toFixed(2)).toBe('603.00');
  });

  it('uses average cost, which only changes on buys', () => {
    // A naive SUM(cost) / SUM(qty) would say 150; the shares held cost 200.
    const h = computeHoldings([
      o('BUY', 10, 100),
      o('SELL', 10, 110),
      o('BUY', 10, 200),
    ]);
    const p = h.positions.get(1)!;
    expect(p.costBasis.div(p.quantity).toFixed(2)).toBe('200.00');
  });

  it('reserves cash and shares for NEW orders and ignores the rest', () => {
    const h = computeHoldings([
      o('CASH_IN', 1_000),
      o('BUY', 5, 10),
      o('BUY', 2, 100, 'NEW'),
      o('SELL', 3, 50, 'NEW'),
      o('BUY', 99, 1, 'REJECTED'),
      o('BUY', 99, 1, 'CANCELLED'),
    ]);
    expect(h.cash.toFixed(2)).toBe('950.00');
    expect(h.reservedCash.toFixed(2)).toBe('200.00');
    expect(h.positions.get(1)).toMatchObject({
      quantity: 5,
      reservedQuantity: 3,
    });
  });
});
