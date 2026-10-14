import fc from 'fast-check';
import { ars, D, maxShares } from './money';

// Values with at most 2 decimals, as the API accepts them (centavos → pesos).
const pesos = (min: number, max: number) =>
  fc.integer({ min, max }).map((cents) => new D(cents).div(100));

describe('money', () => {
  it('is exact where floats are not', () => {
    expect(new D('0.1').plus('0.2').eq('0.3')).toBe(true);
    expect(ars(new D('1.005'))).toBe('1.01'); // (1.005).toFixed(2) === '1.00'
  });

  it('maxShares is the largest whole quantity the amount covers', () => {
    fc.assert(
      fc.property(pesos(0, 1e15), pesos(1, 1e10), (amount, price) => {
        const q = maxShares(amount, price);
        return (
          Number.isInteger(q) &&
          price.times(q).lte(amount) &&
          price.times(q + 1).gt(amount)
        );
      }),
    );
  });

  it('maxShares never rounds up on exact boundaries', () => {
    expect(maxShares(new D('1000'), new D('250'))).toBe(4);
    expect(maxShares(new D('999.99'), new D('250'))).toBe(3);
    expect(maxShares(new D('100'), new D('3'))).toBe(33);
  });
});
